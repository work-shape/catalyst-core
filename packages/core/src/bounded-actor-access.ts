import type { ActorAccess } from "./permissions";
import { operationDenialError } from "./operation-denial";

/**
 * The rights of a call in a test run of a Workflow draft (ADR-0031): the person testing,
 * bounded by the service principal the Workflow runs as. An action is allowed only where both
 * hold it, so a test lends nobody the principal's grants and does not pass where the live run
 * would fail. A refusal on the principal's side names the principal.
 */
export function boundedActorAccess(
  tester: ActorAccess,
  principal: ActorAccess,
  boundBy: { id: string; label: string }
): ActorAccess {
  return {
    scopeOf(dimension) {
      const own = tester.scopeOf(dimension);
      const bound = principal.scopeOf(dimension);
      return own === "all"
        ? bound
        : bound === "all"
          ? own
          : own.filter((value) => bound.includes(value));
    },
    authorize(action, resource) {
      const own = tester.authorize(action, resource);
      return own.allowed ? principal.authorize(action, resource) : own;
    },
    require(action, resource) {
      tester.require(action, resource);
      const bound = principal.authorize(action, resource);
      if (!bound.allowed) {
        throw operationDenialError({ kind: "forbidden", action, reason: bound.reason, boundBy });
      }
    },
    authorizeTransfer(action, resource) {
      const own = tester.authorizeTransfer(action, resource);
      return own.allowed ? principal.authorizeTransfer(action, resource) : own;
    },
    holdsGrantAt: (action, scopeKinds) =>
      tester.holdsGrantAt(action, scopeKinds) && principal.holdsGrantAt(action, scopeKinds),
    denials: (action) => [...tester.denials(action), ...principal.denials(action)]
  };
}
