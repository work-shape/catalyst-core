import { z } from "zod";
import {
  defineJobHandler,
  isOperationRunId,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeWorkflowSourceEndJob,
  type ActorAccess,
  type DataStoreRecord,
  type JobControl,
  type KnowledgeSyncJobPayload,
  type KnowledgeWorkflowSourcesOutput
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";
import { cancelPass, forgetPassRows } from "./ingest";
import { withdrawSourceItems } from "./source-withdrawal";
import { createSourceStore } from "./source-store";
import type { SourceJobRuntime } from "./source-runtime";

// KBW-2c: deleting a Workflow ends its source in every Knowledge Base it fed: hidden from the
// page, closed to further passes, every item withdrawn at once and purged on the usual
// deadline. The key of a source is `workflow-source-key.ts`'s.

/** The owned-store migration that gave a Workflow's source its revision and end. */
export const WORKFLOW_SOURCE_END_MIGRATION = 15;
/** The owned-store migration that gave a source its kind: before it, no Workflow fed one. */
const WORKFLOW_SOURCES_MIGRATION = 6;
/** Bounds one owned transaction of a withdrawal, and a page of stores read. */
const END_BATCH = 100;

/** The Knowledge Base stores a Workflow may have fed, a page at a time. */
async function* knowledgeStores(runtime: DataStoreRuntime): AsyncGenerator<DataStoreRecord> {
  let after: { name: string; id: string } | undefined;
  for (;;) {
    const records = await runtime.stores.dataStores.listDataStores({
      clientInstanceId: runtime.clientInstanceId,
      limit: END_BATCH + 1,
      ...(after ? { after } : {})
    });
    for (const record of records.slice(0, END_BATCH))
      if (
        record.ownerKnowledgeBaseId !== undefined &&
        record.status === "ready" &&
        record.migrations.some(({ number }) => number === WORKFLOW_SOURCES_MIGRATION)
      )
        yield record;
    const last = records.at(END_BATCH - 1);
    if (records.length <= END_BATCH || !last) return;
    after = { name: last.name, id: last.id };
  }
}

function migrated(record: DataStoreRecord): boolean {
  return record.migrations.some(({ number }) => number === WORKFLOW_SOURCE_END_MIGRATION);
}

/**
 * The delete question of a Workflow: the Knowledge Bases its live sources feed, with how many
 * documents each holds there. One the reader may not use is counted, never named.
 */
export async function workflowSourceDocuments(
  runtime: DataStoreRuntime,
  workflow: string,
  access: ActorAccess,
  signal: AbortSignal
): Promise<KnowledgeWorkflowSourcesOutput> {
  const answer: KnowledgeWorkflowSourcesOutput = {
    knowledgeBases: [],
    hidden: { knowledgeBases: 0, documents: 0 }
  };
  for await (const record of knowledgeStores(runtime)) {
    signal.throwIfAborted();
    const name = record.ownerKnowledgeBaseId;
    if (name === undefined) continue;
    const [row] = z.array(z.object({ sources: z.number(), documents: z.number() })).parse(
      await createSourceStore(runtime, record.id, signal).change((sql) =>
        sql.run(
          `select count(*)::int as sources,coalesce(sum((select count(*) from catalyst_kb.source_items i where i.source_id=c.source_id and i.state<>'withdrawn')),0)::int as documents
             from catalyst_kb.source_cursors c where c.kind='workflow' and c.workflow_id=$1::text${migrated(record) ? " and c.ended_at is null" : ""}`,
          [workflow]
        )
      )
    );
    if (!row?.sources) continue;
    const asset = await runtime.stores.configAssets.getConfigAsset({
      clientInstanceId: runtime.clientInstanceId,
      kind: KNOWLEDGE_BASE_ASSET_KIND,
      name
    });
    const visible =
      asset?.status === "active" &&
      asset.id === record.id &&
      access.authorize(KNOWLEDGE_BASE_ACTIONS.use, {
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name,
        assetId: asset.id,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      }).allowed;
    if (!visible) {
      answer.hidden.knowledgeBases++;
      answer.hidden.documents += row.documents;
      continue;
    }
    answer.knowledgeBases.push({
      name,
      title: titleOf(asset.config) ?? name,
      documents: row.documents
    });
  }
  return answer;
}

function titleOf(config: unknown): string | undefined {
  const parsed = z.object({ title: z.string().min(1) }).safeParse(config);
  return parsed.success ? parsed.data.title : undefined;
}

/**
 * Ends every source of a deleted Workflow: those whose creating revision is at most `through`,
 * and those of the release before, in every Knowledge Base store. An ended source with items
 * left, from an attempt cut short or a source a later Workflow ended, is finished too.
 */
export function createWorkflowSourceEndHandler(runtime: SourceJobRuntime) {
  return defineJobHandler({
    kind: knowledgeWorkflowSourceEndJob,
    slots: 1,
    async run(job, control) {
      for await (const record of knowledgeStores(runtime.data)) {
        // Its upgrade runs at the start of this release; the job tries again after it.
        if (!migrated(record))
          throw new Error("A Knowledge Base store awaits its upgrade before a source can end");
        await endInStore(runtime, control, record.id, job.payload, job.correlationId);
      }
    }
  });
}

async function endInStore(
  runtime: SourceJobRuntime,
  control: JobControl,
  knowledgeBaseId: string,
  input: { workflow: string; through: number },
  correlationId: string
) {
  const store = createSourceStore(runtime.data, knowledgeBaseId, control.signal);
  const sources = z.array(z.object({ source_id: z.string() })).parse(
    await store.change((sql) =>
      sql.run(
        `select c.source_id from catalyst_kb.source_cursors c
           where c.kind='workflow' and c.workflow_id=$1::text
             and (c.workflow_revision is null or c.workflow_revision<=$2::int)
             and (c.ended_at is null or exists (select 1 from catalyst_kb.source_items i where i.source_id=c.source_id and i.state<>'withdrawn'))
           order by c.source_id`,
        [input.workflow, input.through]
      )
    )
  );
  for (const { source_id: sourceId } of sources) {
    const base = { knowledgeBaseId, sourceId, syncRunId: "", operationRunId: "" };
    // Hidden from the page and closed to passes at once; a pass waiting for its run's end
    // withdraws nothing.
    const passes = await store.change(async (sql) => {
      // After a call that resolved the source before, and before any that resolves it after.
      await sql.run(
        "select pg_advisory_xact_lock(hashtext('catalyst_kb.workflow_source:' || $1))",
        [input.workflow]
      );
      await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
      await sql.run(
        "update catalyst_kb.source_cursors set ended_at=coalesce(ended_at,now()) where source_id=$1::text",
        [sourceId]
      );
      await sql.run(
        "update catalyst_kb.sync_runs set pass_state='dropped' where source_id=$1::text and pass_state in ('awaiting_run','confirming')",
        [sourceId]
      );
      const waiting = z
        .array(z.object({ sync_run_id: z.string(), operation_run_id: z.string() }))
        .parse(
          await sql.run(
            "delete from catalyst_kb.ingest_waiting where source_id=$1::text returning sync_run_id,operation_run_id",
            [sourceId]
          )
        );
      for (const pass of waiting) await forgetPassRows(sql, pass.sync_run_id);
      const running = z
        .array(z.object({ id: z.string(), operation_run_id: z.string() }))
        .parse(
          await sql.run(
            "select id,operation_run_id from catalyst_kb.sync_runs where source_id=$1::text and state='running'",
            [sourceId]
          )
        );
      return { waiting, running };
    });
    for (const pass of passes.waiting) await cancelWaiting(runtime, control, pass.operation_run_id);
    for (const pass of passes.running) {
      const payload: KnowledgeSyncJobPayload = {
        ...base,
        syncRunId: pass.id,
        operationRunId: pass.operation_run_id
      };
      await cancelPass(runtime, payload, control);
    }
    let items = 0;
    for (;;) {
      const withdrawn = await store.change(async (sql) => {
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(
            await sql.run(
              "select id from catalyst_kb.source_items where source_id=$1::text and state<>'withdrawn' order by id limit $2::int",
              [sourceId, END_BATCH]
            )
          )
          .map((row) => row.id);
        if (!ids.length) return 0;
        return runtime.data.stores.transaction((stores) =>
          withdrawSourceItems(sql, stores, runtime.data, base, ids)
        );
      });
      items += withdrawn;
      if (withdrawn === 0) break;
    }
    await control.transaction((stores) =>
      stores.audit.appendAuditEvent({
        clientInstanceId: runtime.data.clientInstanceId,
        type: "knowledge_base.workflow_source_ended",
        status: "success",
        subject: knowledgeBaseId,
        correlationId,
        metadata: { source: sourceId, items }
      })
    );
  }
}

/** A call that waited for its turn ends with its source. */
async function cancelWaiting(
  runtime: SourceJobRuntime,
  control: JobControl,
  operationRunId: string
) {
  if (!isOperationRunId(operationRunId)) return;
  await control.transaction((stores) =>
    stores.operationRuns.finish({
      clientInstanceId: runtime.data.clientInstanceId,
      id: operationRunId,
      end: {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: {
          code: "knowledge_ingest_cancelled",
          message: "The Workflow was deleted before its turn to put documents in"
        }
      }
    })
  );
}
