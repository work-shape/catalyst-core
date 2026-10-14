import { operationDenialError, type OperationDenial } from "./operation-denial";
import type { OperationAuthorization } from "./operation-registry";
import { isPlatformAction, type AccessResource, type ActorAccess } from "./permissions";

/**
 * One right as a holder holds it: an action on one resource, or without a resource on the whole
 * instance, as a legacy key is held.
 */
export interface HeldRight {
  action: string;
  resource?: AccessResource;
}

/** Whom a right is given or lent to, or whose account is changed, as a refusal names them. */
export interface RightRecipient {
  label: string;
}

/**
 * What the call does with the rights it is asked: lends them to a service principal, which
 * acts with them; gives them to a person, who holds them from then on; or changes the account
 * of a person who holds them, which hands the account's rights to whoever changes it.
 */
export type RightsTransfer =
  { lends: RightRecipient } | { gives: RightRecipient } | { changes: RightRecipient };

/**
 * The rule of no escalation: a person may give or lend a right only where the call they make
 * holds it. "Holds" is the call's own `authorize`, so roles, rows, denies, memberships and the
 * scopes of a personal key all count, and a call with a narrow key lends only what the key
 * covers. Asked by every act that gives or lends: making a Workflow revision live that runs as
 * a service principal; giving, enabling or issuing a key to one; giving a person a row, a role
 * or a legacy key; and changing a person's account, which asks every right the person holds.
 * Taking a right away asks nothing of it.
 *
 * The refusal names the first right the call does not hold, with the call's own reason. It
 * names the asset only to a caller who may read it: the refusal tells what the recipient holds,
 * and that is not told to whoever may not see the asset.
 */
export function authorizeHeldRights(
  access: ActorAccess,
  rights: readonly HeldRight[],
  transfer: RightsTransfer
): OperationAuthorization {
  const refusal = firstUnheldRight(access, rights, transfer);
  return refusal === undefined ? { allowed: true } : { allowed: false, ...refusal };
}

/** `authorizeHeldRights` for a caller that refuses by throwing: `FORBIDDEN`. */
export function requireHeldRights(
  access: ActorAccess,
  rights: readonly HeldRight[],
  transfer: RightsTransfer
): void {
  const refusal = firstUnheldRight(access, rights, transfer);
  if (refusal !== undefined) {
    throw operationDenialError({ kind: "forbidden", ...refusal });
  }
}

type Refusal = Omit<Extract<OperationDenial, { kind: "forbidden" }>, "kind">;

function firstUnheldRight(
  access: ActorAccess,
  rights: readonly HeldRight[],
  transfer: RightsTransfer
): Refusal | undefined {
  for (const right of rights) {
    const decision = access.authorize(right.action, right.resource);
    if (decision.allowed) continue;
    const on = resourcePhrase(access, right.resource);
    const missing =
      decision.reason === "outside_key_scope"
        ? `The API key of this call does not cover '${right.action}'${on}`
        : decision.reason === "denied"
          ? `'${right.action}'${on} is denied to this call`
          : `This call does not hold '${right.action}'${on}`;
    const hint = decision.reason === "outside_key_scope" ? ": use a key whose scopes name it" : "";
    return {
      action: right.action,
      reason: decision.reason,
      message: `${missing}, and ${transferClause(transfer)}${hint}`
    };
  }
  return undefined;
}

function transferClause(transfer: RightsTransfer): string {
  if ("lends" in transfer) {
    return `'${transfer.lends.label}' would act with it. Only a holder of a right gives or lends it`;
  }
  if ("gives" in transfer) {
    return `'${transfer.gives.label}' would hold it. Only a holder of a right gives or lends it`;
  }
  return `'${transfer.changes.label}' holds it. Only a holder of every right of an account changes the account`;
}

/**
 * Where the right is held, as far as the caller may know: the asset by kind and name where the
 * caller may read it, and only that there is one where not; a workspace by its id and a
 * Namespace by its prefix, which the caller named or the grant list shows them. Every kind's
 * read right is `<kind>.read`; a kind without one in the vocabulary is read by nobody here.
 */
function resourcePhrase(access: ActorAccess, resource: AccessResource | undefined): string {
  if (resource === undefined) return " on the whole instance";
  if (resource.kind === undefined && resource.assetId === undefined) {
    if (resource.workspaceId !== undefined) return ` in the workspace '${resource.workspaceId}'`;
    if (resource.name !== undefined) return ` in the Namespace '${resource.name}'`;
  }
  const readAction = resource.kind === undefined ? undefined : `${resource.kind}.read`;
  const readable =
    readAction !== undefined &&
    isPlatformAction(readAction) &&
    resource.name !== undefined &&
    access.authorize(readAction, resource).allowed;
  return readable
    ? ` on the ${resource.kind} '${resource.name}'`
    : " on an asset this call may not read";
}
