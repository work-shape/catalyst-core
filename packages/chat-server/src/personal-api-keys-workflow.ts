import {
  AppError,
  CONNECT_CODE_POLL_INTERVAL_MS,
  CONNECT_CODE_TTL_MS,
  asApiCredentialId,
  asUserId,
  auditActorFromIdentity,
  createConnectCodePair,
  getSubjectUserId,
  hashConnectCode,
  isAuthenticatedServicePrincipal,
  normalizeUserCode,
  requirePersonalApiKeyExpiry,
  requirePersonalApiKeyScopes,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ConnectCodeRecord,
  type CreatedPersonalApiKey,
  type OperationAuthorization,
  type OperationExecutionContext,
  type PersonalApiKeyRecord,
  type RuntimeCallContext,
  type StorePage
} from "@vivd-catalyst/core";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

/** Where the interface confirms a connect code; the CLI prints it after the instance address. */
const CONNECT_CODE_CONFIRM_PATH = "/settings/you/api-keys";
/** Tries for a free code before the start gives up. Two codes alike in 15 minutes are rare. */
const CONNECT_CODE_START_ATTEMPTS = 3;

/** What a key is issued with, from Settings or by confirming a connect code. */
export interface PersonalApiKeyFields {
  name: string;
  scopes: string[];
  expiresAt: string;
}

/** What a changing operation of this file takes from its Operation Run. */
type ChangeContext = Pick<
  OperationExecutionContext,
  "actor" | "access" | "audit" | "correlationId"
>;

/**
 * Who may issue, confirm or revoke their own keys: a person signed in themself. A call made
 * with a personal key never passes, so no key issues a key or confirms a code. Its scopes carry
 * no `me:write` either; this says the same where the scope is not asked.
 */
export function authorizeOwnKeyChange(
  operationId: string
): (input: unknown, context: { actor: AuthenticatedIdentity }) => OperationAuthorization {
  return (_input, { actor }) =>
    isAuthenticatedServicePrincipal(actor) || actor.delegatedActor !== undefined
      ? {
          allowed: false,
          action: operationId,
          reason: "no_grant",
          message: "Only a person signed in themself manages their personal API keys"
        }
      : { allowed: true };
}

/**
 * Personal API keys: a person's own keys and connect codes, and the instance's list of every
 * person's keys. Each key acts as its owner with the owner's rights at the time of each call,
 * narrowed to its scopes; see `createActorAccess`.
 */
export class PersonalApiKeysWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  listOwnKeys(user: AuthenticatedUser, page: StorePage | undefined) {
    return this.options.stores.personalApiKeys.listPersonalApiKeys({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: asUserId(getSubjectUserId(user)),
      page
    });
  }

  /** Answers the key once. The operation is `secret`: its run keeps nothing of the answer. */
  async createOwnKey(
    context: ChangeContext,
    fields: PersonalApiKeyFields
  ): Promise<CreatedPersonalApiKey> {
    const checked = this.requireIssuable(context.access, fields);
    const created = await this.options.stores.personalApiKeys.createPersonalApiKey({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: asUserId(context.actor.id),
      ...checked
    });
    await this.recordKeyChange(context, "api_access.personal_key_created", created.key);
    return created;
  }

  async revokeOwnKey(context: ChangeContext, keyId: string): Promise<PersonalApiKeyRecord> {
    return this.revoke(context, keyId, asUserId(context.actor.id));
  }

  /** Every person's keys, for whoever administers API access. A read of others' credentials. */
  async listEveryKey(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    page: StorePage | undefined
  ): Promise<PersonalApiKeyRecord[]> {
    await recordGovernanceAccess({
      options: this.options,
      user,
      context,
      auditType: "api_access.personal_keys_viewed"
    });
    return this.options.stores.personalApiKeys.listPersonalApiKeys({
      clientInstanceId: this.options.clientInstanceId,
      page
    });
  }

  async revokeAnyKey(context: ChangeContext, keyId: string): Promise<PersonalApiKeyRecord> {
    return this.revoke(context, keyId, undefined);
  }

  /**
   * A new connect code. Nobody is signed in: the code alone grants nothing until a person
   * confirms it, and only the CLI that holds the device code collects the key.
   */
  async startConnectCode(clientLabel: string | undefined) {
    const expiresAt = new Date(Date.now() + CONNECT_CODE_TTL_MS).toISOString();
    for (let attempt = 1; ; attempt += 1) {
      const pair = createConnectCodePair();
      try {
        await this.options.stores.personalApiKeys.startConnectCode({
          clientInstanceId: this.options.clientInstanceId,
          userCodeHash: await this.userCodeHash(pair.userCode),
          deviceCodeHash: await hashConnectCode(pair.deviceCode),
          ...(clientLabel === undefined ? {} : { clientLabel }),
          expiresAt
        });
      } catch (error) {
        if (isTakenCode(error) && attempt < CONNECT_CODE_START_ATTEMPTS) continue;
        throw error;
      }
      return {
        ...pair,
        expiresAt,
        intervalSeconds: CONNECT_CODE_POLL_INTERVAL_MS / 1000,
        confirmPath: `${CONNECT_CODE_CONFIRM_PATH}?code=${encodeURIComponent(pair.userCode)}`
      };
    }
  }

  /** The code a person typed, for the confirmation screen. One that is not open reads 404. */
  async getConnectCode(userCode: string): Promise<ConnectCodeRecord> {
    const code = await this.options.stores.personalApiKeys.findConnectCode({
      clientInstanceId: this.options.clientInstanceId,
      userCodeHash: await this.userCodeHash(userCode)
    });
    if (!code || code.approvedAt !== undefined) throw connectCodeNotFound();
    return code;
  }

  async confirmConnectCode(
    context: ChangeContext,
    userCode: string,
    fields: PersonalApiKeyFields
  ): Promise<{ confirmed: true }> {
    // An unknown code is told first: nothing about the scopes matters for it.
    await this.getConnectCode(userCode);
    const checked = this.requireIssuable(context.access, fields);
    const code = await this.options.stores.personalApiKeys.approveConnectCode({
      clientInstanceId: this.options.clientInstanceId,
      userCodeHash: await this.userCodeHash(userCode),
      ownerUserId: asUserId(context.actor.id),
      name: checked.name,
      scopes: checked.scopes,
      keyExpiresAt: checked.expiresAt
    });
    if (!code) throw connectCodeNotFound();
    await context.audit.record({
      type: "api_access.connect_code_confirmed",
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: code.id,
      metadata: {
        name: checked.name,
        scopes: checked.scopes,
        expiresAt: checked.expiresAt,
        ...(code.clientLabel === undefined ? {} : { clientLabel: code.clientLabel })
      }
    });
    return { confirmed: true };
  }

  /**
   * The key of a confirmed code, once. A code that is unknown, expired, collected or of another
   * instance reads `NOT_FOUND` alike. The key is recorded under its owner, who confirmed it.
   */
  async redeemConnectCode(deviceCode: string, correlationId: string) {
    const redemption = await this.options.stores.personalApiKeys.redeemConnectCode({
      clientInstanceId: this.options.clientInstanceId,
      deviceCodeHash: await hashConnectCode(deviceCode)
    });
    if (redemption.status === "invalid") throw connectCodeNotFound();
    if (redemption.status === "pending") return { status: "pending" as const };
    const { key, secret } = redemption.created;
    const owner = await this.options.stores.users.getUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: key.ownerUserId
    });
    await this.options.auditRecorder.record({
      type: "api_access.personal_key_created",
      status: "success",
      // The owner confirmed the code, and the key's first act is its own collection.
      actor: {
        userId: key.ownerUserId,
        subjectUserId: key.ownerUserId,
        displayLabel: owner?.displayLabel ?? key.ownerUserId,
        roles: owner?.roles ?? [],
        principalKind: "user",
        credentialId: key.id
      },
      correlationId,
      subject: key.id,
      metadata: keyMetadata(key)
    });
    return { status: "issued" as const, key, secret };
  }

  private async revoke(
    context: ChangeContext,
    keyId: string,
    ownerUserId: ReturnType<typeof asUserId> | undefined
  ): Promise<PersonalApiKeyRecord> {
    const key = await this.options.stores.personalApiKeys.revokePersonalApiKey({
      clientInstanceId: this.options.clientInstanceId,
      keyId: asApiCredentialId(keyId),
      ...(ownerUserId === undefined ? {} : { ownerUserId })
    });
    if (!key) throw new AppError("NOT_FOUND", "Personal API key is not available");
    await this.recordKeyChange(context, "api_access.personal_key_revoked", key);
    return key;
  }

  /**
   * The fields of a key the caller may issue: valid scopes, each naming a right the caller
   * holds now somewhere it reaches, and an expiry within a year. A scope the caller holds
   * nowhere would issue a key that can do nothing; it is refused with the right it names.
   */
  private requireIssuable(access: ActorAccess, fields: PersonalApiKeyFields): PersonalApiKeyFields {
    const scopes = requirePersonalApiKeyScopes(fields.scopes);
    requirePersonalApiKeyExpiry(fields.expiresAt);
    for (const scope of scopes) {
      const held =
        scope.namespace === undefined
          ? access.authorize(scope.action).allowed ||
            access.holdsGrantAt(scope.action, ["namespace", "asset", "workspace"])
          : access.authorize(scope.action, { name: scope.namespace }).allowed;
      if (!held) {
        throw new AppError(
          "VALIDATION_FAILED",
          `You hold no right '${scope.action}'${scope.namespace === undefined ? "" : ` in the Namespace '${scope.namespace}'`}, so a key cannot carry it`,
          {
            action: scope.action,
            ...(scope.namespace === undefined ? {} : { namespace: scope.namespace })
          }
        );
      }
    }
    return { name: fields.name, scopes: [...new Set(fields.scopes)], expiresAt: fields.expiresAt };
  }

  private async userCodeHash(userCode: string): Promise<string> {
    const normalized = normalizeUserCode(userCode);
    if (normalized === undefined) throw connectCodeNotFound();
    return hashConnectCode(normalized);
  }

  private async recordKeyChange(
    context: ChangeContext,
    type: string,
    key: PersonalApiKeyRecord
  ): Promise<void> {
    await context.audit.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(context.actor),
      correlationId: context.correlationId,
      subject: key.id,
      metadata: keyMetadata(key)
    });
  }
}

/** What audit keeps of a key: who owns it, what it covers and until when. Never the key. */
function keyMetadata(key: PersonalApiKeyRecord) {
  return {
    ownerUserId: key.ownerUserId,
    credentialId: key.id,
    keyPrefix: key.keyPrefix,
    name: key.name,
    scopes: key.scopes,
    expiresAt: key.expiresAt
  };
}

function connectCodeNotFound(): AppError {
  return new AppError(
    "NOT_FOUND",
    "This connect code is unknown, expired or already used. Start a new one with 'catalyst login'"
  );
}

function isTakenCode(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "CONFLICT" &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details &&
    error.details.reason === "code_taken"
  );
}
