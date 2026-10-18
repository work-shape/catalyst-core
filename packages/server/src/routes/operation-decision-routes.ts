import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationDenial
} from "@work-shape/catalyst-core";
import type { Route } from "../http/route";
import { toOperationRunResource } from "../operations/operation-run-resource";
import type { ResolvedChatServerOptions } from "../types";

/**
 * A person's decision on a call their own Agent Run waits on (EW-2a). The decision is itself
 * a call of the person, recorded as an Operation Run. It is recorded on the waiting call's
 * run, and the Agent Run goes on in its worker: a confirmed call is executed there once, a
 * declined one is answered to the agent with the reason.
 */
export function registerOperationDecisionRoutes(
  route: Route,
  options: ResolvedChatServerOptions
): void {
  const { clientInstanceId, stores } = options;

  /** The run the call waits in, where the caller is the person it works for. */
  const authorizeDecider = async (
    runId: string,
    actor: AuthenticatedIdentity
  ): Promise<OperationAuthorization> => {
    const refused: OperationAuthorization = {
      allowed: false,
      action: "operations.decide",
      reason: "no_grant"
    };
    if (isAuthenticatedServicePrincipal(actor)) return refused;
    const call = await stores.operationRuns.get({ clientInstanceId, id: runId });
    if (call?.origin.kind !== "agent") {
      throw new AppError("NOT_FOUND", "This call is not available");
    }
    const agentRun = await stores.agentRuns.getAgentRun({
      clientInstanceId,
      runId: call.origin.agentRunId
    });
    if (!agentRun) throw new AppError("NOT_FOUND", "This call is not available");
    return agentRun.ownerUserId === getSubjectUserId(actor) ? { allowed: true } : refused;
  };

  route.operation(apiOperations["operations.decide"], {
    changeClass: "irreversible",
    authorize: ({ runId }, { actor }) => authorizeDecider(runId, actor),
    resource: ({ runId }) => ({ kind: "operation_run", id: runId }),
    async execute({ runId, decision, reason, audience }, { actor }) {
      if (isAuthenticatedServicePrincipal(actor)) {
        throw new AppError("FORBIDDEN", "Only a person decides the calls of their own run");
      }
      const at = new Date().toISOString();
      const comment = reason === undefined ? {} : { comment: reason };
      const mode = decision === "confirm" ? "confirmed" : "declined";
      const denial: OperationDenial = { kind: "declined", by: actor.id, ...comment };
      const error = operationDenialError(denial);
      const decided = await stores.agentRuns.decideWaitingToolCall({
        clientInstanceId,
        operationRunId: runId,
        deciderUserId: getSubjectUserId(actor),
        ...(audience ? { audience } : {}),
        decision: { mode, by: actor.id, byLabel: actor.displayLabel, at, ...comment },
        ...(mode === "declined"
          ? { declined: { error: { code: error.code, message: error.message }, denial } }
          : {})
      });
      return {
        run: toOperationRunResource(decided.operationRun),
        agentRun: {
          id: decided.agentRun.id,
          status: decided.agentRun.status,
          lastSequence: decided.agentRun.lastSequence
        }
      };
    }
  });
}
