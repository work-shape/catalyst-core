import { z } from "zod";
import {
  KNOWLEDGE_DOCUMENT_FAILURE_CODES,
  KNOWLEDGE_DOCUMENT_STATES,
  KNOWLEDGE_SOURCE_FAILURE_CODES,
  KNOWLEDGE_SOURCE_ITEM_FAILURE_CODES,
  KNOWLEDGE_SYNC_MODES,
  KNOWLEDGE_SYNC_RUN_STATES,
  type KnowledgeSyncCount
} from "@work-shape/catalyst-asset-schemas";
import { defineJobKind } from "./jobs";
import {
  KNOWLEDGE_BASE_ACTIONS,
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
export const KNOWLEDGE_BASE_SYNC_JOB_KIND = "knowledge_base.sync";

/** The job that fetches one batch of items of a source and hands each to the index job. */
export const KNOWLEDGE_BASE_FETCH_JOB_KIND = "knowledge_base.fetch";

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

const sourceIdSchema = z.string().min(1).max(63);
const countSchema = z.number().int().min(0);
/** What a sync run counts (`KNOWLEDGE_SYNC_COUNTS`). */
const countsSchema = z.strictObject({
  discovered: countSchema,
  added: countSchema,
  changed: countSchema,
  moved: countSchema,
  withdrawn: countSchema,
  failed: countSchema,
  skipped: countSchema
}) satisfies z.ZodType<Record<KnowledgeSyncCount, number>>;

export const knowledgeSyncInputSchema = z.strictObject({
  /** The `id` of the source in the definition. */
  source: sourceIdSchema,
  /** `changes` unless `full`. The initial import is started by publish, not by this call. */
  mode: z.literal("full").optional()
});

export type KnowledgeSyncInput = z.infer<typeof knowledgeSyncInputSchema>;

/** What a sync run ends with: the result of its Operation Run, and a Workflow step's output. */
export const knowledgeSyncResultSchema = z.strictObject({
  syncRunId: z.string(),
  source: z.string(),
  mode: z.enum(KNOWLEDGE_SYNC_MODES),
  /** Why a run is of another mode than asked, such as a cursor the source refused. */
  reason: z.enum(["cursor_expired"]).optional(),
  state: z.enum(KNOWLEDGE_SYNC_RUN_STATES),
  counts: countsSchema,
  bytesFetched: z.number().int().min(0),
  /** Why the whole sync failed, for a run in state `failed`. */
  failureCode: z.enum(KNOWLEDGE_SOURCE_FAILURE_CODES).optional(),
  startedAt: z.string(),
  endedAt: z.string().optional()
});

export type KnowledgeSyncResult = z.infer<typeof knowledgeSyncResultSchema>;

/**
 * What the page shows of an item: its own state up to `fetched`, then its document's.
 * "Gefunden", "Geladen", "Durchsuchbar", "Fehlgeschlagen", "Entfernt".
 */
export const KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES = [
  "discovered",
  "fetched",
  "indexed",
  "failed",
  "withdrawn"
] as const;

export type KnowledgeSourceItemShownState = (typeof KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES)[number];

/** A failure of an item, from the source's side or its document's. */
const itemFailureCodeSchema = z.union([
  z.enum(KNOWLEDGE_SOURCE_ITEM_FAILURE_CODES),
  z.enum(KNOWLEDGE_DOCUMENT_FAILURE_CODES)
]);

export const knowledgeSourcesOutputSchema = z.strictObject({
  sources: z.array(
    z.strictObject({
      id: z.string(),
      /** The name of the Connection it reads through. */
      connection: z.string(),
      /** Items by the state the page shows. */
      items: z.strictObject({
        discovered: countSchema,
        fetched: countSchema,
        indexed: countSchema,
        failed: countSchema,
        withdrawn: countSchema
      }) satisfies z.ZodType<Record<KnowledgeSourceItemShownState, number>>,
      /** Failed items per code. */
      failures: z.array(z.strictObject({ code: itemFailureCodeSchema, count: countSchema })),
      /** The sync that runs now, with its rate in items per minute and its estimated end. */
      running: z
        .strictObject({
          syncRunId: z.string(),
          mode: z.enum(KNOWLEDGE_SYNC_MODES),
          startedAt: z.string(),
          itemsPerMinute: z.number().min(0).optional(),
          estimatedEndAt: z.string().optional()
        })
        .optional(),
      /** The last sync that ended. */
      last: knowledgeSyncResultSchema.optional(),
      /** "Letzte Änderung verarbeitet". */
      lastChangeAt: z.string().optional(),
      /** "Älteste offene Änderung". */
      oldestOpenChangeAt: z.string().optional()
    })
  )
});

export type KnowledgeSourcesOutput = z.infer<typeof knowledgeSourcesOutputSchema>;

export const knowledgeSourceItemsInputSchema = z.strictObject({
  source: sourceIdSchema,
  state: z.enum(KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES).optional(),
  failureCode: itemFailureCodeSchema.optional(),
  /** Items per page: 50 by default, at most 200. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(1_000).optional()
});

export type KnowledgeSourceItemsInput = z.infer<typeof knowledgeSourceItemsInputSchema>;

export const knowledgeSourceItemsOutputSchema = z.strictObject({
  /** Newest change first. */
  items: z.array(
    z.strictObject({
      /** The row in `source_items`: what `retry` and `locate` name. */
      id: z.string(),
      /** The id of the item at the source. */
      itemId: z.string(),
      name: z.string(),
      path: z.string(),
      state: z.enum(KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES),
      failureCode: itemFailureCodeSchema.optional(),
      documentId: z.string().optional(),
      originLink: z.string().optional(),
      changedAt: z.string()
    })
  ),
  nextCursor: z.string().optional()
});

export type KnowledgeSourceItemsOutput = z.infer<typeof knowledgeSourceItemsOutputSchema>;

/** How many documents or items one retry names at most. */
const RETRY_MAX = 100;

/**
 * KB-5c's retry, widened: documents by id, or items of a source by id, by failure code or all
 * failed ones. A failed fetch is fetched again; a failed document of a synced source is
 * fetched and indexed again, because its original is not kept.
 */
export const knowledgeRetryInputSchema = z.union([
  z.strictObject({ documentIds: z.array(z.string().min(1).max(200)).min(1).max(RETRY_MAX) }),
  z.strictObject({
    source: sourceIdSchema,
    sourceItemIds: z.array(z.string().min(1).max(200)).min(1).max(RETRY_MAX)
  }),
  z.strictObject({ source: sourceIdSchema, failureCode: itemFailureCodeSchema }),
  z.strictObject({ source: sourceIdSchema, all: z.literal(true) })
]);

export type KnowledgeRetryInput = z.infer<typeof knowledgeRetryInputSchema>;

export const knowledgeRetryOutputSchema = z.strictObject({
  /** For a retry by document ids: each named document, with its state after the retry. */
  documents: z
    .array(z.strictObject({ id: z.string(), state: z.enum(KNOWLEDGE_DOCUMENT_STATES) }))
    .optional(),
  /** How many contents or items were queued again. */
  queued: z.number().int()
});

export type KnowledgeRetryOutput = z.infer<typeof knowledgeRetryOutputSchema>;

export const knowledgeLocateInputSchema = z.strictObject({
  /** The row in `source_items`. */
  sourceItemId: z.string().min(1).max(200)
});

export type KnowledgeLocateInput = z.infer<typeof knowledgeLocateInputSchema>;

/** An item's state and times, and no content, name or path. */
export const knowledgeLocateOutputSchema = z.strictObject({
  sourceItemId: z.string(),
  source: z.string(),
  itemId: z.string(),
  state: z.enum(KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES),
  discoveredAt: z.string(),
  fetchedAt: z.string().optional(),
  withdrawnAt: z.string().optional(),
  purgedAt: z.string().optional()
});

export type KnowledgeLocateOutput = z.infer<typeof knowledgeLocateOutputSchema>;
