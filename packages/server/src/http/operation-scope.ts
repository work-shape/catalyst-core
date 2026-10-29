import type { Operation } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PERSONAL_API_KEY_ROW_USE_OPERATIONS,
  PERSONAL_API_KEY_WORKFLOW_USE_ACTION,
  hasAuthScope,
  isAuthenticatedServicePrincipal,
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
  if (operation.personalKeyScope === "workflow_runs:use") {
    return PERSONAL_API_KEY_WORKFLOW_USE_ACTION;
  }
  if (operation.personalKeyScope === "data_store_rows:use" && isRowUseOperation(operation.id)) {
    return personalApiKeyRowUseNeeds(operation.id)[0];
  }
  return undefined;
}

/**
 * The refusal of a personal key that lacks the use level (CLI-PARITY-4) or the read-only
 * instance level (CLI-PARITY-6a) for one of the operations it reaches through it. It names the
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
      : ["use level", "the use level (Verwenden)"];
  throw new AppError(
    "FORBIDDEN",
    `The API key of this call does not carry the ${level}, which '${operation.id}' needs: its scopes must name '${needed}'. Use a key with ${pick}`,
    { action: needed, reason: "outside_key_scope" }
  );
}
