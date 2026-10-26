import { TWO_FACTOR_SETUP_REQUIRED_REASON } from "@work-shape/catalyst-api-contract";
import { STANDALONE_AUTH_SOURCE } from "@work-shape/catalyst-auth";
import {
  AppError,
  asUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type TwoFactorState
} from "@work-shape/catalyst-core";
import type { ResolvedChatServerOptions } from "../types";

type TwoFactorGateOptions = Pick<
  ResolvedChatServerOptions,
  "clientInstanceId" | "config" | "stores" | "standaloneAuth"
>;

/** The one operation a person without a required second factor still reaches: their own record. */
const OPEN_WITHOUT_SECOND_FACTOR = "me.get";

/** Whether the instance requires two-factor sign-in of every account with a password. */
function twoFactorRequired(options: Pick<ResolvedChatServerOptions, "config">): boolean {
  const standalone = options.config.auth.standalone;
  return standalone?.enabled === true && standalone.twoFactor?.required === true;
}

/**
 * The person as the account answers show them: for one signed in with a password, whether a
 * second factor is required and whether it is set up. Left out for every other way in.
 */
export function withTwoFactorState<T extends { twoFactor?: TwoFactorState }>(
  options: Pick<ResolvedChatServerOptions, "config">,
  person: T
): Omit<T, "twoFactor"> & { twoFactor?: { required: boolean; enrolled: boolean } } {
  const { twoFactor, ...rest } = person;
  return twoFactor === undefined
    ? rest
    : {
        ...rest,
        twoFactor: { required: twoFactorRequired(options), enrolled: twoFactor === "enrolled" }
      };
}

/**
 * TWO-FACTOR-1. On an instance that requires two-factor sign-in, a person signed in with a
 * password who has not set it up reaches `me.get` and nothing else. Sessions extend on activity,
 * so this sits on every request, not on sign-in. A personal key of such an owner is refused as
 * well, so a key issued before the setting does not pass by it; a service principal's is not.
 */
export async function requireSecondFactor(
  options: TwoFactorGateOptions,
  operationId: string,
  identity: AuthenticatedIdentity
): Promise<void> {
  if (!twoFactorRequired(options) || isAuthenticatedServicePrincipal(identity)) {
    return;
  }
  if (identity.twoFactor === "missing") {
    if (operationId === OPEN_WITHOUT_SECOND_FACTOR) {
      return;
    }
    throw twoFactorSetupRequired();
  }
  if (
    identity.delegatedActor?.kind === "api_key" &&
    !(await keyOwnerHasFactor(options, identity.id))
  ) {
    throw twoFactorSetupRequired();
  }
}

/** True for an owner without a password sign-in: the factor is the identity provider's there. */
async function keyOwnerHasFactor(options: TwoFactorGateOptions, userId: string): Promise<boolean> {
  const owner = await options.stores.users.getUser({
    clientInstanceId: options.clientInstanceId,
    userId: asUserId(userId)
  });
  const signIn = owner?.identities.find(
    (identity) => identity.authSource === STANDALONE_AUTH_SOURCE
  );
  if (!signIn) {
    return true;
  }
  if (!options.standaloneAuth) {
    return false;
  }
  const enrolled = await options.standaloneAuth.twoFactorEnrolled([signIn.externalUserId]);
  return enrolled.has(signIn.externalUserId);
}

function twoFactorSetupRequired(): AppError {
  return new AppError(
    "FORBIDDEN",
    "This instance requires two-factor sign-in. Set it up before you continue.",
    { reason: TWO_FACTOR_SETUP_REQUIRED_REASON }
  );
}
