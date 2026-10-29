import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  WAITING_OPERATION_RUN_STATUSES,
  asCollaborationWorkspaceId,
  isAuthenticatedServicePrincipal,
  personalApiKeyNamesAction,
  type ActorAccess,
  type AuthenticatedIdentity,
  type OperationRun
} from "@work-shape/catalyst-core";
import { decidesRequest } from "../approvals/approval-request-service";
import type { Route } from "../http/route";
import { readOperationRunApps, toOperationRunResource } from "../operations/operation-run-resource";
import type { ResolvedChatServerOptions } from "../types";

export function registerOperationRunRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const { clientInstanceId } = options;
  const runs = options.stores.operationRuns;
  const apps = { clientInstanceId, store: options.stores.configAssets };

  /**
   * Whether the run waits for the caller: it waits on a pending request that they decide
   * (OPS-RUN-READ-1). They read that one run while it waits, so the request's card can show.
   */
  async function waitsFor(
    run: OperationRun,
    identity: AuthenticatedIdentity,
    access: ActorAccess
  ): Promise<boolean> {
    const approvals = options.approvalRequests;
    if (
      !approvals ||
      run.approvalRequestId === undefined ||
      !WAITING_OPERATION_RUN_STATUSES.some((status) => status === run.status)
    ) {
      return false;
    }
    const request = await approvals.store.getApprovalRequest({
      clientInstanceId,
      requestId: run.approvalRequestId
    });
    const handler = request && approvals.handlers.get(request.kind);
    return (
      request?.status === "pending" &&
      handler !== undefined &&
      decidesRequest(handler, request, identity, access)
    );
  }

  // A caller reads the run of its own call, and the person it waits on reads it while it
  // waits. Anybody else's run is governance evidence and takes the right the list takes. A
  // run of another instance does not exist.
  route(apiOperations["operations.get_run"], async ({ identity, access, params }) => {
    const run = await runs.get({ clientInstanceId, id: params.runId });
    if (!run) {
      throw new AppError("NOT_FOUND", "Operation run not found");
    }
    if (!isCallerOf(run, identity)) {
      // A personal key follows only its owner's calls, never another person's evidence, unless
      // it names `audit.view` (CLI-PARITY-6a): then the owner's right of the same name decides.
      if (
        !isAuthenticatedServicePrincipal(identity) &&
        identity.keyScopes !== undefined &&
        !personalApiKeyNamesAction(identity.keyScopes, "audit.view")
      ) {
        throw new AppError("NOT_FOUND", "Operation run not found");
      }
      if (!(await waitsFor(run, identity, access))) {
        access.require("audit.view", { kind: "operation_run", workspaceId: run.workspaceId });
      }
    }
    return toOperationRunResource(run, await readOperationRunApps(apps, [run]));
  });

  route(apiOperations["operations.list_runs"], async ({ query, paging }) => {
    const listed = await runs.list({
      clientInstanceId,
      filters: {
        operation: query.operation,
        effect: query.effect,
        status: query.status,
        actorId: query.actor,
        originKind: query.origin,
        workspaceId:
          query.workspaceId === undefined
            ? undefined
            : asCollaborationWorkspaceId(query.workspaceId),
        since: query.since
      },
      page: paging
    });
    const madeIn = await readOperationRunApps(apps, listed);
    return listed.map((run) => toOperationRunResource(run, madeIn));
  });
}

function isCallerOf(run: OperationRun, identity: AuthenticatedIdentity): boolean {
  const kind = isAuthenticatedServicePrincipal(identity) ? "service_principal" : "user";
  return run.actor.kind === kind && run.actor.id === identity.id;
}
