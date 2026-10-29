import { z } from "zod";
import type { ClientInstanceId } from "./ids";
import { defineJobKind, type JobsStore } from "./jobs";
import {
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_JOB_KINDS,
  type KnowledgeContentJobPayload,
  type KnowledgeDocumentInput
} from "./knowledge";

// The contract of a synced source of a Knowledge Base, frozen before the slices that build it
// (SRC-0): the job kinds and their payloads, the handoff of a fetched item into the jobs of
// KB-5c, and the operations of a source with their input and output. Nothing here runs: the
// handlers are SRC-1a's, the operations SRC-1b's. The calls the jobs make to the outside
// system are the `document_source` capability (`document-source.ts`). Spec:
// data-stores-and-knowledge-bases.md, Synced sources, document processing and records.
//
// The handoff of one fetched item, in the fetch job (`knowledge_base.fetch`):
//
//   1. The bytes are streamed through the connector's `fetch` into the instance's store of
//      files under the size cap and hashed while they stream.
//   2. One transaction writes, as `add_files` does: the content row of the hash, where it is
//      new; the document row with `source_item_id` set to the item's row; a Managed File the
//      Knowledge Base owns as the document's file; the item `fetched` with its `document_id`.
//   3. `enqueueKnowledgeIndex` queues the index job of the content with
//      `knowledgeIndexPayloadOfFetch`: its run is the sync's Operation Run.
//
// From there the content goes through KB-5c's jobs as a file added by hand does, with one
// difference: a content of a synced source emits no `knowledge_base.content_indexed`. A sync is
// audited per run with counts, never per content.
//
// Sensitive data. Payloads, run results and audit events carry ids, counts and codes, never a
// file name, path or title. `source_items` and `locate` answer names and paths to holders of
// `knowledge_base.read`, as `list_documents` does.

/**
 * The job that walks one source: `list` for modes `initial` and `full`, `changes` for mode
 * `changes`. It writes `source_items` page by page, the cursor in the same transaction as its
 * page, and queues fetch batches. One per source at a time: queue it with
 * `knowledgeSourceKey` as its concurrency key.
 */
export const KNOWLEDGE_BASE_SYNC_JOB_KIND = KNOWLEDGE_JOB_KINDS.sync;

/** The job that fetches one batch of items of a source and hands each to the index job. */
export const KNOWLEDGE_BASE_FETCH_JOB_KIND = KNOWLEDGE_JOB_KINDS.fetch;

/** How many items one fetch job carries at most. */
export const KNOWLEDGE_FETCH_BATCH_MAX_ITEMS = 200;

const jobIdSchema = z.string().min(1).max(200);

/**
 * What a sync job carries: ids only. The mode, the cursor and the counts are on its row in
 * `sync_runs`. `sourceId` is the `id` of the entry under `sources` in the definition.
 */
export const knowledgeSyncJobPayloadSchema = z.strictObject({
  /** The id of the Knowledge Base's asset, which is also the id of the store it owns. */
  knowledgeBaseId: jobIdSchema,
  sourceId: jobIdSchema,
  /** Its row in `sync_runs`. */
  syncRunId: jobIdSchema,
  /** The Operation Run of the sync, which records every call to the source as counts. */
  operationRunId: jobIdSchema
});

export type KnowledgeSyncJobPayload = z.infer<typeof knowledgeSyncJobPayloadSchema>;

/** What a fetch job carries: the sync's ids and the rows in `source_items` of its batch. */
export const knowledgeFetchJobPayloadSchema = knowledgeSyncJobPayloadSchema.extend({
  sourceItemIds: z.array(jobIdSchema).min(1).max(KNOWLEDGE_FETCH_BATCH_MAX_ITEMS)
});

export type KnowledgeFetchJobPayload = z.infer<typeof knowledgeFetchJobPayloadSchema>;

/** The key a sync of one source runs under: one at a time per source. */
export function knowledgeSourceKey(knowledgeBaseId: string, sourceId: string): string {
  return `${knowledgeBaseId}:${sourceId}`;
}

/** The sync job. Its writes are idempotent by item and version, so a rerun resumes. */
export const knowledgeSyncJob = defineJobKind({
  kind: KNOWLEDGE_BASE_SYNC_JOB_KIND,
  payloadSchema: knowledgeSyncJobPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
  leaseMs: 5 * 60_000,
  concurrency: { perKey: 1 }
});

/**
 * The fetch job. An item is attempted 3 times, counted on its row, then fails with
 * `knowledge_fetch_failed`; a failed item never fails its batch.
 */
export const knowledgeFetchJob = defineJobKind({
  kind: KNOWLEDGE_BASE_FETCH_JOB_KIND,
  payloadSchema: knowledgeFetchJobPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
  leaseMs: 5 * 60_000,
  concurrency: { global: 4 }
});

/**
 * KBW-2c: a deleted Workflow's source ends in every Knowledge Base it fed. The delete queues
 * this in its transaction; the job withdraws every item of each source of `workflow` whose
 * creating revision is at most `through`, which a Workflow created later under the name never
 * is, and of each the release before keyed without one; the purge follows on the usual
 * deadline. `0` ends only those.
 */
export const knowledgeWorkflowSourceEndJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.endWorkflowSource,
  payloadSchema: z.strictObject({
    workflow: z.string().min(1).max(63),
    through: z.number().int().nonnegative()
  }),
  maxAttempts: 10,
  backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
  leaseMs: 5 * 60_000,
  concurrency: { perKey: 1 }
});

/** Queues the end of a deleted Workflow's sources, in the transaction of its delete. */
export function enqueueKnowledgeWorkflowSourceEnd(
  jobs: Pick<JobsStore, "enqueue">,
  input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    through: number;
    correlationId: string;
  }
): Promise<unknown> {
  return jobs.enqueue(
    knowledgeWorkflowSourceEndJob,
    { workflow: input.workflow, through: input.through },
    {
      clientInstanceId: input.clientInstanceId,
      concurrencyKey: `workflow:${input.workflow}`,
      correlationId: input.correlationId
    }
  );
}

/**
 * How many items the first pass of a source fetches and indexes before it waits for one
 * confirmation, where it holds more (KB-ISO-1b): a connector's first sync or a Workflow's first
 * `ingest`. A constant equal to the default of `knowledge.maxDocuments`, not a setting.
 */
export const KNOWLEDGE_FIRST_PASS_STOP = 10_000;

/**
 * The fetch window of a Knowledge Base (KB-ISO-3b): at most this many fetched items, and at
 * most `KNOWLEDGE_FETCH_WINDOW_BYTES` of them, whose content has not yet left `pending`. A fetch
 * batch that finds it full queues its rest after `KNOWLEDGE_FETCH_WINDOW_WAIT_MS` and spends no
 * attempt, which bounds the object store and the spool while indexing is paused or slower than
 * fetching. Constants, not settings.
 */
export const KNOWLEDGE_FETCH_WINDOW_ITEMS = 2_000;

/** The bytes of the fetch window, by the sizes the source listed: 2 GiB. */
export const KNOWLEDGE_FETCH_WINDOW_BYTES = 2 * 1024 ** 3;

/** How long the rest of a fetch batch that found the window full waits. */
export const KNOWLEDGE_FETCH_WINDOW_WAIT_MS = 60_000;

/** How often the fetch of one item is attempted before it fails with `knowledge_fetch_failed`. */
export const KNOWLEDGE_FETCH_MAX_ATTEMPTS = 3;

/**
 * The document a fetch job writes for one item, in the transaction of step 2 above. Its title
 * and file name are the item's name; a move or rename later changes them and nothing else.
 */
export interface KnowledgeFetchedDocument extends KnowledgeDocumentInput {
  /** The item's row in `source_items`: `documents.source_item_id`. */
  sourceItemId: string;
  /** The item's `originLink`, where the source names one. */
  originLink?: string;
}

/**
 * The index job's payload for a content a fetch job wrote: the run is the sync's, so the usage
 * of indexing a synced item goes to the sync's Operation Run.
 */
export function knowledgeIndexPayloadOfFetch(
  fetch: Pick<KnowledgeFetchJobPayload, "knowledgeBaseId" | "operationRunId">,
  content: { contentSha256: string; fileId: string }
): KnowledgeContentJobPayload {
  return {
    knowledgeBaseId: fetch.knowledgeBaseId,
    contentSha256: content.contentSha256,
    fileId: content.fileId,
    operationRunId: fetch.operationRunId
  };
}

// The operations of a source. Each is `knowledge.<id>.<part>`, as KB-5c's are; its HTTP route
// resolves to it. SRC-1b registers them.

/** The parts of the operations of a source, with effect and right. */
export const KNOWLEDGE_SOURCE_OPERATIONS = {
  /**
   * Starts a sync of one source and answers its Operation Run at once (`completion: async`).
   * A start while a sync of that source runs joins it. The run ends with
   * `knowledgeSyncResultSchema`. `POST /api/v1/knowledge-bases/<id>/sync`.
   */
  sync: { effect: "changing", right: KNOWLEDGE_BASE_ACTIONS.write, completion: "async" },
  /** State and counts per source. `GET /api/v1/knowledge-bases/<id>/sources`. */
  sources: { effect: "reading", right: KNOWLEDGE_BASE_ACTIONS.read },
  /** The items of one source, paged. `GET /api/v1/knowledge-bases/<id>/sources/<source>/items`. */
  source_items: { effect: "reading", right: KNOWLEDGE_BASE_ACTIONS.read },
  /** An item's state and times, for an erasure request. `GET /api/v1/knowledge-bases/<id>/locate`. */
  locate: { effect: "reading", right: KNOWLEDGE_BASE_ACTIONS.read }
} as const;

export {
  knowledgeSyncInputSchema,
  knowledgeSyncResultSchema,
  knowledgeSourcesOutputSchema,
  knowledgeSourceItemsInputSchema,
  knowledgeSourceItemsOutputSchema,
  knowledgeRetryInputSchema,
  knowledgeRetryOutputSchema,
  knowledgeLocateInputSchema,
  knowledgeLocateOutputSchema,
  knowledgeWorkflowSourcesOutputSchema,
  knowledgeFirstPassConfirmationSchema,
  KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES,
  type KnowledgeSyncInput,
  type KnowledgeSyncResult,
  type KnowledgeSourcesOutput,
  type KnowledgeSourceItemsInput,
  type KnowledgeSourceItemsOutput,
  type KnowledgeRetryInput,
  type KnowledgeRetryOutput,
  type KnowledgeLocateInput,
  type KnowledgeLocateOutput,
  type KnowledgeWorkflowSourcesOutput,
  type KnowledgeFirstPassConfirmation,
  type KnowledgeSourceItemShownState
} from "@work-shape/catalyst-asset-schemas";

// KBW-0's write contract inventory. No handler runs until KBW-1 or PROC-W.
export {
  knowledgeWriteContracts as KNOWLEDGE_WRITE_OPERATIONS,
  knowledgeWorkflowSourceSchema,
  knowledgeRecordsRefusalSchema,
  knowledgeIngestItemSchema,
  knowledgeIngestInputSchema,
  knowledgeIngestOutputSchema,
  knowledgeIngestFetchSchema,
  type KnowledgeIngestItem,
  type KnowledgeIngestInput,
  type KnowledgeIngestOutput,
  type KnowledgeIngestFetch,
  type KnowledgeWithdrawInput,
  type KnowledgeWithdrawOutput,
  type KnowledgePendingInput,
  type KnowledgePendingRow,
  type KnowledgePendingOutput,
  type KnowledgePutProcessedInput,
  type KnowledgeExtractFieldsInput,
  type KnowledgeExtractFieldsOutput,
  type KnowledgeWorkflowSource
} from "@work-shape/catalyst-asset-schemas";
