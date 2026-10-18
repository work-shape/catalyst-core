import {
  hasAuthScope,
  isAuthenticatedServicePrincipal,
  isSuperadmin,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { PlatformContextRead } from "@work-shape/catalyst-tool-execution";

// Bounds directory results before identities and rights are loaded. More matches ask for a
// narrower name/email; there is no instance directory dump in an agent's context.
const PERSON_MATCHES_MAX = 20;

/** The same account/directory visibility as Settings, with only addressing fields returned. */
export async function workflowAuthoringContext(
  options: { clientInstanceId: ClientInstanceId; stores: PlatformStores },
  call: { actor: AuthenticatedIdentity; access: ActorAccess },
  input: { person?: string } = {},
  workflowsEnabled = true
): Promise<
  Pick<PlatformContextRead, "caller" | "workflowPrincipals" | "people" | "peopleTruncated">
> {
  const { actor, access } = call;
  if (isAuthenticatedServicePrincipal(actor)) return {};
  const caller = {
    id: actor.id,
    displayLabel: actor.displayLabel,
    ...(actor.email === undefined ? {} : { email: actor.email })
  };
  const canListAccounts =
    workflowsEnabled &&
    hasAuthScope(actor, "api_access:read") &&
    access.authorize("service_principals.manage").allowed;
  const principals = canListAccounts
    ? await options.stores.apiAccess.listServicePrincipals({
        clientInstanceId: options.clientInstanceId
      })
    : [];
  const query = input.person?.trim();
  const canListPeople =
    query && hasAuthScope(actor, "user_admin:read") && access.authorize("users.manage").allowed;
  const matches = canListPeople
    ? await options.stores.users.listUsers({
        clientInstanceId: options.clientInstanceId,
        text: query,
        activeOnly: true,
        excludeSuperadmins: !isSuperadmin(actor),
        page: { limit: PERSON_MATCHES_MAX + 1 }
      })
    : query &&
        [caller.displayLabel, caller.email ?? ""].some((value) =>
          value.toLowerCase().includes(query.toLowerCase())
        )
      ? [caller]
      : [];
  return {
    caller,
    workflowPrincipals: principals
      .filter((principal) => principal.status === "active" && !principal.owner)
      .map(({ name, displayLabel }) => ({ name, displayLabel })),
    people: matches.slice(0, PERSON_MATCHES_MAX).map(({ id, displayLabel, email }) => ({
      id,
      displayLabel,
      ...(email === undefined ? {} : { email })
    })),
    peopleTruncated: matches.length > PERSON_MATCHES_MAX
  };
}
