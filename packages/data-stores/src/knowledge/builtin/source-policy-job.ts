import { enqueueSourceSync, initialSyncIds, sourceSyncStarted } from "./source-lifecycle";
import { z } from "zod";
import { defineJobKind, defineJobHandler, KNOWLEDGE_JOB_KINDS } from "@work-shape/catalyst-core";
import { knowledgeBaseDefinitionSchema } from "../definition";
import { sourceBoundaryKey, withinSource } from "../source-boundary";
import { createSourceStore, sourceTransaction } from "./source-store";
import { sourceTarget, type SourceJobRuntime } from "./source-runtime";

export const sourcePolicyJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.reconcileSources,
  payloadSchema: z.strictObject({
    knowledgeBaseId: z.string(),
    knowledgeBase: z.string(),
    revision: z.number().int(),
    sourceIds: z.array(z.string())
  }),
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 600_000 },
  leaseMs: 120_000,
  concurrency: { perKey: 1 }
});
const POLICY_PAGE = 100; // Bound source metadata and purge ids per transaction.

/** The publish queues this before it answers. Search reads the published boundary
 * immediately; this job records the tombstones and durably queues KB-5e's purge. */
export function createSourcePolicyHandler(runtime: SourceJobRuntime) {
  return defineJobHandler({
    kind: sourcePolicyJob,
    slots: 1,
    async run(job, control) {
      const asset = await runtime.data.stores.configAssets.getConfigAsset({
        clientInstanceId: runtime.data.clientInstanceId,
        kind: "knowledge_base",
        name: job.payload.knowledgeBase
      });
      if (!asset || asset.id !== job.payload.knowledgeBaseId || asset.status !== "active") return;

      const payload = {
        knowledgeBaseId: asset.id,
        sourceId: "",
        syncRunId: "",
        operationRunId: ""
      };
      const store = createSourceStore(runtime.data, asset.id, control.signal);
      // A boundary publish supersedes the earlier listing, including a paused full pass.
      // Finish through the normal lifecycle, so its Operation Run cannot wait forever.
      const runs = z
        .array(z.object({ id: z.string(), source_id: z.string(), operation_run_id: z.string() }))
        .parse(
          await store.change((sql) =>
            sql.run(
              "select id,source_id,operation_run_id from catalyst_kb.sync_runs where state='running' and source_id=any($1::text[])",
              [job.payload.sourceIds]
            )
          )
        );
      for (const run of runs) {
        await store.change(async (sql) => {
          await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
          // API start may hold this row before borrowing a platform connection. Wait
          // on the owned connection first, leaving the platform pool available to it.
          const [held] = z
            .array(z.object({ definition_key: z.string().nullable() }))
            .parse(
              await sql.run(
                "select definition_key from catalyst_kb.sync_runs where id=$1::text and state='running' for update",
                [run.id]
              )
            );
          if (!held) return;
          await control.transaction(async (stores) => {
            const runPayload = {
              ...payload,
              sourceId: run.source_id,
              syncRunId: run.id,
              operationRunId: run.operation_run_id
            };
            const found = await sourceTarget(runtime, runPayload, stores, "share");
            if (found && held.definition_key === sourceBoundaryKey(found.source)) return;
            const bound = createSourceStore(runtime.data, asset.id, control.signal, stores, sql);
            await sql.run(
              "update catalyst_kb.source_items set fetch_job_id=null,enqueued_run_id=null where source_id=$1::text and state='discovered' and enqueued_run_id=$2::text",
              [run.source_id, run.id]
            );
            await bound.finish(runPayload, "knowledge_source_refused");
          });
        });
      }
      let after = "";
      for (;;) {
        const last = await sourceTransaction(
          runtime.data,
          payload,
          control,
          async (store, stores) =>
            store.change(async (sql) => {
              const current = await stores.configAssets.getConfigAsset({
                clientInstanceId: runtime.data.clientInstanceId,
                kind: "knowledge_base",
                name: job.payload.knowledgeBase,
                lock: "share"
              });
              if (!current || current.status !== "active" || current.id !== asset.id)
                return undefined;
              const definition = knowledgeBaseDefinitionSchema.parse(current.publishedConfig);
              const rows = z
                .array(
                  z.object({
                    id: z.string(),
                    source_id: z.string(),
                    parents: z.array(z.string()),
                    name: z.string(),
                    path: z.string()
                  })
                )
                .parse(
                  await sql.run(
                    "select id,source_id,parents,name,path from catalyst_kb.source_items where id>$1::text and state<>'withdrawn' and source_id=any($3::text[]) order by id limit $2::int",
                    [after, POLICY_PAGE, job.payload.sourceIds]
                  )
                );
              for (const sourceId of new Set(rows.map((row) => row.source_id))) {
                const source = definition.sources?.find((source) => source.id === sourceId);
                const ids = rows
                  .filter(
                    (row) => row.source_id === sourceId && (!source || !withinSource(source, row))
                  )
                  .map((row) => row.id);
                await store.withdraw({ ...payload, sourceId }, ids);
              }
              return rows.length === POLICY_PAGE ? rows.at(-1)?.id : undefined;
            })
        );
        if (!last) break;
        after = last;
      }
      // A changed boundary cannot classify legacy items with unknown ancestry.
      // Start the listing now rather than leaving them until the nightly full pass.
      for (const sourceId of job.payload.sourceIds) {
        const next = initialSyncIds(asset.id, sourceId);
        await sourceTransaction(runtime.data, next, control, async (bound, stores) => {
          const found = await sourceTarget(runtime, next, stores, "share");
          if (!found) return;
          const unknown = await bound.change((sql) =>
            sql.run(
              "select id from catalyst_kb.source_items where source_id=$1::text and state<>'withdrawn' and parents='[]'::jsonb limit 1",
              [sourceId]
            )
          );
          if (!unknown.length) return;
          const started = await bound.start(next, "full");
          if (!started.created) return;
          const principal = await stores.apiAccess.findServicePrincipalByOwner({
            clientInstanceId: runtime.data.clientInstanceId,
            owner: { kind: "knowledge_base", assetId: asset.id }
          });
          if (!principal) throw new Error("The source ingestion principal is unavailable");
          await stores.operationRuns.create({
            id: next.operationRunId,
            clientInstanceId: runtime.data.clientInstanceId,
            operation: `knowledge.${asset.name}.sync`,
            effect: "changing",
            actor: { kind: "service_principal", id: principal.id, label: principal.displayLabel },
            origin: { kind: "user" },
            target: "live",
            inputHash: "source_boundary_changed",
            correlationId: next.operationRunId,
            startedAt: new Date().toISOString()
          });
          await enqueueSourceSync(stores, runtime.data, next);
          await sourceSyncStarted(stores, runtime.data, next);
        });
      }
    }
  });
}
