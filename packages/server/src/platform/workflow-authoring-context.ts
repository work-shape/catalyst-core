import {
  hasAuthScope,
  GRANT_SCOPE_KINDS,
  isAuthenticatedServicePrincipal,
  isSuperadmin,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { authorizeHeldRightsWithin } from "../access/held-rights-within";
import { principalRights, RELEASE_KEY } from "../access/principal-rights";
import type { PlatformContextRead } from "@work-shape/catalyst-tool-execution";

// Bounds directory results before identities and rights are loaded. More matches ask for a
// narrower name/email; there is no instance directory dump in an agent's context.
const PERSON_MATCHES_MAX = 20;

/**
 * Workflow builders discover shared run-account names, never keys or grants. Testing remains
 * bounded by both identities, and publishing still checks no-escalation. Person lookup keeps
 * Settings' directory rights. Neither requires a person to supply an internal id.
 */
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
    hasAuthScope(actor, "config_assets:write") &&
    (access.authorize(WORKFLOW_ACTIONS.write, { kind: WORKFLOW_ASSET_KIND }).allowed ||
      access.holdsGrantAt(
        WORKFLOW_ACTIONS.write,
        GRANT_SCOPE_KINDS.filter((scope) => scope !== "instance")
      ));
  const principals = canListAccounts
    ? await options.stores.apiAccess.listServicePrincipals({
        clientInstanceId: options.clientInstanceId
      })
    : [];
  const workflowPrincipals: NonNullable<PlatformContextRead["workflowPrincipals"]> = [];
  for (const principal of principals) {
    if (principal.status !== "active" || principal.owner) continue;
    // Accounts with API keys are integrations, not shared Workflow run accounts. Keep even
    // revoked keys out: revoking an integration's key does not repurpose its account.
    const credentials = await options.stores.apiAccess.listApiCredentials({
      clientInstanceId: options.clientInstanceId,
      servicePrincipalId: principal.id
    });
    if (credentials.length > 0) continue;
    const rights = await principalRights(
      { clientInstanceId: options.clientInstanceId, access: options.stores.access },
      principal.id
    );
    if (rights.some((right) => right.action === RELEASE_KEY)) continue;
    const decision = await authorizeHeldRightsWithin(
      { clientInstanceId: options.clientInstanceId, access: options.stores.access },
      access,
      rights,
      { lends: { label: principal.displayLabel } }
    );
    if (decision.allowed)
      workflowPrincipals.push({ name: principal.name, displayLabel: principal.displayLabel });
  }
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
    workflowPrincipals,
    people: matches.slice(0, PERSON_MATCHES_MAX).map(({ id, displayLabel, email }) => ({
      id,
      displayLabel,
      ...(email === undefined ? {} : { email })
    })),
    peopleTruncated: matches.length > PERSON_MATCHES_MAX
  };
}
