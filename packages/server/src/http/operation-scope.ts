import type { Operation } from "@work-shape/catalyst-api-contract";
import {
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity
} from "@work-shape/catalyst-core";

/** The credential scope dispatch checks, including an operation's personal-key scope. */
export function operationScope(identity: AuthenticatedIdentity, operation: Operation) {
  return !isAuthenticatedServicePrincipal(identity) && identity.keyScopes !== undefined
    ? (operation.personalKeyScope ?? operation.scope)
    : operation.scope;
}
