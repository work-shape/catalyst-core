import type { Operation } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PERSONAL_API_KEY_ACCOUNT_ACTION,
  PERSONAL_API_KEY_ROW_USE_OPERATIONS,
  PERSONAL_API_KEY_WORKSPACES_ACTION,
  PERSONAL_API_KEY_WORKFLOW_USE_ACTION,
  hasAuthScope,
  isAuthenticatedServicePrincipal,
  personalApiKeyLacksAction,
  personalApiKeyRowUseNeeds,
  type AuthenticatedIdentity
} from "@work-shape/catalyst-core";

/** The credential scope dispatch checks, including an operation's personal-key scope. */
export function operationScope(identity: AuthenticatedIdentity, operation: Operation) {
  return !isAuthenticatedServicePrincipal(identity) && identity.keyScopes !== undefined
    ? (operation.personalKeyScope ?? operation.scope)
    : operation.scope;
}

function isRowUseOperation(id: string): id is keyof typeof PERSONAL_API_KEY_ROW_USE_OPERATIONS {
  return Object.hasOwn(PERSONAL_API_KEY_ROW_USE_OPERATIONS, id);
}

/** The action a key must name to reach an operation through its use-level scope, if it has one. */
function useLevelNeed(operation: Operation): string | undefined {
  if (operation.personalKeyScope === "instance:inspect") return operation.requires?.[0];
  if (operation.personalKeyScope === "account:manage") return PERSONAL_API_KEY_ACCOUNT_ACTION;
  if (operation.personalKeyScope === "workspaces:manage") return PERSONAL_API_KEY_WORKSPACES_ACTION;
  if (operation.personalKeyScope === "workflow_runs:use") {
    return PERSONAL_API_KEY_WORKFLOW_USE_ACTION;
  }
  if (operation.personalKeyScope === "data_store_rows:use" && isRowUseOperation(operation.id)) {
    return personalApiKeyRowUseNeeds(operation.id)[0];
  }
  return undefined;
}

/**
 * The refusal of a personal key whose workspaces level (CLI-PARITY-5) does not reach the
 * workspace a call names. A key may limit `collaboration_workspace.manage` to one workspace:
 * such a key reaches the operations on that workspace only, and an operation that names no
 * workspace, such as creating one or listing the person's workspaces, needs the action
 * without a limit. Asked after the scope, so the key carries the level here.
 */
export function throwUnlessKeyReachesWorkspace(
  identity: AuthenticatedIdentity,
  operation: Operation,
  params: Readonly<Record<string, string>>
): void {
  if (operation.personalKeyScope !== "workspaces:manage") return;
  const workspaceId = params["collaborationWorkspaceId"];
  if (
    !personalApiKeyLacksAction(
      identity,
      PERSONAL_API_KEY_WORKSPACES_ACTION,
      workspaceId === undefined ? undefined : { workspaceId }
    )
  ) {
    return;
  }
  throw new AppError(
    "FORBIDDEN",
    workspaceId === undefined
      ? `The API key of this call names '${PERSONAL_API_KEY_WORKSPACES_ACTION}' only for one workspace, and '${operation.id}' names none. Use a key whose scope '${PERSONAL_API_KEY_WORKSPACES_ACTION}' is not limited to a workspace`
      : `The API key of this call names '${PERSONAL_API_KEY_WORKSPACES_ACTION}' for another workspace than '${workspaceId}'`,
    { action: PERSONAL_API_KEY_WORKSPACES_ACTION, reason: "outside_key_scope" }
  );
}

/**
 * The refusal of a personal key that lacks the use level (CLI-PARITY-4), the read-only
 * instance level (CLI-PARITY-6a) or the account and workspaces level (CLI-PARITY-5) for one of
 * the operations it reaches through it. It names the
 * right the key must carry, so the person knows what to add, in the form of the refusal of a
 * Workflow's publish.
 */
export function throwUnlessKeyCarriesUseLevel(
  identity: AuthenticatedIdentity,
  operation: Operation
): void {
  const needed = useLevelNeed(operation);
  const scope = operation.personalKeyScope;
  if (
    isAuthenticatedServicePrincipal(identity) ||
    identity.keyScopes === undefined ||
    needed === undefined ||
    scope === undefined ||
    hasAuthScope(identity, scope)
  ) {
    return;
  }
  const [level, pick] =
    scope === "instance:inspect"
      ? [
          "instance level",
          "the instance level, which reads usage, audit events, jobs, Operation Runs, Modules and infrastructure"
        ]
      : scope === "account:manage" || scope === "workspaces:manage"
        ? [
            "account and workspaces level",
            "the account and workspaces level, ticked in Settings > API keys"
          ]
        : ["use level", "the use level (Verwenden)"];
  throw new AppError(
    "FORBIDDEN",
    `The API key of this call does not carry the ${level}, which '${operation.id}' needs: its scopes must name '${needed}'. Use a key with ${pick}`,
    { action: needed, reason: "outside_key_scope" }
  );
}
