import type { AgentConfig } from "@work-shape/catalyst-asset-schemas";
import { KNOWLEDGE_CHECK_STATUSES } from "@work-shape/catalyst-asset-schemas";
import type { AssetKindActions } from "./asset-kinds";
import type { ConnectionsStore } from "./connections";
import type { DataStoreRecordsStore, DataStoreRows, DataStoreStatement } from "./data-stores";
import { z } from "zod";
import type { AuthenticatedIdentity } from "./identity";
import type { ClientInstanceId } from "./ids";
import type { JobsStore } from "./jobs";
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
// writes the document's row into the store. Nothing is sent anywhere and nothing is searched
// yet. Runs and audit rows name file ids, counts and bytes, never a file name. Spec: Embeddings
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

/**
 * The operations an agent reaches through its one knowledge tool: the query of each
 * Knowledge Base its definition lists. An agent calls these and no other Knowledge Base.
 */
export function knowledgeOperationNamesOf(
  agent: Pick<AgentConfig, "knowledgeBases">
): readonly string[] {
  return (agent.knowledgeBases ?? []).map(knowledgeQueryOperationName);
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
 * What a check of a Knowledge Base found. `needs_attention` where a described table cannot be
 * read, the backend cannot be reached, or the store a Knowledge Base owns is not ready: a
 * query then fails. A Knowledge Base on a Data Store is not published in that state.
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

/** The rows a backend writes beside a publish, bound to the publish's transaction. */
export interface KnowledgeBackendStores {
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
    signal?: AbortSignal
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

/** The last check of a Knowledge Base, as the platform keeps it. */
export interface KnowledgeBaseState extends KnowledgeCheckResult {
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
export const KNOWLEDGE_DOCUMENT_FORMATS = ["txt", "markdown", "pdf", "docx"] as const;

export type KnowledgeDocumentFormat = (typeof KNOWLEDGE_DOCUMENT_FORMATS)[number];

/** The formats an instance reads without the document-processing capability. */
export const KNOWLEDGE_TEXT_FORMATS: readonly KnowledgeDocumentFormat[] = ["txt", "markdown"];

/**
 * The largest file a Knowledge Base takes, as document processing takes it. A larger file is
 * refused when it is added, with this limit named.
 */
export const KNOWLEDGE_FILE_MAX_BYTES = 25 * 1024 * 1024;

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
 * served by the document-processing capability in its worker, which calls no model.
 */
export const KNOWLEDGE_BASE_EXTRACT_JOB_KIND = "knowledge_base.extract";

/**
 * The job that chunks one content's text, writes its chunks and, where the Knowledge Base
 * searches by meaning, embeds them.
 */
export const KNOWLEDGE_BASE_INDEX_JOB_KIND = "knowledge_base.index";

/**
 * What a job of either kind carries: ids only, never a file name or text. The run is the one of
 * `knowledge.<id>.add_files` whose files caused the work, for the usage it causes.
 */
export interface KnowledgeContentJobPayload {
  /** The id of the Knowledge Base's asset, which is also the id of the store it owns. */
  knowledgeBaseId: string;
  /** The content: the SHA-256 of the file's bytes, in hex. */
  contentSha256: string;
  /** The Managed File the Knowledge Base owns that holds the bytes. */
  fileId: string;
  operationRunId: string;
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
