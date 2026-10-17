import { z } from "zod";
import {
  AppError,
  enqueueKnowledgeIndex,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_DOCUMENT_FAILURE_CODES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_DOCUMENT_STATES,
  KNOWLEDGE_DOCUMENT_WAIT_CODES,
  KNOWLEDGE_EXTRACTED_FORMATS,
  KNOWLEDGE_OPERATION_PREFIX,
  type KnowledgeDocumentStore,
  type KnowledgeFiles,
  type OperationDefinition,
  type OperationResource
} from "@work-shape/catalyst-core";
import { discardUnusableKnowledgeExtraction } from "./index-job";
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
const RETRY_MAX = 100;

const LIST_TIMEOUT_MS = 30_000;
const RETRY_TIMEOUT_MS = 60_000;

const listInputSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(LIST_MAX).optional(),
  cursor: z.string().min(1).max(1_000).optional()
});

const documentSchema = z.object({
  id: z.string(),
  /** The copy the Knowledge Base owns. */
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  /** The size of the copy in bytes. */
  bytes: z.number().int(),
  state: z.enum(KNOWLEDGE_DOCUMENT_STATES),
  failureCode: z.enum(KNOWLEDGE_DOCUMENT_FAILURE_CODES).optional(),
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

const retryInputSchema = z.strictObject({
  documentIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(RETRY_MAX, {
      error: `A retry names at most ${RETRY_MAX} documents. Send the rest in another call.`
    })
});

const retryOutputSchema = z.object({
  /** Each named document that is in the Knowledge Base, with its state after the retry. */
  documents: z.array(z.object({ id: z.string(), state: z.enum(KNOWLEDGE_DOCUMENT_STATES) })),
  /** How many contents were queued to be indexed again. */
  queued: z.number().int()
});

/** The Knowledge Base the operations serve. */
interface DocumentsTarget {
  name: string;
  assetId: string;
  resource: OperationResource;
  store: KnowledgeDocumentStore;
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
      const sizes = new Map<string, number>(copies.map((copy) => [copy.id, copy.byteSize]));
      return {
        documents: page.documents.map((document) => ({
          ...document,
          bytes: sizes.get(document.fileId) ?? 0
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
    scope: "data_store_rows:write",
    auth: "principal",
    inputSchema: retryInputSchema,
    outputSchema: retryOutputSchema,
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: RETRY_TIMEOUT_MS,
    async execute(input, context) {
      const { documentIds } = retryInputSchema.parse(input);
      const named = [...new Set(documentIds)];
      const failed = await knowledgeBase.store.failedContents(named, context.runtime.signal);
      for (const content of failed) {
        if (!KNOWLEDGE_EXTRACTED_FORMATS.some((format) => format === content.format)) continue;
        await discardUnusableKnowledgeExtraction(files, {
          knowledgeBaseId: knowledgeBase.assetId,
          contentSha256: content.contentSha256
        });
      }
      const documents = await knowledgeBase.store.retryDocuments(named, context.runtime.signal);
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
        documents: documents.map(({ id, state }) => ({ id, state })),
        queued: contents.size
      };
    }
  };
}
