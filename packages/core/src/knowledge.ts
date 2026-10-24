import type { KnowledgeDocumentFormat } from "./knowledge-formats";
import type { AgentConfig } from "@work-shape/catalyst-asset-schemas";

export type {
  KnowledgeDocumentFailureCode,
  KnowledgeDocumentState,
  KnowledgeDocumentWaitCode,
  KnowledgeSearchSignal
} from "@work-shape/catalyst-asset-schemas";
import {
  KNOWLEDGE_CHECK_STATUSES,
  type KnowledgeDocumentFailureCode,
  type KnowledgeDocumentState,
  type KnowledgeDocumentWaitCode,
  type KnowledgeSearchSignal
} from "@work-shape/catalyst-asset-schemas";
import type { AssetKindActions } from "./asset-kinds";
import type { ConfigAssetStore } from "./config-assets";
import type { ConnectionsStore } from "./connections";
import type { DataStoreRecordsStore, DataStoreRows, DataStoreStatement } from "./data-stores";
import { z } from "zod";
import type { AuthenticatedIdentity } from "./identity";
import type { ClientInstanceId, ConversationId } from "./ids";
import { defineJobKind, subjectDedupeKey, type JobsStore } from "./jobs";
import type { ObjectStorage } from "./object-storage";
import type { ActorAccess } from "./permissions";
import type { ISODateString } from "./time";

// The names and shapes of a Knowledge Base that more than one package reads: the asset kind,
// the operations of one Knowledge Base, the one agent tool over all of an agent's, the port a
// backend answers through and what the platform keeps of the last check. The kind itself is
// in `@work-shape/catalyst-data-stores`, beside its only backend so far, the Data Store.
// Spec: data-stores-and-knowledge-bases.md, Knowledge Base on top, Retrieval methods,
// Assigning knowledge bases to an agent.
//
// Sensitive data. A Knowledge Base keeps no row of its own: the rows stay in the database of
// its backend and live as long as that database does. The platform keeps the definition (the
// sentences that describe the tables) and the result of the last check (table names, whether
// each could be read, a sentence, a time). A call of `knowledge.<id>.query` leaves one
// Operation Run with the asker as actor and audit rows that hold neither the SQL, nor a
// parameter, nor a row. An agent's call puts SQL and rows into its conversation, which keeps
// them under the conversation's retention and sends them to the model of the agent's model
// binding, in that binding's region. No embedding is made and no embedding provider is asked.
//
// A Knowledge Base without a backend keeps its documents in a Data Store it owns (the built-in
// backend). A holder of `knowledge_base.write` adds a file a person can open with
// `knowledge.<id>.add_files`: the platform copies it into a Managed File the Knowledge Base owns,
// which lives as long as the document and no longer follows the Conversation it came from, and
// writes the document's row into the store. The index job then writes the document's text as
// passages into that store; a PDF or DOCX is extracted first by the document worker, which
// leaves the text in the instance's store of files (`knowledge-extraction.ts`). Runs and audit
// rows name file ids, counts, bytes and failure codes, never a file name or text.
//
// `knowledge.<id>.search` answers passages (text, file name, page) to its caller, which for an
// agent puts them into its conversation and sends them to the agent's model. Where the
// Knowledge Base searches by meaning and has embeddings, the query goes to the embedding
// provider of the binding its active generation names, as a `knowledge_query` usage event. The
// run keeps a hash of its input and no output; the audit row `knowledge_base.searched` keeps a
// hash of the query, the count, the lists fused and the duration. No log line holds the query,
// a passage or a file name. Spec: Embeddings
// and documents on the built-in backend, "Documents in a Knowledge Base: retention, audit,
// authorization and provider region".

/**
 * The asset kind of a Knowledge Base. A kind of its own, with rights of its own: a Data Store
 * is one of its backends, not what it is. Spec: build order WD-2.
 */
export const KNOWLEDGE_BASE_ASSET_KIND = "knowledge_base";

/** The rights of the kind. `use` queries the published revision. */
export const KNOWLEDGE_BASE_ACTIONS = {
  read: "knowledge_base.read",
  write: "knowledge_base.write",
  publish: "knowledge_base.publish",
  delete: "knowledge_base.delete",
  use: "knowledge_base.use"
} as const satisfies AssetKindActions;

/**
 * The prefix of every operation of one Knowledge Base: `knowledge.<id>.<part>`. Rights, policy
 * and audit are per Knowledge Base. Spec: P40.
 */
export const KNOWLEDGE_OPERATION_PREFIX = "knowledge.";

/** The operation that answers read-only SQL on one structured Knowledge Base. Spec: P38. */
export function knowledgeQueryOperationName(knowledgeBase: string): string {
  return `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase}.query`;
}

/**
 * The one tool an agent queries its structured Knowledge Bases with, however many it has. It
 * names no Knowledge Base: a call is the call of `knowledge.<id>.query` of the one its input
 * names, made through `runOperation` like every other tool call. Spec: P40, P116.
 */
export const KNOWLEDGE_QUERY_TOOL_NAME = "knowledge.query";

/** The operation that searches the documents of one Knowledge Base. Spec: P38, KB-7a. */
export function knowledgeSearchOperationName(knowledgeBase: string): string {
  return `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase}.search`;
}

/**
 * The one tool an agent searches the documents of its Knowledge Bases with, however many it
 * has. A call is one call of `knowledge.<id>.search` per Knowledge Base it searches, each
 * through `runOperation` with its own right, run and audit. Spec: P40, "Search, the agent
 * tool and citations".
 */
export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge.search";

/**
 * The operations an agent reaches through its knowledge tools: the query and the search of
 * each Knowledge Base its definition lists. Which of the two a Knowledge Base answers follows
 * its backend. An agent calls these and no other Knowledge Base.
 */
export function knowledgeOperationNamesOf(
  agent: Pick<AgentConfig, "knowledgeBases">
): readonly string[] {
  return (agent.knowledgeBases ?? []).flatMap((knowledgeBase) => [
    knowledgeQueryOperationName(knowledgeBase),
    knowledgeSearchOperationName(knowledgeBase)
  ]);
}

/** How many passages a search answers when the caller names no limit, and at most. */
export const KNOWLEDGE_SEARCH_LIMIT_DEFAULT = 20;
export const KNOWLEDGE_SEARCH_LIMIT_MAX = 50;

/** How many places each ranked list of a search takes before the lists are fused. */
export const KNOWLEDGE_SEARCH_LIST_DEPTH = 50;

/** The constant of reciprocal rank fusion: a place `r` scores `1 / (k + r)`. */
export const KNOWLEDGE_RRF_K = 60;

/** The longest query a search takes, in characters. */
export const KNOWLEDGE_SEARCH_QUERY_MAX_CHARS = 1_000;

/**
 * One passage a search found: where it is (the document, its copy, the page and heading), its
 * text and its fused score, which is compared only within one Knowledge Base.
 */
export interface KnowledgeSearchHit {
  documentId: string;
  /** The Managed File the Knowledge Base owns that holds the document's bytes. */
  fileId: string;
  fileName: string;
  title: string;
  /** The page it is on, from 1. None for a text file, which has no pages. */
  page?: number;
  heading?: string;
  text: string;
  score: number;
  originLink?: string;
}

/** What a search of one Knowledge Base's documents answers, and the lists it fused. */
export interface KnowledgeSearchAnswer {
  hits: KnowledgeSearchHit[];
  signals: KnowledgeSearchSignal[];
}

/**
 * The embedding of a search's query with the model a Knowledge Base's active generation was
 * embedded with. Nothing where that model is not one the instance has now: the search then
 * answers from full text and titles alone. Spec: "Changing the embedding model".
 */
export type KnowledgeQueryEmbedding = (generation: {
  bindingId: string;
  /** The model the generation was embedded with: a binding that names another now embeds nothing. */
  model: string;
  dimensions: number;
}) => Promise<number[] | undefined>;

/**
 * How a process embeds the query of a search: through the model gateway with the purpose
 * `knowledge_query`, attributed to the person, the workspace and the run of the search.
 * Nothing where the binding is not one of kind `embedding` in the release config now.
 */
export type KnowledgeQueryEmbedder = (call: {
  bindingId: string;
  /** The model the active generation was embedded with: nothing where the binding names another. */
  model: string;
  dimensions: number;
  text: string;
  attribution: {
    userId?: string;
    workspaceId?: string;
    conversationId?: ConversationId;
    operationRunId: string;
  };
  correlationId: string;
  signal?: AbortSignal;
}) => Promise<number[] | undefined>;

/**
 * Fuses ranked lists by reciprocal rank: an entry at place `r` (from 1) of a list scores
 * `1 / (k + r)`, and its scores of every list are summed. Ties keep the order of the lists
 * and of the places. Raw scores of different lists are never compared. Spec: P40.
 */
export function fuseByReciprocalRank<T>(
  lists: readonly (readonly T[])[],
  keyOf: (entry: T) => string,
  k: number = KNOWLEDGE_RRF_K
): { entry: T; score: number }[] {
  const fused = new Map<string, { entry: T; score: number; first: number }>();
  let seen = 0;
  for (const list of lists) {
    list.forEach((entry, index) => {
      const key = keyOf(entry);
      const score = 1 / (k + index + 1);
      const held = fused.get(key);
      if (held) held.score += score;
      else fused.set(key, { entry, score, first: (seen += 1) });
    });
  }
  // Where an entry was first seen breaks a tie: by list order, then by place.
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .map(({ entry, score }) => ({ entry, score }));
}

/**
 * A call of the knowledge tool as the call of the operation it stands for: the operation of
 * the Knowledge Base the input names, with the rest of the input. Nothing where the input
 * names none, which the caller refuses as an input that does not hold.
 */
export function knowledgeToolCall(
  input: unknown
): { operation: string; knowledgeBase: string; input: Record<string, unknown> } | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const { knowledgeBase, ...rest } = Object.fromEntries(Object.entries(input));
  if (typeof knowledgeBase !== "string" || knowledgeBase.length === 0) return undefined;
  return { operation: knowledgeQueryOperationName(knowledgeBase), knowledgeBase, input: rest };
}

/** One described table as the last check found it. */
export interface KnowledgeTableCheck {
  name: string;
  /** The Knowledge Base can read it: it exists and the role that answers may select from it. */
  readable: boolean;
}

/**
 * What a check of a Knowledge Base found. `preparing` while the store a Knowledge Base of
 * documents owns is still being made: nothing is wrong, and it takes no files yet.
 * `needs_attention` where a described table cannot be read, the backend cannot be reached, or
 * the store a Knowledge Base owns failed or is missing: a query then fails. A Knowledge Base on
 * a Data Store is not published in either state.
 */
export interface KnowledgeCheckResult {
  status: (typeof KNOWLEDGE_CHECK_STATUSES)[number];
  /** Every described table, in the order of the definition. None on the built-in backend. */
  tables: KnowledgeTableCheck[];
  /** Why the backend cannot serve it, as a sentence. It names no row value. */
  problem?: string;
}

/**
 * The methods a Knowledge Base on the built-in backend searches its documents with: by meaning,
 * which embeds every passage and every query with the instance's embedding model, and by words.
 * Spec: Retrieval methods (P38).
 */
export const KNOWLEDGE_SEARCH_METHODS = ["semantic", "keyword"] as const;

export type KnowledgeSearchMethod = (typeof KNOWLEDGE_SEARCH_METHODS)[number];

/** A Knowledge Base that describes tables of a Data Store, and the tables a backend finds there. */
export interface DataStoreKnowledgeTarget {
  backend: "dataStore";
  /** The id of the Knowledge Base's asset, which its access on the backend is bound to. */
  assetId: string;
  /** The id of the Knowledge Base. */
  name: string;
  /** The id of the Data Store whose tables it describes. */
  dataStore: string;
  tables: readonly { name: string }[];
  queries?: readonly { name: string; file: string; sql: string }[];
}

/**
 * A Knowledge Base whose documents the platform keeps in a Data Store the Knowledge Base owns:
 * the built-in backend, which a definition names by naming no backend.
 */
export interface BuiltinKnowledgeTarget {
  backend: "builtin";
  /** The id of the Knowledge Base's asset, which is also the id of the store it owns. */
  assetId: string;
  /** The id of the Knowledge Base. */
  name: string;
  methods: readonly KnowledgeSearchMethod[];
}

/** A Knowledge Base as a backend is asked about it. */
export type KnowledgeBaseTarget = DataStoreKnowledgeTarget | BuiltinKnowledgeTarget;

/**
 * The rows a backend reads and writes beside a publish, bound to the publish's transaction.
 * Every read of the publish goes through them: the transaction holds a connection of the
 * platform's pool, and a read that took another one could wait for it without end.
 */
export interface KnowledgeBackendStores {
  configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
  connections: ConnectionsStore;
  dataStores: DataStoreRecordsStore;
  jobs: JobsStore;
}

/**
 * What a backend of a Knowledge Base answers. The kind asks it and never which backend it is.
 * `Target` narrows the Knowledge Bases one backend serves; the one the kind is given serves
 * every target. Spec: build order WD-2, a backend port.
 */
export interface KnowledgeBackend<Target extends KnowledgeBaseTarget = KnowledgeBaseTarget> {
  /**
   * What publishing `target` does beside moving the published pointer, with `stores` bound to
   * the transaction of the publish: whether the publisher may hand the backend's content to
   * the Knowledge Base's users, whether the backend can serve the revision, and then what the
   * Knowledge Base is given on the backend, `replaced` being the revision published before.
   * Answers what the check found, for the platform to keep. A throw refuses the publish.
   */
  publish(
    stores: KnowledgeBackendStores,
    input: { target: Target; replaced: KnowledgeBaseTarget | undefined; access: ActorAccess }
  ): Promise<KnowledgeCheckResult>;
  /** Whether the backend can serve the Knowledge Base now. It reads no row of its content. */
  check(target: Target, signal?: AbortSignal): Promise<KnowledgeCheckResult>;
  /**
   * Gives the Knowledge Base on the backend what its published revision needs, as a check
   * that found nothing missing does again. Repeating it changes nothing.
   */
  grant(stores: KnowledgeBackendStores, target: Target, signal?: AbortSignal): Promise<void>;
  /**
   * Takes from the backend what it held for a deleted Knowledge Base: its access, or the store
   * it owned. Repeating it changes nothing.
   */
  retire(stores: KnowledgeBackendStores, target: Target, signal?: AbortSignal): Promise<void>;
  /**
   * Runs one read-only statement with bound parameters, under the backend's row and byte caps,
   * with the access `grant` gave the Knowledge Base and no other. Only a backend that answers
   * the method `structured` runs one.
   */
  query(
    target: Target,
    statement: DataStoreStatement,
    signal?: AbortSignal,
    viewer?: { access: ActorAccess; namedQuery: boolean }
  ): Promise<DataStoreRows>;
  /**
   * Writes the rows of documents added to the Knowledge Base, and of their contents where the
   * store has none yet, in one transaction. Refuses, writing nothing, where the Knowledge Base
   * would then hold more than `maxDocuments` documents, or where a document names a copy that
   * was removed. Only a backend that keeps documents writes any.
   */
  addDocuments(
    target: Target,
    input: { documents: readonly KnowledgeDocumentInput[]; maxDocuments: number },
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Which of `fileIds` a document of the Knowledge Base names, read once every write of
   * documents in progress has ended: it waits for the lock `addDocuments` holds. A write that
   * starts after a copy is marked deleted refuses with `knowledge_files_released`, so for a
   * copy marked deleted before the call, the answer is final. None for a backend that keeps no
   * documents, and none once the store the Knowledge Base owned is gone.
   */
  documentFileIds(
    target: Target,
    fileIds: readonly string[],
    signal?: AbortSignal
  ): Promise<string[]>;
  /**
   * The documents and contents of the Knowledge Base, for its index job and its operations.
   * None for a backend that keeps no documents.
   */
  documentStore(
    target: Target,
    /** Where the store's record is read, such as the transaction of a publish; else the pool. */
    records?: DataStoreRecordsStore
  ): KnowledgeDocumentStore | undefined;
}

/** A document as it is added to a Knowledge Base that keeps documents. */
export interface KnowledgeDocumentInput {
  id: string;
  /** The Managed File the Knowledge Base owns that holds the document's bytes. */
  fileId: string;
  /** The SHA-256 of the bytes, in hex: the content the document shares with identical files. */
  contentSha256: string;
  format: KnowledgeDocumentFormat;
  title: string;
  fileName: string;
  /** The user who added it, where a person did. */
  addedBy?: string;
}

/**
 * What a kept check says. A check that finds the store being made keeps nothing: the state read
 * looks again until the store is ready, which nobody need check for.
 */
export type KeptKnowledgeStatus = Exclude<KnowledgeCheckResult["status"], "preparing">;

/** The last check of a Knowledge Base, as the platform keeps it. */
export interface KnowledgeBaseState extends Omit<KnowledgeCheckResult, "status"> {
  status: KeptKnowledgeStatus;
  /** The id of the Knowledge Base's asset. */
  assetId: string;
  clientInstanceId: ClientInstanceId;
  /** The revision that was checked: the one being published, or the published one. */
  revision: number;
  checkedAt: ISODateString;
}

/** What the platform keeps of each Knowledge Base, as `PlatformStores.knowledgeBases`. */
export interface KnowledgeBaseStateStore {
  getKnowledgeBaseState(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<KnowledgeBaseState | undefined>;
  /** Inserts the state, or replaces the one of the same asset. */
  putKnowledgeBaseState(state: KnowledgeBaseState): Promise<void>;
  deleteKnowledgeBaseState(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
  }): Promise<void>;
}

/**
 * The formats a document of a Knowledge Base is in. Text formats are read as they are; PDF and
 * DOCX need the extraction of the document-processing capability, and an instance without it
 * refuses them when they are added. Spec: Adding files, Ingestion as jobs.
 */
export { KNOWLEDGE_DOCUMENT_FORMATS, type KnowledgeDocumentFormat } from "./knowledge-formats";

/** The formats an instance reads without the document-processing capability. */
export const KNOWLEDGE_TEXT_FORMATS: readonly KnowledgeDocumentFormat[] = ["txt", "markdown"];

export { KNOWLEDGE_FILE_MAX_BYTES } from "@work-shape/catalyst-asset-schemas";

/**
 * How many pages of one PDF or DOCX a Knowledge Base reads by default. Release config
 * may raise it (`knowledge.maxPagesPerDocument`) without a fixed upper bound. Extraction counts
 * the pages before it reads their text, and refuses a longer document with
 * `knowledge_file_too_many_pages`.
 */
export const KNOWLEDGE_MAX_PAGES_PER_DOCUMENT = 500;

/**
 * How many files one call of `knowledge.<id>.add_files` adds at most. It bounds what one call
 * reads and copies; a caller with more sends several calls. A larger list is refused with this
 * limit named, and the page's Add dialog lets no more be chosen.
 */
export const KNOWLEDGE_ADD_FILES_MAX_COUNT = 20;

/**
 * The format of a file by its name, then by its media type: what a Knowledge Base reads it as.
 * Nothing for a file in no format a Knowledge Base takes. The Add dialog offers by the same rule
 * what the call accepts.
 */
export function knowledgeDocumentFormatOf(file: {
  filename: string;
  mimeType?: string;
}): KnowledgeDocumentFormat | undefined {
  // The extension as `path.extname` reads it, which a browser has no module for.
  const base = file.filename.slice(file.filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  switch (dot > 0 ? base.slice(dot).toLowerCase() : "") {
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
  }
  switch (file.mimeType?.split(";")[0]?.trim().toLowerCase()) {
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "markdown";
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
  }
  return undefined;
}

/**
 * A file a person can open in the platform, named by its ids as `knowledge.<id>.add_files`
 * takes it: a file of a Conversation the person may read.
 */
export interface KnowledgeFileRef {
  conversationId: string;
  fileId: string;
}

/** A file as the person adding it may open it. `read` reads its bytes. */
export interface OpenedKnowledgeFile {
  filename: string;
  mimeType?: string;
  byteSize: number;
  read(): Promise<Uint8Array>;
}

/** Where a Knowledge Base takes the files added to it from, and where it keeps its copies. */
export interface KnowledgeFiles {
  /**
   * The file as `actor` may open it now. Nothing where it does not exist or the actor may not
   * open it, which a caller answers alike, so that no answer tells the two apart.
   */
  open(
    actor: AuthenticatedIdentity,
    ref: KnowledgeFileRef
  ): Promise<OpenedKnowledgeFile | undefined>;
  /** The instance's store of files, which holds the copies a Knowledge Base owns. */
  readonly objects: ObjectStorage;
}

/**
 * The job that turns one content of a Knowledge Base's store into text by page: PDF and DOCX,
 * served by the document-processing capability in its worker, which calls no model. Its
 * handler is made with `defineKnowledgeExtractHandler` (`knowledge-extraction.ts`), which
 * holds the handoff to the index job.
 */
export const KNOWLEDGE_BASE_EXTRACT_JOB_KIND = "knowledge_base.extract";

/** The Knowledge Base jobs served by the knowledge worker; extraction needs the doc-worker. */
export const KNOWLEDGE_JOB_KINDS = {
  sync: "knowledge_base.sync",
  fetch: "knowledge_base.fetch",
  index: "knowledge_base.index",
  cleanFiles: "knowledge_base.clean_files",
  removeDocuments: "knowledge_base.remove_documents",
  releaseOriginals: "knowledge_base.release_originals",
  deleteOriginals: "knowledge_base.delete_originals",
  reconcileSources: "knowledge_base.reconcile_sources",
  reprocess: "knowledge_base.reprocess",
  reindex: "knowledge_base.reindex"
} as const;

/** Chunks and optionally embeds a content in the configured ingestion process. */
export const KNOWLEDGE_BASE_INDEX_JOB_KIND = KNOWLEDGE_JOB_KINDS.index;

const jobIdSchema = z.string().min(1).max(200);

/**
 * What a job of either kind carries: ids only, never a file name or text. The run is the one of
 * `knowledge.<id>.add_files` or `knowledge.<id>.retry` whose call caused the work, for the
 * usage it causes.
 */
export const knowledgeContentJobPayloadSchema = z.strictObject({
  /** The id of the Knowledge Base's asset, which is also the id of the store it owns. */
  knowledgeBaseId: jobIdSchema,
  /** The content: the SHA-256 of the file's bytes, in hex. */
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** A Managed File the Knowledge Base owns that holds the bytes. */
  fileId: jobIdSchema,
  operationRunId: jobIdSchema
});

export type KnowledgeContentJobPayload = z.infer<typeof knowledgeContentJobPayloadSchema>;

/** The formats only extraction reads. */
export const KNOWLEDGE_EXTRACTED_FORMATS = [
  "pdf",
  "docx"
] as const satisfies readonly KnowledgeDocumentFormat[];

export type KnowledgeExtractedFormat = (typeof KNOWLEDGE_EXTRACTED_FORMATS)[number];

/** Built-in processor names shared by definitions, jobs and the extractor contract. */
export const KNOWLEDGE_BUILTIN_PROCESSORS = ["text", "tables"] as const;
export type KnowledgeBuiltinProcessor = (typeof KNOWLEDGE_BUILTIN_PROCESSORS)[number];

/** What an extract job carries: the ids of an index job and the format to read the bytes as. */
export const knowledgeExtractJobPayloadSchema = knowledgeContentJobPayloadSchema.extend({
  format: z.enum(KNOWLEDGE_EXTRACTED_FORMATS),
  processor: z.enum(KNOWLEDGE_BUILTIN_PROCESSORS).optional(),
  processorRevision: z.string().optional()
});

export type KnowledgeExtractJobPayload = z.infer<typeof knowledgeExtractJobPayloadSchema>;

/**
 * The index job. Every write it makes is idempotent: a rerun replaces the content's chunks.
 * No limit per Knowledge Base, so many contents of one are indexed side by side.
 */
export const knowledgeIndexJob = defineJobKind({
  kind: KNOWLEDGE_BASE_INDEX_JOB_KIND,
  payloadSchema: knowledgeContentJobPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 10_000, maxMs: 10 * 60_000 },
  leaseMs: 2 * 60_000,
  concurrency: { global: 4 }
});

/** The extract job. Its worker's slots bound how many convert at once. */
export const knowledgeExtractJob = defineJobKind({
  kind: KNOWLEDGE_BASE_EXTRACT_JOB_KIND,
  payloadSchema: knowledgeExtractJobPayloadSchema,
  maxAttempts: 3,
  backoff: { baseMs: 30_000, maxMs: 10 * 60_000 },
  leaseMs: 5 * 60_000,
  concurrency: { global: 2 }
});

/**
 * Queues the index job of one content. With `dedupe` a job of the same content that is still
 * queued takes it instead; without, a second job is queued, which finds the work done or does
 * it again to the same result. A job that hands work back to the index job queues without
 * `dedupe`, because the index job that asked may not have ended yet; so does an index job that
 * waits, with `runAfter`.
 */
export function enqueueKnowledgeIndex(
  jobs: Pick<JobsStore, "enqueue">,
  payload: KnowledgeContentJobPayload,
  options: { clientInstanceId: ClientInstanceId; dedupe?: boolean; runAfter?: Date }
): Promise<unknown> {
  return jobs.enqueue(knowledgeIndexJob, payload, {
    clientInstanceId: options.clientInstanceId,
    subject: payload.knowledgeBaseId,
    concurrencyKey: payload.knowledgeBaseId,
    ...(options.runAfter ? { runAfter: options.runAfter } : {}),
    ...(options.dedupe
      ? {
          dedupeKey: subjectDedupeKey(
            KNOWLEDGE_BASE_INDEX_JOB_KIND,
            `${payload.knowledgeBaseId}:${payload.contentSha256}`
          )
        }
      : {})
  });
}

/** Queues extraction once per content and source copy. A withdrawn source copy cannot
 * suppress extraction from its replacement while the old attempt is still ending. */
export function enqueueKnowledgeExtract(
  jobs: Pick<JobsStore, "enqueue">,
  payload: KnowledgeExtractJobPayload,
  options: { clientInstanceId: ClientInstanceId }
): Promise<unknown> {
  return jobs.enqueue(knowledgeExtractJob, payload, {
    clientInstanceId: options.clientInstanceId,
    subject: payload.knowledgeBaseId,
    concurrencyKey: payload.knowledgeBaseId,
    dedupeKey: subjectDedupeKey(
      KNOWLEDGE_BASE_EXTRACT_JOB_KIND,
      `${payload.knowledgeBaseId}:${payload.contentSha256}:${payload.fileId}`
    )
  });
}

/**
 * What extraction answers for one content: its text by page, numbered from 1. A file without
 * pages, such as a DOCX, answers one page per section the converter finds. It is outside input
 * to the platform, parsed with `knowledgeExtractedPagesSchema` before it is stored.
 */
export const knowledgeExtractedPagesSchema = z.strictObject({
  pages: z.array(z.strictObject({ page: z.number().int().min(1), text: z.string() }))
});

export type KnowledgeExtractedPages = z.infer<typeof knowledgeExtractedPagesSchema>;

/**
 * The state of one content in the store: `pending` until its chunks are written, then
 * `extracted` (its text is extracted and chunked at `chunking_revision`: the document is
 * indexed), or `failed` with a code. Spec: The store of a built-in Knowledge Base.
 */
export const KNOWLEDGE_CONTENT_STATES = ["pending", "extracted", "failed"] as const;

export type KnowledgeContentState = (typeof KNOWLEDGE_CONTENT_STATES)[number];

/** The state a document shows, from the state of its content. */
export function knowledgeDocumentStateOf(state: KnowledgeContentState): KnowledgeDocumentState {
  return state === "extracted" ? "indexed" : state;
}

/** A document as a document tool finds it by its file id. */
export interface KnowledgeFileDocument {
  documentId: string;
  contentSha256: string;
  format: KnowledgeDocumentFormat;
  fileName: string;
  /** The pages its extraction found, where it has pages. */
  pageCount?: number;
  /** Whether a synced source keeps the document: its text is the stored extraction. */
  synced: boolean;
}

/** One content as the index job reads it, with one document that holds it. */
export interface KnowledgeContentToIndex {
  contentSha256: string;
  /** At least one active document of this content came from a synced source. */
  synced?: boolean;
  format: KnowledgeDocumentFormat;
  state: KnowledgeContentState;
  /** The chunking revision its chunks were written with, once they were. */
  chunkingRevision?: number;
  processingKey?: string;
  requestedProcessingKey?: string;
  processorRevision?: string;
  /**
   * An active document, preferring one whose owned copy is available. A metadata fallback
   * permits retained-text re-indexing when all originals are released; byte readers must
   * still check availability. None when every document is withdrawn.
   */
  document?: { fileId: string; title: string; fileName: string; path?: string; mime?: string };
}

/** One passage as the index job writes it. Its id is its content, revision and position. */
export interface KnowledgeChunkInput {
  position: number;
  /** The page it is on, from 1. None for a text file, which has no pages. */
  page?: number;
  /** The heading it is under, where the text has headings. */
  heading?: string;
  text: string;
  tokenCount: number;
}

/**
 * An embedding model as a Knowledge Base embeds with it: the binding of release config, the
 * model behind it and the length of its vectors.
 */
export interface KnowledgeEmbeddingModel {
  bindingId: string;
  model: string;
  dimensions: number;
}

/**
 * The states of a generation of embeddings that holds vectors search uses or will use: the one
 * search answers from, and one built beside it. A `retired` one is dropped.
 */
export const KNOWLEDGE_LIVE_GENERATION_STATES = ["building", "active"] as const;

/**
 * The embedding of a whole Knowledge Base with one model. Its vectors are in a table of their
 * own, `catalyst_kb.embeddings_<generation>`. Spec: The store of a built-in Knowledge Base.
 */
export interface KnowledgeEmbeddingGeneration extends KnowledgeEmbeddingModel {
  generation: number;
  state: (typeof KNOWLEDGE_LIVE_GENERATION_STATES)[number];
}

/** A passage as the index job embeds it: the text of the chunk and what its prefix is made of. */
export interface KnowledgePassageToEmbed {
  chunkId: string;
  heading?: string;
  text: string;
}

/**
 * A passage as a re-index embeds it into a generation being built: its chunk, and the document
 * whose title and file name make its prefix, as the index job made it.
 */
export interface KnowledgePassageToReindex extends KnowledgePassageToEmbed {
  title: string;
  fileName: string;
}

/**
 * What a re-index into a new generation would embed, read in one statement of the store: the
 * passages search reads, their estimated tokens with prefixes, and the size of the store now.
 */
export interface KnowledgeReindexEstimate {
  chunks: number;
  tokens: number;
  storeBytes: number;
}

/** A generation being served or built, with how far it is embedded. */
export interface KnowledgeEmbeddingGenerationProgress extends KnowledgeEmbeddingGeneration {
  /** The passages it had to embed when it was started; for one being built, its goal. */
  chunkCount: number;
  embeddedCount: number;
  startedAt: ISODateString;
}

/** A document of a Knowledge Base as its page lists it. */
export interface KnowledgeDocumentEntry {
  /** Extraction budget paused; indexing and search remain available. */
  fieldsPending?: boolean;
  fieldsPendingReason?: import("./knowledge-fields").KnowledgeFieldsPendingReason;
  id: string;
  /** The Managed File the Knowledge Base owns that holds the bytes. */
  fileId: string;
  fileName: string;
  title: string;
  format: KnowledgeDocumentFormat;
  state: KnowledgeDocumentState;
  failureCode?: KnowledgeDocumentFailureCode;
  /** Detected pages when conversion exceeded its deadline. */
  failurePageCount?: number;
  /** Why a `pending` document waits, where it waits for more than its turn. */
  waitCode?: KnowledgeDocumentWaitCode;
  /**
   * The source the document was synced from. Source withdrawal removes a synced document; a
   * manual remove refuses it.
   */
  sourceId?: string;
  addedAt: ISODateString;
  /** When its content last changed state. */
  updatedAt: ISODateString;
}

/** A document a retry looked at, with what it needs to queue the content's index job. */
export interface KnowledgeRetriedDocument {
  id: string;
  fileId: string;
  contentSha256: string;
  /** The state after the retry: a failed content is `pending` again. */
  state: KnowledgeDocumentState;
}

/** Where the next page of a purge starts: after a document, or among the unheld contents. */
export type KnowledgePurgeCursor =
  { phase: "documents"; after: string } | { phase: "contents"; after?: string };

/** What one page of a purge deleted, and where the next one starts. */
export interface KnowledgePurgePage {
  documents: number;
  chunks: number;
  contents: number;
  /** Missing after the last page. */
  next?: KnowledgePurgeCursor;
}

/**
 * The documents and contents of a Knowledge Base that keeps documents, as its index job and
 * its operations reach them. Index writes lock one content. Removal shares the documents
 * writer lock with adding files so shared content cannot be adopted while it is purged.
 */
export interface KnowledgeProcessingContent {
  contentSha256: string;
  processingKey?: string;
  requestedProcessingKey?: string;
  processorRevision?: string;
  format: KnowledgeDocumentFormat;
  documentId: string;
  fileId: string;
  name: string;
  path: string;
  mime: string;
  sourceId?: string;
}
/** Compiled first-match rules; regexes use the shared glob compiler, never raw SQL. */
export interface KnowledgeProcessingRule {
  match: { path?: readonly string[]; name?: readonly string[]; mime?: readonly string[] };
  keys: Record<KnowledgeDocumentFormat, string>;
  processorRevision: string;
}
export interface KnowledgeProcessingGroup {
  processingKey: string;
  processorRevision: string;
  count: number;
  tokens: number;
  fingerprint: string;
  unestimated: number;
}
export interface KnowledgeDocumentStore {
  readonly fieldExtraction?: import("./knowledge-fields").KnowledgeFieldStore;
  /** Authorizes one effective processing revision after publish confirmation, before queuing it. */
  requestProcessing(
    input: { contentSha256: string; processingKey: string },
    signal?: AbortSignal
  ): Promise<void>;
  /** Cheap release-version check; no classification or chunk reads. */
  hasOutdatedProcessor(revisions: readonly string[], signal?: AbortSignal): Promise<boolean>;
  /** One set-based review, grouped by effective type/fingerprint; no per-content reads. */
  processingSummary(
    input: {
      previous: readonly KnowledgeProcessingRule[];
      next: readonly KnowledgeProcessingRule[];
    },
    signal?: AbortSignal
  ): Promise<KnowledgeProcessingGroup[]>;
  /** Background reconciliation walks content metadata in bounded hash order. */
  processingContents(
    input: { after: string; limit: number },
    signal?: AbortSignal
  ): Promise<KnowledgeProcessingContent[]>;
  /** Withdraws the named documents in one statement. Queues cleanup before commit while
   * holding the documents lock; a rolled-back withdrawal leaves a harmless cleanup job. */
  withdrawDocuments(
    documentIds: readonly string[],
    queue: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<number>;
  /**
   * Deletes one page of withdrawn documents among `documentIds` (of every document, then of
   * every content no document holds, on retirement), at most `limit`, after `after`, in a
   * transaction of its own under the documents lock. Pages are committed one by one, so a
   * purge cut short continues where it stopped, and a page that fails rolls back its rows.
   *
   * `remove.files` deletes the copies no document outside the page names, with their objects,
   * and answers the ids whose object stayed; the documents naming those stay as their record.
   * `remove.extractions` then deletes the extraction results of the contents no remaining
   * document holds, and answers the hashes whose object stayed; those contents and their
   * documents stay. What stays is tried again by the next purge, not by the next page.
   */
  purgeDocumentPage(
    input: {
      documentIds?: readonly string[];
      after?: KnowledgePurgeCursor;
      limit: number;
    },
    remove: {
      files(fileIds: string[]): Promise<string[]>;
      extractions(contentSha256s: string[]): Promise<string[]>;
    },
    signal?: AbortSignal
  ): Promise<KnowledgePurgePage>;
  /** Releases one bounded page of synced originals only after content leaves pending.
   * Holds the documents lock, then the content row through `release`, so Retry, fetch and
   * removal cannot change the decision mid-delete. Returns the last file id of a full page. */
  releaseOriginalPage(
    input: {
      contentSha256: string;
      fileIds?: readonly string[];
      afterFileId?: string;
      limit: number;
    },
    release: (fileIds: string[]) => Promise<void>,
    signal?: AbortSignal
  ): Promise<string | undefined>;
  readContent(
    contentSha256: string,
    signal?: AbortSignal
  ): Promise<KnowledgeContentToIndex | undefined>;
  /**
   * The document, not withdrawn and with its content indexed, that names `fileId`: what a
   * document tool reads on a search hit's file id (KB-7c). None for any other file.
   */
  documentOfFile(fileId: string, signal?: AbortSignal): Promise<KnowledgeFileDocument | undefined>;
  /**
   * Replaces the content's chunks with `chunks` at the revisions, in one transaction, and marks
   * it `extracted` where `complete`; otherwise it stays `pending` until `completeContent`, as a
   * content whose chunks are still to be embedded does. Nothing where the content is gone.
   */
  writeChunks(
    input: {
      contentSha256: string;
      chunkingRevision: number;
      extractionRevision: number;
      processingKey?: string;
      requestedProcessingKey?: string;
      processorRevision?: string;
      documentType?: string;
      pageCount: number;
      chunks: readonly KnowledgeChunkInput[];
      complete: boolean;
    },
    signal?: AbortSignal
  ): Promise<void>;
  /**
   * Marks a `pending` content whose chunks are written at `chunkingRevision` `extracted`: it is
   * indexed. Nothing where it is gone, failed or chunked at another revision meanwhile.
   */
  completeContent(
    input: { contentSha256: string; chunkingRevision: number },
    signal?: AbortSignal
  ): Promise<void>;
  /** Notes on a `pending` content why it waits, until it is completed, failed or retried. */
  waitContent(
    input: { contentSha256: string; code: KnowledgeDocumentWaitCode },
    signal?: AbortSignal
  ): Promise<void>;
  /** The generations of embeddings being served or built, by generation. */
  embeddingGenerations(signal?: AbortSignal): Promise<KnowledgeEmbeddingGeneration[]>;
  /**
   * Starts generation 1 with `model` where the Knowledge Base has no generation yet: its row,
   * `active` at once because there is no older one to answer meanwhile, and its table of
   * vectors typed by the model's dimensions. Answers the generations being served or built
   * after, which are the existing ones where another call started one first.
   */
  startFirstGeneration(
    model: KnowledgeEmbeddingModel,
    signal?: AbortSignal
  ): Promise<KnowledgeEmbeddingGeneration[]>;
  /**
   * Starts a generation `building` beside the active one with `model` (KB-8): its row, with the
   * passages search reads now as its goal, and its table of vectors. One being built with the
   * same model is answered as it is; one being built with another model is retired and its
   * table dropped. Search keeps answering from the active generation meanwhile.
   */
  startGeneration(
    model: KnowledgeEmbeddingModel,
    signal?: AbortSignal
  ): Promise<KnowledgeEmbeddingGeneration>;
  /**
   * Up to `limit` passages that search reads and that have no vector in the generation, of
   * every content, in a stable order, each with the document its prefix is made of.
   */
  passagesToReindex(
    input: { generation: number; limit: number },
    signal?: AbortSignal
  ): Promise<KnowledgePassageToReindex[]>;
  /**
   * Makes the generation being built `active` in one transaction, where every passage search
   * reads has its vector there: the active one is retired and its table dropped in the same
   * transaction, so no search sees the passages of two models. Answers whether it switched; a
   * passage still without a vector, or a generation no longer being built, leaves all as is.
   */
  switchGeneration(
    generation: number,
    signal?: AbortSignal
  ): Promise<{ switched: boolean; retired?: number }>;
  /**
   * Retires the generations and drops their tables in one transaction, an active one too, as
   * the switch does: no search sees a table that is gone. Answers those it retired; one no
   * longer being served or built is left.
   */
  retireGenerations(generations: readonly number[], signal?: AbortSignal): Promise<number[]>;
  /**
   * What a re-index into a new generation would embed, and the size of the store now. With
   * `missingFrom`, only the passages that have no vector in that generation (KB-SEM-1).
   */
  reindexEstimate(
    input: { missingFrom?: number },
    signal?: AbortSignal
  ): Promise<KnowledgeReindexEstimate>;
  /** The generations being served or built, with their progress, by generation. */
  generationProgress(signal?: AbortSignal): Promise<KnowledgeEmbeddingGenerationProgress[]>;
  /**
   * Up to `limit` passages of the content at the chunking revision that have no vector in the
   * generation, in order.
   */
  passagesToEmbed(
    input: { contentSha256: string; chunkingRevision: number; generation: number; limit: number },
    signal?: AbortSignal
  ): Promise<KnowledgePassageToEmbed[]>;
  /**
   * Writes one vector per passage into the generation, of one content or of many. The contents
   * of the passages are held against a rewrite of their chunks while it writes. A passage that
   * has one keeps it, and one removed meanwhile gets none. Answers how many were written.
   */
  writeEmbeddings(
    input: {
      generation: KnowledgeEmbeddingGeneration;
      vectors: readonly { chunkId: string; vector: readonly number[] }[];
    },
    signal?: AbortSignal
  ): Promise<number>;
  /** Removes the content's chunks and marks it `failed` with `code`. */
  failContent(
    input: { contentSha256: string; code: KnowledgeDocumentFailureCode; pageCount?: number },
    signal?: AbortSignal
  ): Promise<void>;
  /** The documents not withdrawn, newest first, one page after `cursor`. */
  listDocuments(
    input: { limit: number; cursor?: string },
    signal?: AbortSignal
  ): Promise<{
    documents: KnowledgeDocumentEntry[];
    nextCursor?: string;
    summary?: { count: number; state: KnowledgeDocumentState; lastIngestedAt?: string };
  }>;
  /**
   * The failed contents of the named documents not withdrawn: what a retry puts back, read
   * before it does so that their stored extraction failures are gone first.
   */
  failedContents(
    documentIds: readonly string[],
    signal?: AbortSignal
  ): Promise<{ contentSha256: string; format: KnowledgeDocumentFormat }[]>;
  /**
   * Puts the failed contents of the named documents back to `pending`. Answers each named
   * document that is not withdrawn, in the order named; an unknown id is left out.
   */
  retryDocuments(
    documentIds: readonly string[],
    signal?: AbortSignal
  ): Promise<KnowledgeRetriedDocument[]>;
  /**
   * The passages that answer `query` best, at most `limit`, from documents not withdrawn, in
   * one read of the store. With `embed` and an active generation of embeddings, the query's
   * embedding is one of the lists fused; without, full text and titles alone.
   */
  search(
    input: { query: string; limit: number; embed?: KnowledgeQueryEmbedding },
    signal?: AbortSignal
  ): Promise<KnowledgeSearchAnswer>;
}
