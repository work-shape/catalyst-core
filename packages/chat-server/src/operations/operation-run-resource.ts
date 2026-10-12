import {
  APP_ASSET_KIND,
  apiOperations,
  type OperationRunResource
} from "@vivd-catalyst/api-contract";
import type { ClientInstanceId, ConfigAssetStore, OperationRun } from "@vivd-catalyst/core";
import { appTitleOf } from "../apps/action-source";

/** Where a run is read. Its page in the interface replaces this once it exists. */
export function operationRunHref(run: Pick<OperationRun, "id">): string {
  return apiOperations["operations.get_run"].buildPath({ params: { runId: run.id } });
}

/** The Apps runs came from, by name, as the instance holds them now. */
export type OperationRunApps = ReadonlyMap<string, NonNullable<OperationRunResource["app"]>>;

/**
 * What the Apps the runs name are now: one read for all of them, deleted ones included. The
 * number of a call's revision is told while the App's draft or its published pointer is still
 * that revision. An App no row is left of counts as deleted.
 */
export async function readOperationRunApps(
  deps: {
    clientInstanceId: ClientInstanceId;
    store: Pick<ConfigAssetStore, "listConfigAssetsByKey">;
  },
  runs: readonly OperationRun[]
): Promise<OperationRunApps> {
  const made = runs.flatMap(({ origin }) =>
    origin.kind === "app" && origin.appName !== undefined
      ? [{ appName: origin.appName, revisionId: origin.appRevisionId }]
      : []
  );
  if (made.length === 0) return new Map();
  const names = [...new Set(made.map((entry) => entry.appName))];
  const stored = new Map(
    (
      await deps.store.listConfigAssetsByKey({
        clientInstanceId: deps.clientInstanceId,
        keys: names.map((name) => ({ kind: APP_ASSET_KIND, name }))
      })
    ).map((asset) => [asset.name, asset])
  );
  return new Map(
    made.map(({ appName, revisionId }): [string, NonNullable<OperationRunResource["app"]>] => {
      const asset = stored.get(appName);
      if (!asset || asset.status !== "active") {
        return [appKey(appName, revisionId), { deleted: true }];
      }
      const revision =
        revisionId === asset.activeRevisionId
          ? asset.revision
          : revisionId === asset.publishedRevisionId
            ? asset.publishedRevision
            : undefined;
      return [
        appKey(appName, revisionId),
        {
          title: appTitleOf(asset.config, asset.name),
          ...(revision === undefined ? {} : { revision }),
          deleted: false
        }
      ];
    })
  );
}

/** One App at one revision: what the facts of a run's App are kept under. */
function appKey(appName: string, revisionId: string): string {
  return `${appName}\n${revisionId}`;
}

/**
 * A run as a caller reads it, with the App it came from where `apps` holds it. It leaves out what the run retains for a repeated call, the
 * caller's idempotency key and whom a delegated call was made through.
 */
export function toOperationRunResource(
  run: OperationRun,
  apps?: OperationRunApps
): OperationRunResource {
  const app =
    run.origin.kind === "app" && run.origin.appName !== undefined
      ? apps?.get(appKey(run.origin.appName, run.origin.appRevisionId))
      : undefined;
  return {
    id: run.id,
    operation: run.operation,
    effect: run.effect,
    status: run.status,
    actor: { kind: run.actor.kind, id: run.actor.id, label: run.actor.label },
    origin: run.origin,
    ...(app ? { app } : {}),
    workspaceId: run.workspaceId,
    approvalRequestId: run.approvalRequestId,
    inputHash: run.inputHash,
    attempt: run.attempt,
    decision: run.decision && {
      mode: run.decision.mode,
      reason: run.decision.reason,
      by: run.decision.by,
      byLabel: run.decision.byLabel,
      at: run.decision.at,
      comment: run.decision.comment
    },
    error: run.error && {
      code: run.error.code,
      message: run.error.message,
      ...(run.error.reason === undefined ? {} : { reason: run.error.reason })
    },
    usage: run.usage,
    correlationId: run.correlationId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    expiresAt: run.expiresAt,
    href: operationRunHref(run)
  };
}
