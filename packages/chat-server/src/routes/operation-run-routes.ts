import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asCollaborationWorkspaceId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type OperationRun
} from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import { readOperationRunApps, toOperationRunResource } from "../operations/operation-run-resource";
import type { ResolvedChatServerOptions } from "../types";

export function registerOperationRunRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const { clientInstanceId } = options;
  const runs = options.stores.operationRuns;
  const apps = { clientInstanceId, store: options.stores.configAssets };

  // A caller reads the run of its own call. Anybody else's run is governance evidence and
  // takes the right the list takes. A run of another instance does not exist.
  route(apiOperations["operations.get_run"], async ({ identity, access, params }) => {
    const run = await runs.get({ clientInstanceId, id: params.runId });
    if (!run) {
      throw new AppError("NOT_FOUND", "Operation run not found");
    }
    if (!isCallerOf(run, identity)) {
      // A personal key follows only its owner's calls, never another person's evidence.
      if (!isAuthenticatedServicePrincipal(identity) && identity.keyScopes !== undefined) {
        throw new AppError("NOT_FOUND", "Operation run not found");
      }
      access.require("audit.view", { kind: "operation_run", workspaceId: run.workspaceId });
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
