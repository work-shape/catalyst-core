import type { Operation } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  PERSONAL_API_KEY_ROW_USE_OPERATIONS,
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

/**
 * The refusal of a personal key that lacks the use level for one of the row operations it
 * reaches through it (CLI-PARITY-4). It names the rights the key must carry, so the person
 * knows what to add, in the form of the refusal of a Workflow's publish.
 */
export function throwUnlessKeyCarriesUseLevel(
  identity: AuthenticatedIdentity,
  operation: Operation
): void {
  if (
    isAuthenticatedServicePrincipal(identity) ||
    identity.keyScopes === undefined ||
    operation.personalKeyScope !== "data_store_rows:use" ||
    hasAuthScope(identity, "data_store_rows:use") ||
    !isRowUseOperation(operation.id)
  ) {
    return;
  }
  const [first, ...others] = personalApiKeyRowUseNeeds(operation.id);
  const named =
    others.length === 0
      ? `'${first}'`
      : `'${first}' and one of ${others.map((action) => `'${action}'`).join(", ")}`;
  throw new AppError(
    "FORBIDDEN",
    `The API key of this call does not carry the use level, which '${operation.id}' needs: its scopes must name ${named}. Use a key with the use level (Verwenden)`,
    { action: first, reason: "outside_key_scope" }
  );
}
