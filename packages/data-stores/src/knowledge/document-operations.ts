import { initialSyncIds } from "./builtin/source-lifecycle";
import type { KnowledgeBaseDefinition } from "./definition";
import { z } from "zod";
import {
  AppError,
  MANAGED_FILE_STATUSES,
  enqueueKnowledgeIndex,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_DOCUMENT_FAILURE_CODES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_DOCUMENT_STATES,
  KNOWLEDGE_DOCUMENT_WAIT_CODES,
  KNOWLEDGE_EXTRACTED_FORMATS,
  KNOWLEDGE_OPERATION_PREFIX,
  KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
  knowledgeRetryInputSchema,
  knowledgeRetryOutputSchema,
  type KnowledgeDocumentStore,
  type KnowledgeFiles,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";
import { discardUnusableKnowledgeExtraction } from "./index-extraction";
import type { KnowledgeRuntime } from "./runtime";

// The documents of a Knowledge Base that keeps them, as its page shows and retries them.
//
// `knowledge.<id>.list_documents` (right `knowledge_base.use`): the documents not removed,
// newest first, with their state. It is a read for the page and leaves no Operation Run, so
// the file names it answers are kept nowhere. Every user of a Knowledge Base reaches every
// document in it (spec, "Documents in a Knowledge Base", 4).
//
// `knowledge.<id>.retry` (right `knowledge_base.write`): puts a failed document back to
// `pending` and queues its index job; a `pending` one is queued again, which recovers a job
// that was lost; an indexed one is left as it is. A failed PDF or DOCX is extracted afresh:
// before the contents go back to `pending`, the stored failure or empty result an index job
// left is deleted, while a result with text is kept. Its run keeps document ids and counts.

/** How many documents one page of the list holds by default, and at most. */
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

/** How many documents one retry names at most. */

const LIST_TIMEOUT_MS = 30_000;
const RETRY_TIMEOUT_MS = 60_000;

const listInputSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LIST_MAX).optional(),
  cursor: z.string().min(1).max(1_000).optional()
});

const documentSchema = z.object({
  id: z.string(),
  fieldsPending: z.boolean().optional(),
  fieldsPendingReason: z
    .discriminatedUnion("reason", [
      z.object({ reason: z.literal("monthly_budget") }),
      z.object({
        reason: z.literal("token_budget"),
        estimatedTokens: z.number(),
        maxTokensPerDocument: z.number()
      })
    ])
    .optional(),
  /** The copy the Knowledge Base owns. */
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  /** The size of the copy in bytes. */
  bytes: z.number().int(),
  originalStatus: z.enum(MANAGED_FILE_STATUSES).exclude(["deleted"]).optional(),
  state: z.enum(KNOWLEDGE_DOCUMENT_STATES),
  failureCode: z.enum(KNOWLEDGE_DOCUMENT_FAILURE_CODES).optional(),
  /** Current release-config limit, so Retry after an operator raises it names the new limit. */
  failurePageLimit: z.number().int().positive().optional(),
  /** Detected pages when conversion took too long. */
  failurePageCount: z.number().int().positive().optional(),
  /** Why a `pending` document waits, such as a usage limit that refuses its embedding. */
  waitCode: z.enum(KNOWLEDGE_DOCUMENT_WAIT_CODES).optional(),
  /** The source the document was synced from: only source withdrawal removes it. */
  sourceId: z.string().optional(),
  addedAt: z.string(),
  updatedAt: z.string()
});

const listOutputSchema = z.object({
  documents: z.array(documentSchema),
  /** Present while more documents follow: pass it as `cursor` for the next page. */
  nextCursor: z.string().optional()
});

/** The Knowledge Base the operations serve. */
interface DocumentsTarget {
  name: string;
  assetId: string;
  resource: OperationResource;
  store: KnowledgeDocumentStore;
  definition?: KnowledgeBaseDefinition;
}

export function listDocumentsOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: DocumentsTarget
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.list_documents`,
    effect: "reading",
    action: KNOWLEDGE_BASE_ACTIONS.use,
    scope: "data_store_rows:read",
    auth: "principal",
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: LIST_TIMEOUT_MS,
    async execute(input, context) {
      const { limit, cursor } = listInputSchema.parse(input);
      const page = await knowledgeBase.store.listDocuments(
        { limit: limit ?? LIST_DEFAULT, ...(cursor === undefined ? {} : { cursor }) },
        context.runtime.signal
      );
      const copies = await runtime.stores.files.listOwnedManagedFilesById({
        clientInstanceId: runtime.clientInstanceId,
        owner: { kind: "knowledge_base", id: knowledgeBase.assetId },
        fileIds: page.documents.map((document) => document.fileId)
      });
      const filesById = new Map(copies.map((copy) => [String(copy.id), copy]));
      return {
        documents: page.documents.map((document) => ({
          ...document,
          ...(document.failureCode === "knowledge_file_too_many_pages"
            ? { failurePageLimit: runtime.maxPages ?? KNOWLEDGE_MAX_PAGES_PER_DOCUMENT }
            : {}),
          bytes: filesById.get(document.fileId)?.byteSize ?? 0,
          originalStatus:
            filesById.get(document.fileId)?.status === "released" ? "released" : "available"
        })),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor })
      };
    }
  };
}

export function retryDocumentsOperation(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  knowledgeBase: DocumentsTarget
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.retry`,
    effect: "changing",
    // It runs the indexing of documents already added again.
    changeClass: "reversible",
    action: KNOWLEDGE_BASE_ACTIONS.write,
    scope: "config_assets:write",
    auth: "principal",
    inputSchema: knowledgeRetryInputSchema,
    outputSchema: knowledgeRetryOutputSchema,
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: RETRY_TIMEOUT_MS,
    async execute(input, context) {
      const parsed = knowledgeRetryInputSchema.parse(input);
      const definitions = knowledgeBase.definition?.sources ?? [];
      if ("source" in parsed && !definitions.some((source) => source.id === parsed.source))
        throw new AppError("NOT_FOUND", "The Knowledge Base source is not available");
      let sourceQueued = 0;
      if (runtime.sources)
        for (const source of definitions) {
          if ("source" in parsed && parsed.source !== source.id) continue;
          sourceQueued += await runtime.sources.retry(
            knowledgeBase.assetId,
            parsed,
            { ...initialSyncIds(knowledgeBase.assetId, source.id), operationRunId: context.runId },
            context.runtime.signal ?? new AbortController().signal,
            files
          );
        }
      if (!("documentIds" in parsed)) return { queued: sourceQueued };
      const synced = runtime.sources
        ? new Set(
            await runtime.sources.syncedDocumentIds(
              knowledgeBase.assetId,
              parsed.documentIds,
              context.runtime.signal ?? new AbortController().signal
            )
          )
        : new Set<string>();
      const syncedDocuments = await knowledgeBase.store.retryDocuments(
        [...synced],
        context.runtime.signal
      );
      const named = [...new Set(parsed.documentIds)].filter((id) => !synced.has(id));
      if (!named.length)
        return {
          documents: syncedDocuments.map(({ id, state }) => ({ id, state })),
          queued: sourceQueued
        };
      const failed = await knowledgeBase.store.failedContents(
        named,
        context.runtime.signal ?? new AbortController().signal
      );
      for (const content of failed) {
        if (!KNOWLEDGE_EXTRACTED_FORMATS.some((format) => format === content.format)) continue;
        await discardUnusableKnowledgeExtraction(files, {
          knowledgeBaseId: knowledgeBase.assetId,
          contentSha256: content.contentSha256
        });
      }
      const documents = await knowledgeBase.store.retryDocuments(
        named,
        context.runtime.signal ?? new AbortController().signal
      );
      if (documents.length === 0) {
        throw new AppError(
          "NOT_FOUND",
          `None of the named documents is in Knowledge Base '${knowledgeBase.name}'.`,
          { reason: "knowledge_documents_not_found" },
          { exposeMessage: true }
        );
      }
      const contents = new Map(
        documents
          .filter((document) => document.state === "pending")
          .map((document) => [document.contentSha256, document.fileId])
      );
      for (const [contentSha256, fileId] of contents) {
        await enqueueKnowledgeIndex(
          runtime.stores.jobs,
          {
            knowledgeBaseId: knowledgeBase.assetId,
            contentSha256,
            fileId,
            operationRunId: context.runId
          },
          { clientInstanceId: runtime.clientInstanceId, dedupe: true }
        );
      }
      return {
        documents: [...documents, ...syncedDocuments]
          .sort(
            (left, right) =>
              parsed.documentIds.indexOf(left.id) - parsed.documentIds.indexOf(right.id)
          )
          .map(({ id, state }) => ({ id, state })),
        queued: contents.size + sourceQueued
      };
    }
  };
}
