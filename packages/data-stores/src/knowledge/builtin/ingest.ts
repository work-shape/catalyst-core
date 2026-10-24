import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  asUserId,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  createActorAccess,
  createPlatformId,
  enqueueKnowledgeIndex,
  isOperationRunId,
  isWorkflowRunEnded,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeIndexPayloadOfFetch,
  knowledgeIngestItemSchema,
  knowledgeSourceKey,
  knowledgeSyncJob,
  operationBatchFailureSchema,
  subjectDedupeKey,
  workflowDatasetReferenceSchema,
  type JobControl,
  type JsonObject,
  type KnowledgeDocumentFormat,
  type KnowledgeIngestOutput,
  type KnowledgeSyncJobPayload,
  type OperationBatchFailure,
  type PlatformStores,
  type WorkflowDatasetReference
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import type { DataStoreRuntime } from "../../runtime";
import type { KnowledgeIngestCall } from "../source-port";
import { SOURCE_WITHDRAWAL_APPROVAL } from "../source-withdrawal-approval";
import { enqueueKnowledgeFileCleanup } from "../file-cleanup";
import { releaseCopy } from "./fetch-job";
import { enqueueSourceSync, sourceSyncStarted } from "./source-lifecycle";
import { withdrawSourceItems } from "./source-withdrawal";
import {
  createSourceStore,
  sourceItemId,
  sourceTransaction,
  syncResult,
  type SourceItem
} from "./source-store";
import type { SourceJobRuntime } from "./source-runtime";

// KBW-1: a Workflow puts documents into a Knowledge Base. One call of `knowledge.<id>.ingest`
// is one sync run of mode `ingest` of the source `workflow:<workflow>`, and one job walks it:
//
// 1. Read. The items are a dataset of the calling run, or an inline list the call kept in
//    `ingest_items` until the pass has read it. A page at a time, each item is checked on its own; a valid one is written into
//    `source_items` idempotently by `(source_id, item_id, version)` and its text goes through
//    SRC-1a's writer (a Knowledge Base-owned copy, `fetched`, the index job). One that is not
//    valid keeps its outcome in `ingest_failures`. The offset is the run's cursor.
// 2. Settle. The Operation Run ends once every item of the pass is indexed or failed, with
//    `{ accepted, done, failed, failures, withdrawn }`, `failures` a dataset of the step run.
// 3. Complete. A pass with `complete: true` withdraws the items its Workflow run did not
//    name, only once that run ended `done`, and above `withdrawShareConfirm` of the source
//    only after a person confirmed it in the publisher's Inbox. A run that ended otherwise
//    withdraws nothing. `withdrawn` of the result is what the pass will withdraw then.
//
// The job polls the run's end rather than being told: the engine knows nothing of Knowledge
// Bases, and a missed wake would leave a pass waiting for ever.
//
// The Workflow's account is asked afresh before every page and before a complete pass
// withdraws (KBW-2a), as a connector sync asks for `connection.use` per batch: a pass whose
// account lost `knowledge_base.write` ends `failed` with `knowledge_source_refused`, what it
// wrote stays, and it withdraws nothing. A `fetch` item's Connection is asked on its page.
//
// Content is never audit data or a failure message: a failure row keeps the item's identity
// (id, version, name, path, link), and its message names a field and a code.

// A page bounds one owned transaction and what a lost lease writes twice.
const INGEST_PAGE_ROWS = 100;
// Each purge payload and owned transaction holds at most this many ids.
const INGEST_WITHDRAWAL_BATCH = 100;
// Indexing usually ends within seconds; a long pass is looked at less often.
const SETTLE_WAIT_MIN_MS = 5_000;
const SETTLE_WAIT_MAX_MS = 60_000;
// A data Workflow's run usually ends soon after its ingest; one that waits days costs little.
const PASS_WAIT_MIN_MS = 30_000;
const PASS_WAIT_MAX_MS = 15 * 60_000;
const IDENTITY_MAX_CHARS = 1_000;
const DEFAULT_WITHDRAW_SHARE_CONFIRM = 0.2;

const progressSchema = z.object({
  complete: z.boolean(),
  offset: z.number().int().min(0),
  /** The rows up to which the run's counts were added, so a page read again adds none. */
  counted: z.number().int().min(0)
});
type IngestProgress = z.infer<typeof progressSchema>;

const ingestRunSchema = z.object({
  state: z.string(),
  pass_state: z.string().nullable(),
  workflow_run_id: z.string(),
  /** Absent where the call named its items inline: they are in `ingest_items`. */
  dataset: workflowDatasetReferenceSchema.nullable(),
  complete: z.boolean(),
  accepted: z.number().int(),
  cursor_after: z.string().nullable(),
  approval_request_id: z.string().nullable(),
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable()
});
type IngestRun = z.infer<typeof ingestRunSchema>;
const INGEST_RUN_COLUMNS =
  "state,pass_state,workflow_run_id,dataset,complete,accepted,cursor_after,approval_request_id,started_at,ended_at";

const countSchema = z.object({ n: z.coerce.number().int() });
const idsSchema = z.array(z.object({ id: z.string() }));

/** The source a Workflow feeds. Its id never collides with a connector source's. */
function workflowSourceId(workflowId: string): string {
  return `workflow:${workflowId}`;
}

/** Whether a sync job's source is a Workflow's: its passes are `ingest` calls. */
export function isWorkflowSourceId(sourceId: string): boolean {
  return sourceId.startsWith("workflow:");
}

/** One call answers one sync run, so a repeated start of the same call finds its own. */
function ingestSyncRunId(operationRunId: string): string {
  return `kbsync_${createHash("sha256").update(operationRunId).digest("hex").slice(0, 32)}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The identity of an item, as far as it has one: never its content. */
function identityOf(row: unknown): JsonObject {
  if (!isObject(row)) return {};
  const identity: JsonObject = {};
  for (const key of ["itemId", "version", "name", "path", "originLink"] as const) {
    const value = row[key];
    if (typeof value === "string") identity[key] = value.slice(0, IDENTITY_MAX_CHARS);
  }
  return identity;
}

type Classified =
  | {
      ok: true;
      position: number;
      item: {
        itemId: string;
        version: string;
        name: string;
        path?: string | undefined;
        originLink?: string | undefined;
        text: string;
      };
    }
  | { ok: false; position: number; failure: OperationBatchFailure };

function refused(position: number, row: unknown, code: string, field: string): Classified {
  return {
    ok: false,
    position,
    failure: { item: identityOf(row), code, message: `${code}: ${field}` }
  };
}

/**
 * Checks one item on its own. Until CONN-DL a `fetch` item fails: with
 * `knowledge_fetch_not_allowed` where the Workflow's account may not use its Connection now,
 * and as not yet supported otherwise. A `fileId` names a Managed File a Workflow could read,
 * and a Workflow reads none yet.
 */
function classify(row: unknown, position: number, connections: readonly string[]): Classified {
  const fetch = isObject(row) ? row.fetch : undefined;
  if (isObject(fetch)) {
    const connection = fetch.connection;
    return typeof connection === "string" && connections.includes(connection)
      ? refused(position, row, "knowledge_item_invalid", "fetch (not_supported_yet)")
      : refused(position, row, "knowledge_fetch_not_allowed", "fetch.connection");
  }
  const parsed = knowledgeIngestItemSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.join(".") : "item";
    return refused(position, row, "knowledge_item_invalid", field);
  }
  const item = parsed.data;
  if (item.text === undefined)
    return refused(position, row, "knowledge_item_invalid", "fileId (not_supported_yet)");
  return {
    ok: true,
    position,
    item: {
      itemId: item.itemId,
      version: item.version,
      name: item.name,
      path: item.path,
      originLink: item.originLink,
      text: item.text
    }
  };
}

/**
 * What the account of the pass's Workflow run may do now, read afresh from its grants: write
 * the Knowledge Base, and use which Connections (asked only where a page names one). An
 * account that is gone, disabled or no longer the run's may do nothing, and neither may any
 * account on a Knowledge Base that is no longer published.
 */
async function workflowAccount(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  workflowRunId: string
): Promise<{ write: boolean; uses(connection: string): Promise<boolean> }> {
  const nothing = { write: false, uses: () => Promise.resolve(false) };
  const { stores, clientInstanceId } = runtime.data;
  const run = await stores.workflowRuns.readRun({ clientInstanceId, id: workflowRunId });
  if (!run) return nothing;
  const principal = await stores.apiAccess.findServicePrincipalByName({
    clientInstanceId,
    name: run.principal.name
  });
  // A name is one principal's for good, so another id under it is not the run's principal.
  if (principal?.status !== "active" || principal.id !== run.principal.id) return nothing;
  const knowledgeBase = await knowledgeBaseOf(runtime, payload.knowledgeBaseId, stores);
  if (!knowledgeBase) return nothing;
  const workspaceId =
    knowledgeBase.scope.kind === "workspace" ? knowledgeBase.scope.workspaceId : undefined;
  const access = createActorAccess(
    {
      kind: "service_principal",
      id: principal.id,
      clientInstanceId,
      roles: [],
      permissionRefs: principal.permissionRefs
    },
    await stores.access.loadPersistedAccess({
      clientInstanceId,
      holder: { kind: "service_principal", id: principal.id },
      workspaceId: workspaceId ?? null
    })
  );
  const write = access.authorize(KNOWLEDGE_BASE_ACTIONS.write, {
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    assetId: knowledgeBase.id,
    name: knowledgeBase.name,
    ...(workspaceId === undefined ? {} : { workspaceId })
  }).allowed;
  let usable: Promise<Set<string>> | undefined;
  return {
    write,
    async uses(connection) {
      usable ??= stores.configAssets
        .listActiveConfigAssets({ clientInstanceId, kind: CONNECTION_ASSET_KIND })
        .then(
          (connections) =>
            new Set(
              connections
                .filter(
                  (asset) =>
                    asset.status === "active" &&
                    access.authorize(CONNECTION_ACTIONS.use, {
                      kind: CONNECTION_ASSET_KIND,
                      assetId: asset.id,
                      name: asset.name
                    }).allowed
                )
                .map((asset) => asset.name)
            )
        );
      return (await usable).has(connection);
    }
  };
}

/** Markdown by its name's extension, plain text otherwise: the text is the content. */
function textFormat(name: string): { format: KnowledgeDocumentFormat; mime: string } {
  return /\.(md|markdown)$/iu.test(name)
    ? { format: "markdown", mime: "text/markdown" }
    : { format: "txt", mime: "text/plain" };
}

/**
 * Records the pass of one `ingest` call and queues its job: a dataset only once the calling run
 * may read it, inline items with the pass itself. The Workflow's source is made by its first call.
 */
export async function startIngest(
  runtime: DataStoreRuntime,
  call: KnowledgeIngestCall,
  signal: AbortSignal
): Promise<void> {
  const sourceId = workflowSourceId(call.workflowId);
  const syncRunId = ingestSyncRunId(call.operationRunId);
  let dataset: WorkflowDatasetReference | null = null;
  if ("dataset" in call.items) {
    const datasets = runtime.workflowDatasets;
    if (!datasets)
      throw new AppError("CONFLICT", "Ingestion needs the instance's dataset storage", {
        reason: "dataset_storage_unavailable"
      });
    await datasets.check({ workflowRunId: call.workflowRunId, reference: call.items.dataset });
    dataset = call.items.dataset;
  }
  const inline = "inline" in call.items ? call.items.inline : [];
  const payload: KnowledgeSyncJobPayload = {
    knowledgeBaseId: call.knowledgeBaseId,
    sourceId,
    syncRunId,
    operationRunId: call.operationRunId
  };
  const progress: IngestProgress = {
    complete: false,
    offset: 0,
    counted: 0
  };
  await createSourceStore(runtime, call.knowledgeBaseId, signal).change(async (sql) => {
    await sql.run(
      "insert into catalyst_kb.source_cursors (source_id,cursor,kind,workflow_id) values ($1::text,null,'workflow',$2::text) on conflict (source_id) do nothing",
      [sourceId, call.workflowId]
    );
    // A repeated start of the same call finds its pass, running or waiting.
    const known = await sql.run(
      "select 1 from catalyst_kb.sync_runs where id=$1::text union all select 1 from catalyst_kb.ingest_waiting where sync_run_id=$1::text",
      [syncRunId]
    );
    if (known.length) return;
    const values = [
      syncRunId,
      sourceId,
      call.operationRunId,
      JSON.stringify(progress),
      call.workflowRunId,
      dataset === null ? null : JSON.stringify(dataset),
      call.complete
    ];
    // One pass of a source runs at a time; another call of the Workflow waits for its turn.
    const created = await sql.run(
      `insert into catalyst_kb.sync_runs (id,source_id,mode,operation_run_id,cursor_after,workflow_run_id,dataset,complete)
       values ($1::text,$2::text,'ingest',$3::text,$4::text,$5::text,$6::jsonb,$7::boolean)
       on conflict (source_id) where state='running' do nothing returning id`,
      values
    );
    if (!created.length)
      await sql.run(
        `insert into catalyst_kb.ingest_waiting (sync_run_id,source_id,operation_run_id,cursor_after,workflow_run_id,dataset,complete)
         values ($1::text,$2::text,$3::text,$4::text,$5::text,$6::jsonb,$7::boolean)`,
        values
      );
    // Inline items keep their place; one that is no object fails as an invalid item.
    for (let start = 0; start < inline.length; start += INGEST_PAGE_ROWS)
      await sql.run(
        "insert into catalyst_kb.ingest_items (sync_run_id,position,item) select $1::text, $2::int + ordinality::int - 1, value from jsonb_array_elements($3::jsonb) with ordinality",
        [syncRunId, start, JSON.stringify(inline.slice(start, start + INGEST_PAGE_ROWS))]
      );
    await runtime.stores.transaction(async (stores) => {
      await enqueueSourceSync(stores, runtime, payload);
      if (created.length) await sourceSyncStarted(stores, runtime, payload);
    });
  });
}

/**
 * Starts a waiting pass once no other pass of its source runs. Answers whether it runs now,
 * still waits, or is no longer there.
 */
async function startWaiting(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl
): Promise<"started" | { waitingSince: Date } | "gone"> {
  return createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal).change(
    async (sql) => {
      const [waiting] = z
        .array(z.object({ created_at: z.coerce.date() }))
        .parse(
          await sql.run(
            "select created_at from catalyst_kb.ingest_waiting where sync_run_id=$1::text for update",
            [payload.syncRunId]
          )
        );
      if (!waiting) return "gone";
      const started = await sql.run(
        `insert into catalyst_kb.sync_runs (id,source_id,mode,operation_run_id,cursor_after,workflow_run_id,dataset,complete)
         select sync_run_id,source_id,'ingest',operation_run_id,cursor_after,workflow_run_id,dataset,complete
         from catalyst_kb.ingest_waiting where sync_run_id=$1::text
         on conflict (source_id) where state='running' do nothing returning id`,
        [payload.syncRunId]
      );
      if (!started.length) return { waitingSince: waiting.created_at };
      await sql.run("delete from catalyst_kb.ingest_waiting where sync_run_id=$1::text", [
        payload.syncRunId
      ]);
      await control.transaction((stores) => sourceSyncStarted(stores, runtime.data, payload));
      return "started";
    }
  );
}

/** Withdraws items of a Workflow-fed source by their ids at the Workflow. Search leaves them out at once. */
export async function withdrawWorkflowItems(
  runtime: DataStoreRuntime,
  input: { knowledgeBaseId: string; workflowId: string; itemIds: readonly string[] },
  signal: AbortSignal
): Promise<number> {
  const sourceId = workflowSourceId(input.workflowId);
  const ids = [...new Set(input.itemIds)].map((itemId) => sourceItemId(sourceId, itemId));
  const payload = {
    knowledgeBaseId: input.knowledgeBaseId,
    sourceId,
    syncRunId: "",
    operationRunId: ""
  };
  let withdrawn = 0;
  for (let start = 0; start < ids.length; start += INGEST_WITHDRAWAL_BATCH) {
    const batch = ids.slice(start, start + INGEST_WITHDRAWAL_BATCH);
    withdrawn += await createSourceStore(runtime, input.knowledgeBaseId, signal).change(
      async (sql) => {
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        return runtime.stores.transaction((stores) =>
          withdrawSourceItems(sql, stores, runtime, payload, batch)
        );
      }
    );
  }
  return withdrawn;
}

async function readIngestRun(
  sql: Pick<PostgresChangeStatements, "run">,
  syncRunId: string,
  lock = false
): Promise<IngestRun | undefined> {
  const [row] = z
    .array(ingestRunSchema)
    .parse(
      await sql.run(
        `select ${INGEST_RUN_COLUMNS} from catalyst_kb.sync_runs where id=$1::text and mode='ingest'${lock ? " for update" : ""}`,
        [syncRunId]
      )
    );
  return row;
}

function progressOf(run: IngestRun): IngestProgress {
  return progressSchema.parse(JSON.parse(run.cursor_after ?? "{}"));
}

async function again(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeSyncJobPayload,
  waitMs: number
) {
  await control.transaction((stores) =>
    stores.jobs.runAgainAfter(knowledgeSyncJob, payload, {
      clientInstanceId: runtime.data.clientInstanceId,
      subject: payload.knowledgeBaseId,
      concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
      dedupeKey: subjectDedupeKey(knowledgeSyncJob.kind, payload.syncRunId),
      runAfter: new Date(Date.now() + waitMs)
    })
  );
}

const waitFor = (since: Date, min: number, max: number, share: number) =>
  Math.min(max, Math.max(min, (Date.now() - since.getTime()) / share));

/** The job of one ingest pass, from the sync job for a run of mode `ingest`. */
export async function runIngestPass(
  runtime: SourceJobRuntime,
  job: { id: string; payload: KnowledgeSyncJobPayload },
  control: JobControl
): Promise<void> {
  const { payload } = job;
  const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
  let run = await store.change((sql) => readIngestRun(sql, payload.syncRunId));
  if (!run) {
    // A call whose run ended while it waited for its turn leaves at once: it holds no rows.
    if (await leaveIfRunGone(runtime, payload, control)) return;
    const waiting = await startWaiting(runtime, payload, control);
    if (waiting === "gone") return;
    if (waiting !== "started") {
      await again(
        runtime,
        control,
        payload,
        waitFor(waiting.waitingSince, SETTLE_WAIT_MIN_MS, SETTLE_WAIT_MAX_MS, 20)
      );
      return;
    }
    run = await store.change((sql) => readIngestRun(sql, payload.syncRunId));
    if (!run) return;
  }
  if (run.state === "running") {
    const ended = await readPass(runtime, job, control, run);
    if (!ended) return;
  }
  const current = await store.change((sql) => readIngestRun(sql, payload.syncRunId));
  if (current?.pass_state === "awaiting_run" || current?.pass_state === "confirming")
    await completePass(runtime, payload, control, current);
}

/** Ends a waiting call whose Workflow run is gone; answers whether it did. */
async function leaveIfRunGone(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl
): Promise<boolean> {
  const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
  const [waiting] = z
    .array(z.object({ workflow_run_id: z.string() }))
    .parse(
      await store.change((sql) =>
        sql.run(
          "select workflow_run_id from catalyst_kb.ingest_waiting where sync_run_id=$1::text",
          [payload.syncRunId]
        )
      )
    );
  if (!waiting || !(await workflowRunGone(runtime, waiting.workflow_run_id))) return false;
  await store.change(async (sql) => {
    const left = await sql.run(
      "delete from catalyst_kb.ingest_waiting where sync_run_id=$1::text returning sync_run_id",
      [payload.syncRunId]
    );
    if (!left.length) return;
    await forgetPassRows(sql, payload.syncRunId);
    const { operationRunId } = payload;
    if (isOperationRunId(operationRunId))
      await control.transaction((stores) =>
        stores.operationRuns.finish({
          clientInstanceId: runtime.data.clientInstanceId,
          id: operationRunId,
          end: {
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: {
              code: "knowledge_ingest_cancelled",
              message: "The Workflow run ended before its turn to put documents in"
            }
          }
        })
      );
  });
  return true;
}

/** A run that ended in any way but `done`, or is gone, ends the pass: what it wrote stays. */
async function workflowRunGone(runtime: SourceJobRuntime, workflowRunId: string) {
  const run = await runtime.data.stores.workflowRuns.readRun({
    clientInstanceId: runtime.data.clientInstanceId,
    id: workflowRunId
  });
  return !run || (isWorkflowRunEnded(run.status) && run.status !== "done");
}

/**
 * Ends a running pass `failed`: `knowledge_ingest_cancelled` where its run ended first,
 * `knowledge_source_refused` where its account may no longer write. What it wrote stays, and a
 * complete pass withdraws nothing.
 */
async function cancelPass(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  code: "knowledge_ingest_cancelled" | "knowledge_source_refused" = "knowledge_ingest_cancelled"
) {
  await sourceTransaction(runtime.data, payload, control, async (store) => {
    await store.change(async (sql) => {
      await sql.run(
        "update catalyst_kb.sync_runs set pass_state=case when complete then 'dropped' end where id=$1::text and state='running'",
        [payload.syncRunId]
      );
      await forgetPassRows(sql, payload.syncRunId);
    });
    await store.finish(payload, code);
  });
}

/** What a pass keeps only while it runs: its inline items and its failure rows. */
async function forgetPassRows(sql: Pick<PostgresChangeStatements, "run">, syncRunId: string) {
  await sql.run("delete from catalyst_kb.ingest_items where sync_run_id=$1::text", [syncRunId]);
  await sql.run("delete from catalyst_kb.ingest_failures where sync_run_id=$1::text", [syncRunId]);
}

/** One page of the items a call named inline, in their order. */
async function inlinePage(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  offset: number
): Promise<unknown[]> {
  const rows = z
    .array(z.object({ item: z.json() }))
    .parse(
      await createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal).change((sql) =>
        sql.run(
          "select item from catalyst_kb.ingest_items where sync_run_id=$1::text and position>=$2::int order by position limit $3::int",
          [payload.syncRunId, offset, INGEST_PAGE_ROWS]
        )
      )
    );
  return rows.map((row) => row.item);
}

/** Reads, writes and settles a running pass. Answers whether it ended now. */
async function readPass(
  runtime: SourceJobRuntime,
  job: { id: string; payload: KnowledgeSyncJobPayload },
  control: JobControl,
  run: IngestRun
): Promise<boolean> {
  const { payload } = job;
  const datasets = runtime.data.workflowDatasets;
  let progress = progressOf(run);
  if (!progress.complete) {
    if (run.dataset && !datasets)
      throw new AppError("CONFLICT", "Ingestion needs the instance's dataset storage");
    while (!progress.complete) {
      control.signal.throwIfAborted();
      // A copy a killed worker left is found by the cleanup the fetch job queues per batch.
      await enqueueKnowledgeFileCleanup(
        {
          clientInstanceId: runtime.data.clientInstanceId,
          stores: runtime.data.stores,
          now: () => new Date()
        },
        {
          backend: "builtin",
          assetId: payload.knowledgeBaseId,
          name: payload.knowledgeBaseId,
          methods: []
        }
      );
      if (await workflowRunGone(runtime, run.workflow_run_id)) {
        await cancelPass(runtime, payload, control);
        return false;
      }
      // The account is asked before every page, the first among them: a right taken away
      // stops the pass at the next page.
      const account = await workflowAccount(runtime, payload, run.workflow_run_id);
      if (!account.write) {
        await cancelPass(runtime, payload, control, "knowledge_source_refused");
        return false;
      }
      const rows: unknown[] =
        run.dataset && datasets
          ? await datasets.read({
              workflowRunId: run.workflow_run_id,
              reference: run.dataset,
              offset: progress.offset,
              limit: INGEST_PAGE_ROWS,
              signal: control.signal
            })
          : await inlinePage(runtime, payload, control, progress.offset);
      const usable = new Set<string>();
      for (const row of rows) {
        const connection = isObject(row) && isObject(row.fetch) ? row.fetch.connection : undefined;
        if (typeof connection === "string" && (await account.uses(connection)))
          usable.add(connection);
      }
      const classified = rows.map((row, index) =>
        classify(row, progress.offset + index, [...usable])
      );
      const written = await writePage(runtime, job, control, progress, classified);
      if (written === undefined) return false;
      for (const item of written) await writeContent(runtime, job, control, item);
      const end = progress.offset + rows.length;
      progress = {
        ...progress,
        offset: end,
        counted: Math.max(progress.counted, end),
        // A dataset is read to its row count, never to a short page: a pass that took a short
        // read for the end would withdraw what it never read.
        complete:
          run.dataset !== null ? end >= run.dataset.rowCount : rows.length < INGEST_PAGE_ROWS
      };
      if (run.dataset !== null && rows.length === 0 && !progress.complete)
        throw new AppError("CONFLICT", "The dataset ended before its row count", {
          reason: "dataset_reference_invalid"
        });
      const next = JSON.stringify(progress);
      await createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal).change(
        async (sql) => {
          await sql.run(
            "update catalyst_kb.sync_runs set cursor_after=$2::text where id=$1::text and state='running'",
            [payload.syncRunId, next]
          );
          // Inline items are kept only until their pass has read them.
          if (progress.complete)
            await sql.run("delete from catalyst_kb.ingest_items where sync_run_id=$1::text", [
              payload.syncRunId
            ]);
        }
      );
    }
  }
  if (await workflowRunGone(runtime, run.workflow_run_id)) {
    await cancelPass(runtime, payload, control);
    return false;
  }
  const open = await createSourceStore(
    runtime.data,
    payload.knowledgeBaseId,
    control.signal
  ).change(
    async (sql) =>
      (
        await sql.run(
          "select 1 from catalyst_kb.source_items where source_id=$1::text and seen_run_id=$2::text and open_change_at is not null limit 1",
          [payload.sourceId, payload.syncRunId]
        )
      ).length > 0
  );
  if (open) {
    await again(
      runtime,
      control,
      payload,
      waitFor(run.started_at, SETTLE_WAIT_MIN_MS, SETTLE_WAIT_MAX_MS, 20)
    );
    return false;
  }
  return finishPass(runtime, payload, control);
}

type Written = { item: SourceItem; text: string; format: KnowledgeDocumentFormat };

/**
 * Writes the items of one page into `source_items` under the source's locks, and answers the
 * ones whose text is to be written. Nothing where the pass no longer runs.
 */
async function writePage(
  runtime: SourceJobRuntime,
  job: { id: string; payload: KnowledgeSyncJobPayload },
  control: JobControl,
  progress: IngestProgress,
  classified: Classified[]
): Promise<Written[] | undefined> {
  const { payload } = job;
  const valid = classified.flatMap((entry) => (entry.ok ? [entry] : []));
  return sourceTransaction(runtime.data, payload, control, (store) =>
    store.change(async (sql) => {
      const run = await readIngestRun(sql, payload.syncRunId, true);
      if (!run || run.state !== "running") return undefined;
      // Admission shares add_files' and the listing's writer lock: no source exceeds the cap.
      await sql.run("lock table catalyst_kb.source_items in share row exclusive mode");
      const [count] = z
        .array(countSchema)
        .parse(
          await sql.run(
            `select ((select coalesce(sum(items),0) from catalyst_kb.source_counts where state <> 'withdrawn') + (select count(*) from catalyst_kb.documents where source_item_id is null and withdrawn_at is null))::int as n`
          )
        );
      // Content locks first, as an index completion takes them: a count delta below cannot
      // invert that order.
      await sql.run(
        "select c.sha256 from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 join catalyst_kb.source_items i on i.document_id=d.id where i.source_id=$1::text and i.item_id=any($2::text[]) order by c.sha256 for share of c",
        [payload.sourceId, valid.map((entry) => entry.item.itemId)]
      );
      let held = count?.n ?? 0;
      const counts = { discovered: 0, changed: 0, skipped: 0, accepted: 0 };
      const writes: Written[] = [];
      const failures = classified.flatMap((entry) =>
        entry.ok ? [] : [{ position: entry.position, failure: entry.failure }]
      );
      for (const { item, position } of valid) {
        const id = sourceItemId(payload.sourceId, item.itemId);
        const [old] = z
          .array(
            z.object({
              version: z.string(),
              state: z.string(),
              document_id: z.string().nullable(),
              content_state: z.string().nullable()
            })
          )
          .parse(
            await sql.run(
              "select i.version,i.state,i.document_id,c.state as content_state from catalyst_kb.source_items i left join catalyst_kb.documents d on d.id=i.document_id left join catalyst_kb.contents c on c.sha256=d.content_sha256 where i.id=$1::text",
              [id]
            )
          );
        const fresh = !old || old.state === "withdrawn";
        if (fresh && held >= runtime.input.maxDocuments) {
          failures.push({
            position,
            failure: {
              item: identityOf(item),
              code: "knowledge_source_limit_reached",
              message: "knowledge_source_limit_reached: itemId"
            }
          });
          continue;
        }
        if (fresh) held++;
        counts.accepted++;
        // A failed item named again at the same version is written again: that is its Retry.
        const same =
          old !== undefined &&
          old.version === item.version &&
          old.state === "fetched" &&
          old.content_state !== "failed";
        const { format, mime } = textFormat(item.name);
        const path = item.path ?? `/${item.name}`;
        const size = Buffer.byteLength(item.text);
        await sql.run(
          `insert into catalyst_kb.source_items
            (id,source_id,item_id,version,path,name,mime,size,modified_at,origin_link,state,seen_run_id,named_run_id,enqueued_run_id,fetch_job_id)
           values ($1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint,now(),$9::text,'discovered',$10::text,$10::text,$10::text,$11::text)
           on conflict (source_id,item_id) do update set seen_run_id=excluded.seen_run_id,named_run_id=excluded.named_run_id,withdrawn_at=null,purged_at=null,
             version=excluded.version,path=excluded.path,name=excluded.name,mime=excluded.mime,size=excluded.size,
             modified_at=case when $12::boolean then source_items.modified_at else excluded.modified_at end,
             origin_link=excluded.origin_link,
             state=case when $12::boolean then source_items.state else 'discovered' end,
             failure_code=case when $12::boolean then source_items.failure_code else null end,
             attempts=case when $12::boolean then source_items.attempts else 0 end,
             enqueued_run_id=case when $12::boolean then source_items.enqueued_run_id else excluded.enqueued_run_id end,
             fetch_job_id=case when $12::boolean then source_items.fetch_job_id else excluded.fetch_job_id end,
             changed_at=case when source_items.version <> excluded.version or source_items.path <> excluded.path or source_items.name <> excluded.name or source_items.state <> 'fetched' then now() else source_items.changed_at end`,
          [
            id,
            payload.sourceId,
            item.itemId,
            item.version,
            path,
            item.name,
            mime,
            size,
            item.originLink ?? null,
            payload.syncRunId,
            job.id,
            same
          ]
        );
        if (same) {
          counts.skipped++;
          if (old.document_id)
            await sql.run(
              "update catalyst_kb.documents set title=$2::text,file_name=$2::text,origin_link=$3::text where id=$1::text",
              [old.document_id, item.name, item.originLink ?? null]
            );
          continue;
        }
        if (fresh) counts.discovered++;
        else counts.changed++;
        writes.push({
          item: {
            id,
            item_id: item.itemId,
            version: item.version,
            name: item.name,
            path,
            mime,
            size,
            state: "discovered",
            attempts: 0,
            document_id: old?.document_id ?? null,
            origin_link: item.originLink ?? null,
            enqueued_run_id: payload.syncRunId,
            fetch_job_id: job.id
          },
          text: item.text,
          format
        });
      }
      // An item the pass named but could not take keeps the version it has: the pass named it,
      // so its complete pass does not withdraw it as unnamed.
      const namedInvalid = failures.flatMap(({ failure }) =>
        isObject(failure.item) && typeof failure.item.itemId === "string"
          ? [failure.item.itemId]
          : []
      );
      if (namedInvalid.length)
        await sql.run(
          "update catalyst_kb.source_items set named_run_id=$3::text where source_id=$1::text and item_id=any($2::text[]) and state<>'withdrawn'",
          [payload.sourceId, namedInvalid, payload.syncRunId]
        );
      for (const { position, failure } of failures)
        await sql.run(
          "insert into catalyst_kb.ingest_failures (sync_run_id,position,item,code,message) values ($1::text,$2::int,$3::jsonb,$4::text,$5::text) on conflict do nothing",
          [payload.syncRunId, position, JSON.stringify(failure.item), failure.code, failure.message]
        );
      // A page read again after a lost lease writes the same rows and adds no count.
      const end = (classified.at(-1)?.position ?? progress.offset - 1) + 1;
      if (end > progress.counted) {
        await sql.run(
          "update catalyst_kb.sync_runs set discovered=discovered+$2::int,changed=changed+$3::int,skipped=skipped+$4::int,accepted=accepted+$5::int,cursor_after=$6::text where id=$1::text",
          [
            payload.syncRunId,
            counts.discovered,
            counts.changed,
            counts.skipped,
            counts.accepted,
            JSON.stringify({ ...progress, counted: end })
          ]
        );
      }
      return writes;
    })
  );
}

/** SRC-1a's writer for one item: a copy the Knowledge Base owns, `fetched`, then the index job. */
async function writeContent(
  runtime: SourceJobRuntime,
  job: { id: string; payload: KnowledgeSyncJobPayload },
  control: JobControl,
  { item, text, format }: Written
) {
  const { payload } = job;
  const bytes = Buffer.from(text, "utf8");
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const copy = await control.transaction((stores) =>
    stores.files.createManagedFile({
      clientInstanceId: runtime.data.clientInstanceId,
      ownerUserId: payload.knowledgeBaseId,
      owner: { kind: "knowledge_base", id: payload.knowledgeBaseId },
      filename: item.name,
      mimeType: item.mime,
      byteSize: bytes.length,
      checksum: contentSha256,
      objectKey: `knowledge-bases/${payload.knowledgeBaseId}/${createPlatformId("kbobj")}`
    })
  );
  let adopted = false;
  try {
    await runtime.input.files.objects.put(copy.objectKey, bytes, {
      contentType: item.mime,
      size: bytes.length
    });
    control.signal.throwIfAborted();
    adopted = await sourceTransaction(runtime.data, payload, control, (store) =>
      store.fetched(
        payload,
        item,
        {
          id: item.document_id ?? createPlatformId("kbdoc"),
          fileId: copy.id,
          contentSha256,
          format,
          title: item.name,
          fileName: item.name,
          ...(item.origin_link ? { originLink: item.origin_link } : {}),
          sourceItemId: item.id
        },
        bytes.length,
        job.id
      )
    );
  } catch (error) {
    await releaseCopy(runtime, payload, copy.id).catch(() => {
      runtime.data.logger.warn(
        { knowledgeBaseId: payload.knowledgeBaseId },
        "An ingest copy's cleanup will be retried"
      );
    });
    throw error;
  }
  if (!adopted) {
    await releaseCopy(runtime, payload, copy.id);
    return;
  }
  // The text stays with the document: there is no source to fetch it from again (KB-13a).
  const content = await createSourceStore(
    runtime.data,
    payload.knowledgeBaseId,
    control.signal
  ).indexPayload(item.id);
  if (content?.state === "pending")
    await control.transaction((stores) =>
      enqueueKnowledgeIndex(stores.jobs, knowledgeIndexPayloadOfFetch(payload, content), {
        clientInstanceId: runtime.data.clientInstanceId,
        dedupe: true
      })
    );
}

/** The ids of the source's items the Workflow run did not name, validly or not: what its
 * complete pass withdraws. A pass of a later run that named an item counts as naming it. */
const UNNAMED = `from catalyst_kb.source_items i where i.source_id=$1::text and i.state<>'withdrawn'
  and (i.named_run_id is null or i.named_run_id not in (
    select r.id from catalyst_kb.sync_runs r where r.source_id=$1::text and r.mode='ingest'
      and r.started_at >= (select min(f.started_at) from catalyst_kb.sync_runs f where f.workflow_run_id=$2::text and f.source_id=$1::text)))`;

async function unnamedCount(
  sql: Pick<PostgresChangeStatements, "run">,
  sourceId: string,
  workflowRunId: string
) {
  const [row] = z
    .array(z.object({ total: z.coerce.number(), missing: z.coerce.number() }))
    .parse(
      await sql.run(
        `select (select count(*) from catalyst_kb.source_items where source_id=$1::text and state<>'withdrawn') as total, (select count(*) ${UNNAMED}) as missing`,
        [sourceId, workflowRunId]
      )
    );
  return row ?? { total: 0, missing: 0 };
}

const STATE = `case when i.state='fetched' then case c.state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end else i.state end`;
const FAILURE = `case when i.state='failed' then i.failure_code when i.state='fetched' and c.state='failed' then c.failure_code end`;
const JOIN = `from catalyst_kb.source_items i left join catalyst_kb.documents d on d.id=i.document_id left join catalyst_kb.contents c on c.sha256=d.content_sha256`;

/** The failures of the pass in order: items that never became a row, then failed items. */
async function* failureRows(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  signal: AbortSignal
): AsyncIterable<JsonObject> {
  const store = createSourceStore(runtime.data, payload.knowledgeBaseId, signal);
  let position = -1;
  for (;;) {
    const rows = z
      .array(
        z.object({
          position: z.number(),
          item: z.record(z.string(), z.json()),
          code: z.string(),
          message: z.string()
        })
      )
      .parse(
        await store.change((sql) =>
          sql.run(
            "select position,item,code,message from catalyst_kb.ingest_failures where sync_run_id=$1::text and position>$2::int order by position limit $3::int",
            [payload.syncRunId, position, INGEST_PAGE_ROWS]
          )
        )
      );
    for (const row of rows)
      yield operationBatchFailureSchema.parse({
        item: row.item,
        code: row.code,
        message: row.message
      });
    if (rows.length < INGEST_PAGE_ROWS) break;
    position = rows.at(-1)?.position ?? position;
  }
  let after = "";
  for (;;) {
    const rows = z
      .array(
        z.object({
          id: z.string(),
          item_id: z.string(),
          version: z.string(),
          name: z.string(),
          path: z.string(),
          origin_link: z.string().nullable(),
          code: z.string()
        })
      )
      .parse(
        await store.change((sql) =>
          sql.run(
            `select i.id,i.item_id,i.version,i.name,i.path,i.origin_link,${FAILURE} as code ${JOIN} where i.source_id=$1::text and i.seen_run_id=$2::text and ${STATE}='failed' and i.id>$3::text order by i.id limit $4::int`,
            [payload.sourceId, payload.syncRunId, after, INGEST_PAGE_ROWS]
          )
        )
      );
    for (const row of rows)
      yield {
        item: {
          itemId: row.item_id,
          version: row.version,
          name: row.name,
          path: row.path,
          ...(row.origin_link ? { originLink: row.origin_link } : {})
        },
        code: row.code,
        message: `${row.code}: itemId`
      };
    if (rows.length < INGEST_PAGE_ROWS) break;
    after = rows.at(-1)?.id ?? after;
  }
}

const failureRowSchema = z
  .record(z.string(), z.json())
  .parse(z.toJSONSchema(operationBatchFailureSchema));

/**
 * Ends the Operation Run once every item has ended, with the per-item outcomes as a dataset of
 * the step run. A complete pass then waits for its Workflow run's end.
 */
async function finishPass(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl
): Promise<boolean> {
  const datasets = runtime.data.workflowDatasets;
  if (!datasets) throw new AppError("CONFLICT", "Ingestion needs the instance's dataset storage");
  const call = isOperationRunId(payload.operationRunId)
    ? await runtime.data.stores.operationRuns.get({
        clientInstanceId: runtime.data.clientInstanceId,
        id: payload.operationRunId
      })
    : undefined;
  if (call?.origin.kind !== "workflow") {
    await cancelPass(runtime, payload, control);
    return false;
  }
  const failures = await datasets.write({
    workflowRunId: call.origin.workflowRunId,
    stepRunId: call.origin.stepRunId,
    field: `knowledge.ingest.failures.${payload.syncRunId}`,
    rowSchema: failureRowSchema,
    rows: failureRows(runtime, payload, control.signal),
    signal: control.signal
  });
  return sourceTransaction(runtime.data, payload, control, (store, stores) =>
    store.change(async (sql) => {
      const held = await readIngestRun(sql, payload.syncRunId, true);
      if (!held || held.state !== "running") return false;
      const [done] = z
        .array(countSchema)
        .parse(
          await sql.run(
            `select count(*)::int as n ${JOIN} where i.source_id=$1::text and i.seen_run_id=$2::text and ${STATE}='indexed'`,
            [payload.sourceId, payload.syncRunId]
          )
        );
      const withdrawn = held.complete
        ? (await unnamedCount(sql, payload.sourceId, held.workflow_run_id)).missing
        : 0;
      const [ended] = await sql.run(
        `update catalyst_kb.sync_runs set state='done',failed=$2::int,ended_at=now(),
           pass_state=case when complete then 'awaiting_run' end,
           cursor_after=$3::text where id=$1::text and state='running' returning *`,
        [
          payload.syncRunId,
          failures.rowCount,
          JSON.stringify({ ...progressOf(held), complete: true })
        ]
      );
      if (!ended) return false;
      // Its failures are the step's dataset now, and every item has been read.
      await forgetPassRows(sql, payload.syncRunId);
      const output: KnowledgeIngestOutput = {
        accepted: held.accepted,
        done: done?.n ?? 0,
        failed: failures.rowCount,
        failures,
        withdrawn
      };
      await settleIngest(stores, runtime, payload, output, syncResult(ended));
      return true;
    })
  );
}

async function settleIngest(
  stores: PlatformStores,
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  output: KnowledgeIngestOutput,
  result: ReturnType<typeof syncResult>
) {
  if (!isOperationRunId(payload.operationRunId)) return;
  await stores.operationRuns.finish({
    clientInstanceId: runtime.data.clientInstanceId,
    id: payload.operationRunId,
    end: {
      status: "done",
      finishedAt: result.endedAt ?? new Date().toISOString(),
      output: { value: output }
    }
  });
  await stores.audit.appendAuditEvent({
    clientInstanceId: runtime.data.clientInstanceId,
    type: "knowledge_base.sync_finished",
    status: "success",
    subject: payload.knowledgeBaseId,
    correlationId: payload.operationRunId,
    metadata: { ...result }
  });
}

async function setPass(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  state: "applied" | "dropped"
) {
  await createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal).change((sql) =>
    sql.run(
      "update catalyst_kb.sync_runs set pass_state=$2::text where id=$1::text and pass_state in ('awaiting_run','confirming')",
      [payload.syncRunId, state]
    )
  );
}

/** The Knowledge Base by its id, for the confirmation's subject. */
async function knowledgeBaseOf(runtime: SourceJobRuntime, id: string, stores: PlatformStores) {
  const record = await stores.dataStores.getDataStore({
    clientInstanceId: runtime.data.clientInstanceId,
    id
  });
  if (!record?.ownerKnowledgeBaseId) return undefined;
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.data.clientInstanceId,
    kind: "knowledge_base",
    name: record.ownerKnowledgeBaseId,
    lock: "share"
  });
  return asset && asset.id === id && asset.status === "active" ? asset : undefined;
}

/**
 * The completeness rule of a `complete` pass. Its Workflow run must have ended `done`, with no
 * pass of that run still reading; the newest complete pass of the run decides for all of them.
 */
async function completePass(
  runtime: SourceJobRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  run: IngestRun
) {
  const workflowRun = await runtime.data.stores.workflowRuns.readRun({
    clientInstanceId: runtime.data.clientInstanceId,
    id: run.workflow_run_id
  });
  if (workflowRun && !isWorkflowRunEnded(workflowRun.status)) {
    await again(
      runtime,
      control,
      payload,
      waitFor(run.ended_at ?? run.started_at, PASS_WAIT_MIN_MS, PASS_WAIT_MAX_MS, 10)
    );
    return;
  }
  if (workflowRun?.status !== "done") {
    await setPass(runtime, payload, control, "dropped");
    return;
  }
  const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
  const siblings = z
    .array(z.object({ id: z.string(), state: z.string(), complete: z.boolean() }))
    .parse(
      await store.change((sql) =>
        sql.run(
          // A pass that waits for its turn counts as running, and as the newest.
          `select id,state,complete from (
             select id,state,complete,started_at from catalyst_kb.sync_runs where workflow_run_id=$1::text and source_id=$2::text
             union all
             select sync_run_id,'running',complete,now() from catalyst_kb.ingest_waiting where workflow_run_id=$1::text and source_id=$2::text
           ) passes order by started_at desc,id desc`,
          [run.workflow_run_id, payload.sourceId]
        )
      )
    );
  if (siblings.some((sibling) => sibling.state === "running")) {
    await again(runtime, control, payload, SETTLE_WAIT_MAX_MS);
    return;
  }
  // A pass of the run that did not end done read only part of what the run named, though the
  // run itself went on: the run's promise of completeness no longer holds.
  if (
    siblings.some((sibling) => sibling.state !== "done") ||
    siblings.find((sibling) => sibling.complete)?.id !== payload.syncRunId
  ) {
    await setPass(runtime, payload, control, "dropped");
    return;
  }
  const decision = await sourceTransaction(runtime.data, payload, control, (store, stores) =>
    store.change(async (sql): Promise<"apply" | "wait" | "drop" | "settled"> => {
      const held = await readIngestRun(sql, payload.syncRunId, true);
      if (held?.pass_state !== "awaiting_run" && held?.pass_state !== "confirming")
        return "settled";
      const knowledgeBase = await knowledgeBaseOf(runtime, payload.knowledgeBaseId, stores);
      if (!knowledgeBase) return "drop";
      if (held.approval_request_id) {
        const request = await stores.approvals.getApprovalRequest({
          clientInstanceId: runtime.data.clientInstanceId,
          requestId: held.approval_request_id
        });
        if (request?.status === "approved") return "apply";
        return request === undefined || request.status === "pending" ? "wait" : "drop";
      }
      const counts = await unnamedCount(sql, payload.sourceId, held.workflow_run_id);
      const share = runtime.input.withdrawShareConfirm ?? DEFAULT_WITHDRAW_SHARE_CONFIRM;
      if (counts.missing === 0 || counts.missing <= counts.total * share) return "apply";
      const request = await stores.approvals.createApprovalRequest({
        clientInstanceId: runtime.data.clientInstanceId,
        kind: SOURCE_WITHDRAWAL_APPROVAL,
        summary: `Confirm withdrawal of ${counts.missing} of ${counts.total} items from ${knowledgeBase.name}/${payload.sourceId}`,
        requestedBy: { id: asUserId(payload.knowledgeBaseId), displayLabel: "Knowledge Base sync" },
        payload: {
          ...payload,
          boundaryKey: createHash("sha256").update(payload.sourceId).digest("hex"),
          subject: {
            kind: "knowledge_base",
            assetId: payload.knowledgeBaseId,
            syncRunId: payload.syncRunId,
            name: knowledgeBase.name,
            ...(knowledgeBase.scope.kind === "workspace"
              ? { workspaceId: knowledgeBase.scope.workspaceId }
              : {})
          },
          withdrawn: counts.missing,
          total: counts.total
        }
      });
      await sql.run(
        "update catalyst_kb.sync_runs set pass_state='confirming',approval_request_id=$2::text where id=$1::text",
        [payload.syncRunId, request.id]
      );
      return request.status === "approved" ? "apply" : "wait";
    })
  );
  if (decision === "settled") return;
  // A decision wakes the pass; a confirmation that ends without one is looked at again.
  if (decision === "wait") {
    await again(runtime, control, payload, PASS_WAIT_MAX_MS);
    return;
  }
  if (decision === "drop") {
    await setPass(runtime, payload, control, "dropped");
    return;
  }
  for (;;) {
    // The account still writes the Knowledge Base, or the pass withdraws nothing more: a
    // Workflow whose right was taken away keeps its documents until a person removes them.
    if (!(await workflowAccount(runtime, payload, run.workflow_run_id)).write) {
      await setPass(runtime, payload, control, "dropped");
      return;
    }
    const more = await sourceTransaction(runtime.data, payload, control, (store, stores) =>
      store.change(async (sql) => {
        const held = await readIngestRun(sql, payload.syncRunId, true);
        if (held?.pass_state !== "awaiting_run" && held?.pass_state !== "confirming") return false;
        const ids = idsSchema
          .parse(
            await sql.run(`select i.id ${UNNAMED} order by i.id limit $3::int`, [
              payload.sourceId,
              held.workflow_run_id,
              INGEST_WITHDRAWAL_BATCH
            ])
          )
          .map((row) => row.id);
        if (!ids.length) {
          await sql.run("update catalyst_kb.sync_runs set pass_state='applied' where id=$1::text", [
            payload.syncRunId
          ]);
          return false;
        }
        const withdrawn = await withdrawSourceItems(
          sql,
          stores,
          runtime.data,
          { ...payload, syncRunId: "" },
          ids
        );
        await sql.run(
          "update catalyst_kb.sync_runs set withdrawn=withdrawn+$2::int where id=$1::text",
          [payload.syncRunId, withdrawn]
        );
        return true;
      })
    );
    if (!more) return;
  }
}

/** A pass whose job used up its attempts withdraws nothing. */
export async function dropExhaustedPass(
  runtime: DataStoreRuntime,
  stores: PlatformStores,
  payload: KnowledgeSyncJobPayload
) {
  await createSourceStore(
    runtime,
    payload.knowledgeBaseId,
    new AbortController().signal,
    stores
  ).change(async (sql) => {
    await sql.run(
      "update catalyst_kb.sync_runs set pass_state='dropped' where id=$1::text and mode='ingest' and pass_state in ('awaiting_run','confirming')",
      [payload.syncRunId]
    );
    const [ended] = await sql.run(
      "select 1 from catalyst_kb.sync_runs where id=$1::text and mode='ingest' and state<>'running'",
      [payload.syncRunId]
    );
    const waited = await sql.run(
      "delete from catalyst_kb.ingest_waiting where sync_run_id=$1::text returning sync_run_id",
      [payload.syncRunId]
    );
    if (ended || waited.length) await forgetPassRows(sql, payload.syncRunId);
    // A pass that never got its turn ends its call as a source that did not answer.
    if (waited.length && isOperationRunId(payload.operationRunId))
      await stores.operationRuns.finish({
        clientInstanceId: runtime.clientInstanceId,
        id: payload.operationRunId,
        end: {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: {
            code: "knowledge_source_unreachable",
            message: "The Knowledge Base source sync failed"
          }
        }
      });
  });
}
