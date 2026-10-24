import { LIVE_ONCE_AUDIT, type PlatformEventDefinition } from "./definition";

// Counts of the physical cleanup, shared by document removal and Knowledge Base deletion.
const KNOWLEDGE_PURGE_AUDIT: Omit<PlatformEventDefinition, "name"> = {
  subject: "config_asset",
  legacy: false,
  audited: true,
  phases: ["after"],
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["documents", "chunks", "contents", "files", "objects", "extractionResults"],
    properties: {
      documents: { type: "integer", minimum: 0 },
      chunks: { type: "integer", minimum: 0 },
      contents: { type: "integer", minimum: 0 },
      files: { type: "integer", minimum: 0 },
      objects: { type: "integer", minimum: 0 },
      extractionResults: { type: "integer", minimum: 0 }
    }
  }
};

export const knowledgeBaseEvents = {
  // Files added to a Knowledge Base: the copies it now owns, by id, how many and their bytes.
  // The subject is the Knowledge Base's asset. It names no file name, because the names of
  // personal documents name people, and nothing a file holds.
  "knowledge_base.sync_started": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.sync_started" },
  "knowledge_base.sync_finished": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.sync_finished" },
  "knowledge_base.source_added": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.source_added" },
  // A re-index into a new generation of embeddings (KB-8): the generation, the binding and the
  // counts, never a passage or a file name. Finished is the switch, or the build given up.
  "knowledge_base.reindex_started": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.reindex_started" },
  "knowledge_base.reindex_finished": {
    ...LIVE_ONCE_AUDIT,
    name: "knowledge_base.reindex_finished"
  },
  "knowledge_base.source_narrowed": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.source_narrowed" },
  "knowledge_base.source_removed": { ...LIVE_ONCE_AUDIT, name: "knowledge_base.source_removed" },
  "knowledge_base.files_added": {
    name: "knowledge_base.files_added",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBase", "fileIds", "count", "bytes"],
      properties: {
        knowledgeBase: { type: "string" },
        fileIds: { type: "array", items: { type: "string" } },
        count: { type: "integer", minimum: 1 },
        bytes: { type: "integer", minimum: 0 }
      }
    }
  },
  // Removal records ids and counts; content, titles and file names stay in the store.
  "knowledge_base.documents_removed": {
    name: "knowledge_base.documents_removed",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["documentIds", "documents"],
      properties: {
        documentIds: { type: "array", items: { type: "string" } },
        documents: { type: "integer", minimum: 0 }
      }
    }
  },
  "knowledge_base.documents_purged": {
    ...KNOWLEDGE_PURGE_AUDIT,
    name: "knowledge_base.documents_purged"
  },
  "knowledge_base.deleted": { ...KNOWLEDGE_PURGE_AUDIT, name: "knowledge_base.deleted" },
  // One content indexed or failed: ids, counts and a failure code, never its text or file name.
  // For files added by hand only: a content of a synced source emits none, and its sync is
  // audited per run with counts (SRC-0).
  "knowledge_base.content_indexed": {
    name: "knowledge_base.content_indexed",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBase", "fileId"],
      properties: {
        knowledgeBase: { type: "string" },
        fileId: { type: "string" },
        chunks: { type: "integer", minimum: 1 },
        pages: { type: "integer", minimum: 1 }
      }
    }
  },
  // One search of a Knowledge Base's documents. The subject is the Knowledge Base's asset. It
  // keeps a SHA-256 of the query, never the query, and no passage or file name: how many
  // passages it answered, the ranked lists it fused and how long it took.
  "knowledge_base.searched": {
    name: "knowledge_base.searched",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["knowledgeBase", "queryHash", "results", "signals", "durationMs"],
      properties: {
        knowledgeBase: { type: "string" },
        queryHash: { type: "string" },
        results: { type: "integer", minimum: 0 },
        signals: { type: "array", items: { type: "string" } },
        durationMs: { type: "integer", minimum: 0 }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
