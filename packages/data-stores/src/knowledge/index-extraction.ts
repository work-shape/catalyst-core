import type { KnowledgeProcessing } from "./document-types";
import {
  asManagedFileId,
  enqueueKnowledgeExtract,
  KNOWLEDGE_EXTRACTED_FORMATS,
  type KnowledgeProcessorOutput,
  knowledgeExtractionKey,
  knowledgeExtractionResultSchema,
  ObjectNotFound,
  readObjectBytes,
  storeKnowledgeExtraction,
  type JobControl,
  type KnowledgeContentJobPayload,
  type KnowledgeDocumentFailureCode,
  type KnowledgeDocumentFormat,
  type KnowledgeExtractedFormat,
  type KnowledgeExtractionResult,
  type KnowledgeFiles
} from "@work-shape/catalyst-core";
import {
  decodeKnowledgeText,
  KNOWLEDGE_TEXT_EXTRACTION_REVISION,
  normalizeKnowledgeText,
  type KnowledgeTextPage
} from "./builtin/chunking";
import type { KnowledgeRuntime } from "./runtime";

export function isExtracted(format: KnowledgeDocumentFormat): format is KnowledgeExtractedFormat {
  return KNOWLEDGE_EXTRACTED_FORMATS.some((each) => each === format);
}

/** The text of a content, a failure that no attempt can help, or a request for extraction. */
type Pages =
  | {
      kind: "pages";
      pages: KnowledgeTextPage[];
      extractionRevision: number;
      output?: KnowledgeProcessorOutput;
    }
  | { kind: "failed"; code: KnowledgeDocumentFailureCode; pageCount?: number }
  | { kind: "requested" };

async function availableCopy(runtime: KnowledgeRuntime, knowledgeBaseId: string, fileId: string) {
  const copy = await runtime.stores.files.getManagedFile({
    clientInstanceId: runtime.clientInstanceId,
    fileId: asManagedFileId(fileId)
  });
  if (
    copy?.owner?.kind !== "knowledge_base" ||
    copy.owner.id !== knowledgeBaseId ||
    copy.status !== "available"
  ) {
    return undefined;
  }
  return copy;
}

async function readCopy(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  knowledgeBaseId: string,
  fileId: string
): Promise<Uint8Array | undefined> {
  const copy = await availableCopy(runtime, knowledgeBaseId, fileId);
  if (!copy) return undefined;
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

export async function pagesOf(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  control: JobControl,
  payload: KnowledgeContentJobPayload,
  content: { format: KnowledgeDocumentFormat; fileId: string; synced?: boolean },
  processing?: KnowledgeProcessing
): Promise<Pages> {
  if (!isExtracted(content.format)) {
    if (content.synced) {
      const stored = await readExtraction(files, payload);
      if (stored !== undefined && stored !== "invalid" && stored.status === "extracted") {
        return {
          kind: "pages",
          pages: stored.pages.map((page) => ({ text: page.text })),
          extractionRevision: stored.extractionRevision
        };
      }
    }
    const bytes = await readCopy(runtime, files, payload.knowledgeBaseId, content.fileId);
    if (!bytes) return { kind: "failed", code: "knowledge_file_missing" };
    const text = decodeKnowledgeText(bytes);
    if (text === undefined) return { kind: "failed", code: "knowledge_text_unreadable" };
    if (content.synced)
      await storeKnowledgeExtraction(files.objects, payload, {
        status: "extracted",
        extractionRevision: KNOWLEDGE_TEXT_EXTRACTION_REVISION,
        pages: [{ page: 1, text }]
      });
    return {
      kind: "pages",
      pages: [{ text }],
      extractionRevision: KNOWLEDGE_TEXT_EXTRACTION_REVISION
    };
  }
  if (!runtime.documentFormats.includes(content.format)) {
    return { kind: "failed", code: "knowledge_file_format_unavailable" };
  }
  let result = await readExtraction(files, payload);
  if (
    result &&
    result !== "invalid" &&
    result.status === "extracted" &&
    processing &&
    (result.processorRevision ?? "text@1") !== processing.processorRevision
  )
    result = undefined;
  const unusable = result === undefined ? undefined : unusableExtraction(result);
  if (unusable !== undefined) {
    // Deleted before the content is marked failed: a job that ends between the two finds no
    // result and asks for the extraction again, and a failed content keeps no result for its
    // Retry to read.
    if (!content.synced)
      await files.objects.delete(
        knowledgeExtractionKey(payload.knowledgeBaseId, payload.contentSha256)
      );
    return {
      kind: "failed",
      code: unusable,
      ...(result !== "invalid" && result?.status === "failed" && result.pageCount !== undefined
        ? { pageCount: result.pageCount }
        : {})
    };
  }
  if (result !== undefined && result !== "invalid" && result.status === "extracted") {
    return {
      kind: "pages",
      pages: result.pages.map((page) => ({
        page: page.page,
        text: normalizeKnowledgeText(page.text)
      })),
      extractionRevision: result.extractionRevision,
      ...(result.output ? { output: result.output } : {})
    };
  }
  // Retained extraction needs no original. Without it, never hand a released or
  // missing copy to the extractor and leave the content waiting for work it cannot do.
  if (!(await availableCopy(runtime, payload.knowledgeBaseId, content.fileId))) {
    return { kind: "failed", code: "knowledge_file_missing" };
  }
  const { format } = content;
  await control.transaction((stores) =>
    enqueueKnowledgeExtract(
      stores.jobs,
      {
        ...payload,
        fileId: content.fileId,
        format,
        ...(processing
          ? { processor: processing.processor, processorRevision: processing.processorRevision }
          : {})
      },
      { clientInstanceId: runtime.clientInstanceId }
    )
  );
  return { kind: "requested" };
}
