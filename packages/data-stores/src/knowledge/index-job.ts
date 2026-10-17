import {
  asManagedFileId,
  defineJobHandler,
  enqueueKnowledgeExtract,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_EXTRACTED_FORMATS,
  knowledgeExtractionKey,
  knowledgeExtractionResultSchema,
  knowledgeIndexJob,
  ObjectNotFound,
  readObjectBytes,
  type AuditRecorder,
  type BuiltinKnowledgeTarget,
  type JobControl,
  type KnowledgeContentJobPayload,
  type KnowledgeDocumentFailureCode,
  type KnowledgeDocumentFormat,
  type KnowledgeDocumentStore,
  type KnowledgeExtractedFormat,
  type KnowledgeExtractionResult,
  type KnowledgeFiles,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import {
  chunkKnowledgeText,
  decodeKnowledgeText,
  KNOWLEDGE_CHUNKING_REVISION,
  KNOWLEDGE_TEXT_EXTRACTION_REVISION,
  normalizeKnowledgeText,
  type KnowledgeTextPage
} from "./builtin/chunking";
import { knowledgeBaseDefinitionSchema, knowledgeTargetOf } from "./definition";
import type { KnowledgeRuntime } from "./runtime";

// `knowledge_base.index`: one content of a Knowledge Base on the built-in backend, from its
// bytes to its passages in the store the Knowledge Base owns. Spec: Embeddings and documents on
// the built-in backend, "Ingestion as jobs".
//
//   pending ── index job ──> extracted (the page shows `indexed`)
//      │            └──────> failed, with a code (Retry puts it back to pending)
//      └─ PDF or DOCX: the job asks for extraction (`knowledge-extraction.ts` in core) and
//         ends; the extract job queues this job again once the text is stored.
//
// - TXT and Markdown are read here. PDF and DOCX need the extract job of the document worker;
//   on an instance without document processing they fail with
//   `knowledge_file_format_unavailable`, as adding them is refused there.
// - The skip rule: a content whose chunks were written at the current chunking revision is not
//   read again, and a PDF whose stored extraction holds text is not extracted again, also when
//   a new chunking revision indexes it once more. A stored failure, a result that does not
//   parse and one without text are never used twice: the job deletes the result before it
//   marks the content failed, and Retry deletes what an interrupted job left, so a retried
//   PDF or DOCX is always extracted afresh.
// - Idempotent: a rerun replaces the content's chunks, whose ids are content, revision and
//   position. A failure that another attempt cannot help marks the content failed and ends
//   the job; any other error is retried with the kind's backoff, and the last attempt marks
//   the content `knowledge_index_failed`.
//
// Sensitive data. The job reads the document's text and writes it into the store only. The
// audit event `knowledge_base.content_indexed` names the Knowledge Base, the file id, the
// counts or the failure code; logs name ids and codes. Neither holds a file name or text.

/** What the index job needs beside the Knowledge Base runtime. */
export interface KnowledgeIndexJobInput {
  files: KnowledgeFiles;
  auditRecorder: AuditRecorder;
}

/** The Knowledge Base a job names, while it is published on the built-in backend. */
async function indexTargetOf(
  runtime: KnowledgeRuntime,
  knowledgeBaseId: string
): Promise<{ target: BuiltinKnowledgeTarget; store: KnowledgeDocumentStore } | undefined> {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: knowledgeBaseId
  });
  if (!record || record.status === "retired" || record.ownerKnowledgeBaseId === undefined) {
    return undefined;
  }
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: KNOWLEDGE_BASE_ASSET_KIND,
    name: record.ownerKnowledgeBaseId
  });
  if (!asset || asset.id !== knowledgeBaseId || asset.status !== "active") return undefined;
  const definition = knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig);
  if (!definition.success) return undefined;
  const target = knowledgeTargetOf(definition.data, knowledgeBaseId);
  if (target.backend !== "builtin") return undefined;
  const store = runtime.backend.documentStore(target);
  return store && { target, store };
}

function isExtracted(format: KnowledgeDocumentFormat): format is KnowledgeExtractedFormat {
  return KNOWLEDGE_EXTRACTED_FORMATS.some((each) => each === format);
}

/** The text of a content, a failure that no attempt can help, or a request for extraction. */
type Pages =
  | { kind: "pages"; pages: KnowledgeTextPage[]; extractionRevision: number }
  | { kind: "failed"; code: KnowledgeDocumentFailureCode }
  | { kind: "requested" };

async function readCopy(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  knowledgeBaseId: string,
  fileId: string
): Promise<Uint8Array | undefined> {
  const copy = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(fileId)
  });
  if (copy?.owner?.kind !== "knowledge_base" || copy.owner.id !== knowledgeBaseId) {
    return undefined;
  }
  try {
    return await readObjectBytes(files.objects, copy.objectKey);
  } catch (error) {
    if (error instanceof ObjectNotFound) return undefined;
    throw error;
  }
}

/** The content an extraction result is stored for. */
interface ContentKey {
  knowledgeBaseId: string;
  contentSha256: string;
}

async function readExtraction(
  files: KnowledgeFiles,
  content: ContentKey
): Promise<KnowledgeExtractionResult | "invalid" | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readObjectBytes(
      files.objects,
      knowledgeExtractionKey(content.knowledgeBaseId, content.contentSha256)
    );
  } catch (error) {
    if (error instanceof ObjectNotFound) return undefined;
    throw error;
  }
  try {
    return knowledgeExtractionResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return "invalid";
  }
}

/**
 * Why a stored extraction result cannot be indexed, or nothing where it can: it holds text. A
 * failure, a result that does not parse and one without text are asked for again on Retry.
 */
function unusableExtraction(
  result: KnowledgeExtractionResult | "invalid"
): KnowledgeDocumentFailureCode | undefined {
  if (result === "invalid") return "knowledge_extraction_failed";
  if (result.status === "failed") return result.code;
  const hasText = result.pages.some((page) => normalizeKnowledgeText(page.text).trim().length > 0);
  return hasText ? undefined : "knowledge_text_empty";
}

/**
 * Deletes the stored extraction of a content where it cannot be indexed: what Retry runs
 * before a failed PDF or DOCX is queued again, so it is extracted afresh. A result with text
 * is kept and indexed again without extraction.
 */
export async function discardUnusableKnowledgeExtraction(
  files: KnowledgeFiles,
  content: ContentKey
): Promise<void> {
  const result = await readExtraction(files, content);
  if (result === undefined || unusableExtraction(result) === undefined) return;
  await files.objects.delete(
    knowledgeExtractionKey(content.knowledgeBaseId, content.contentSha256)
  );
}

async function pagesOf(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  control: JobControl,
  payload: KnowledgeContentJobPayload,
  content: { format: KnowledgeDocumentFormat; fileId: string }
): Promise<Pages> {
  if (!isExtracted(content.format)) {
    const bytes = await readCopy(runtime, files, payload.knowledgeBaseId, content.fileId);
    if (!bytes) return { kind: "failed", code: "knowledge_file_missing" };
    const text = decodeKnowledgeText(bytes);
    if (text === undefined) return { kind: "failed", code: "knowledge_text_unreadable" };
    return {
      kind: "pages",
      pages: [{ text }],
      extractionRevision: KNOWLEDGE_TEXT_EXTRACTION_REVISION
    };
  }
  if (!runtime.documentFormats.includes(content.format)) {
    return { kind: "failed", code: "knowledge_file_format_unavailable" };
  }
  const result = await readExtraction(files, payload);
  const unusable = result === undefined ? undefined : unusableExtraction(result);
  if (unusable !== undefined) {
    // Deleted before the content is marked failed: a job that ends between the two finds no
    // result and asks for the extraction again, and a failed content keeps no result for its
    // Retry to read.
    await files.objects.delete(
      knowledgeExtractionKey(payload.knowledgeBaseId, payload.contentSha256)
    );
    return { kind: "failed", code: unusable };
  }
  if (result !== undefined && result !== "invalid" && result.status === "extracted") {
    return {
      kind: "pages",
      pages: result.pages.map((page) => ({
        page: page.page,
        text: normalizeKnowledgeText(page.text)
      })),
      extractionRevision: result.extractionRevision
    };
  }
  const { format } = content;
  await control.transaction((stores) =>
    enqueueKnowledgeExtract(
      stores.jobs,
      { ...payload, fileId: content.fileId, format },
      { clientInstanceId: runtime.clientInstanceId }
    )
  );
  return { kind: "requested" };
}

/** The handler of `knowledge_base.index`, for the process that serves the Knowledge Bases. */
export function createKnowledgeIndexJobHandler(
  runtime: KnowledgeRuntime,
  input: KnowledgeIndexJobInput
): RegisteredJobHandler {
  const { files, auditRecorder } = input;

  async function audit(
    payload: KnowledgeContentJobPayload,
    target: BuiltinKnowledgeTarget,
    correlationId: string,
    outcome: { chunks: number; pages: number } | { code: KnowledgeDocumentFailureCode }
  ): Promise<void> {
    const failed = "code" in outcome;
    await auditRecorder.record({
      type: "knowledge_base.content_indexed",
      status: failed ? "failed" : "success",
      subject: payload.knowledgeBaseId,
      correlationId,
      ...(failed ? { reason: outcome.code } : {}),
      metadata: {
        knowledgeBase: target.name,
        fileId: payload.fileId,
        ...(failed ? {} : { chunks: outcome.chunks, pages: outcome.pages })
      }
    });
  }

  return defineJobHandler({
    kind: knowledgeIndexJob,
    slots: 2,
    async run(job, control) {
      const { payload } = job;
      const { signal } = control;
      const found = await indexTargetOf(runtime, payload.knowledgeBaseId);
      // A Knowledge Base deleted or no longer on the built-in backend has nothing to index.
      if (!found) return;
      const { target, store } = found;
      const content = await store.readContent(payload.contentSha256, signal);
      // A content no document holds any more is removed with its documents (KB-5e).
      if (!content?.document) return;
      // The skip rule, and a failure that waits for Retry.
      if (content.state === "failed") return;
      if (
        content.state === "extracted" &&
        content.chunkingRevision === KNOWLEDGE_CHUNKING_REVISION
      ) {
        return;
      }
      const { document } = content;
      const pages = await pagesOf(runtime, files, control, payload, {
        format: content.format,
        fileId: document.fileId
      });
      if (pages.kind === "requested") return;
      if (pages.kind === "failed") {
        await store.failContent({ contentSha256: payload.contentSha256, code: pages.code }, signal);
        await audit(payload, target, job.correlationId, { code: pages.code });
        return;
      }
      const chunks = chunkKnowledgeText({
        format: content.format,
        pages: pages.pages,
        title: document.title,
        fileName: document.fileName
      });
      if (chunks.length === 0) {
        await store.failContent(
          { contentSha256: payload.contentSha256, code: "knowledge_text_empty" },
          signal
        );
        await audit(payload, target, job.correlationId, { code: "knowledge_text_empty" });
        return;
      }
      await store.writeChunks(
        {
          contentSha256: payload.contentSha256,
          chunkingRevision: KNOWLEDGE_CHUNKING_REVISION,
          extractionRevision: pages.extractionRevision,
          pageCount: pages.pages.length,
          chunks
        },
        signal
      );
      await audit(payload, target, job.correlationId, {
        chunks: chunks.length,
        pages: pages.pages.length
      });
    },
    async onExhausted(job) {
      const { payload } = job;
      try {
        const found = await indexTargetOf(runtime, payload.knowledgeBaseId);
        if (!found) return;
        await found.store.failContent({
          contentSha256: payload.contentSha256,
          code: "knowledge_index_failed"
        });
        await audit(payload, found.target, job.correlationId, { code: "knowledge_index_failed" });
      } catch (error) {
        // The content stays `pending`; Retry queues it again.
        runtime.logger.warn(
          {
            knowledgeBaseId: payload.knowledgeBaseId,
            errorName: error instanceof Error ? error.name : "unknown"
          },
          "Marking a content failed after its last index attempt failed"
        );
      }
    }
  });
}
