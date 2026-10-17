import { z } from "zod";
import {
  KNOWLEDGE_DOCUMENT_FAILURE_CODES,
  knowledgeProcessorOutputSchema,
  type KnowledgeProcessorOutput,
  type KnowledgeDocumentFailureCode
} from "@work-shape/catalyst-asset-schemas";
import { AppError } from "./errors";
import { asManagedFileId, type ClientInstanceId } from "./ids";
import { defineJobHandler, type RegisteredJobHandler } from "./job-handlers";
import {
  enqueueKnowledgeIndex,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
  knowledgeExtractedPagesSchema,
  knowledgeExtractJob,
  type KnowledgeContentJobPayload,
  type KnowledgeExtractedFormat,
  type KnowledgeExtractedPages,
  type KnowledgeExtractJobPayload
} from "./knowledge";
import { ObjectNotFound, readObjectBytes, type ObjectStorage } from "./object-storage";
import type { PlatformStores } from "./platform-store";

// The handoff between the index job of a Knowledge Base (platform, API process) and the
// extraction of a PDF or DOCX (the document-processing capability, its own worker process).
// Spec: data-stores-and-knowledge-bases.md, "Ingestion as jobs".
//
//   1. The index job finds no extraction result for a PDF or DOCX content and queues
//      `knowledge_base.extract` with the ids of its own payload and the format. Its content
//      stays `pending`.
//   2. The extract job reads the bytes of the Managed File the payload names, which the
//      Knowledge Base owns, and asks the capability's `KnowledgeExtractor` for the text by page.
//      It passes `knowledge.maxPagesPerDocument` of release config: the extractor counts the
//      pages before it reads their text and refuses a longer file, so it spends no conversion
//      on it.
//   3. It stores the result as one JSON object in the instance's store of files under
//      `knowledgeExtractionKey`: the pages and the extractor's revision, or a failure code.
//   4. It queues `knowledge_base.index` for the content again. That job reads the result,
//      writes the chunks, or marks the content failed. Synced content keeps its result when
//      the original is released; Retry discards unusable results and fetches again.
//
// Both steps of 3 and 4 repeat safely: a job that ends between them runs again and writes the
// same object. The object outlives both jobs, so a worker restart loses nothing, and a later
// re-index with a new chunking revision reads it instead of extracting again. It lies under
// the Knowledge Base's prefix in the store of files and goes with the content (KB-5e).
//
// Sensitive data. The object holds the document's text. It never enters a job payload, an
// error, a log line or an audit event; a failure is a code.

/**
 * The codes extraction may answer with. A `KnowledgeExtractionError` carries one; the platform
 * gives `knowledge_file_missing` and `knowledge_extraction_failed` itself.
 */
export const KNOWLEDGE_EXTRACTION_FAILURE_CODES = [
  "knowledge_file_format_unsupported",
  "knowledge_file_over_limit",
  "knowledge_file_unreadable",
  "knowledge_file_missing",
  "knowledge_extraction_failed",
  "knowledge_file_too_many_pages"
] as const satisfies readonly KnowledgeDocumentFailureCode[];

export type KnowledgeExtractionFailureCode = (typeof KNOWLEDGE_EXTRACTION_FAILURE_CODES)[number];

/**
 * What an extractor throws when another attempt cannot help: a corrupt or encrypted file, a
 * format it does not read, a file over its limits. Any other error is retried, and after the
 * last attempt the content fails with `knowledge_extraction_failed`. The message is for the
 * worker's log and never names the file or quotes its text.
 */
export class KnowledgeExtractionError extends AppError {
  readonly failureCode: KnowledgeExtractionFailureCode;

  constructor(code: KnowledgeExtractionFailureCode, message: string) {
    super("VALIDATION_FAILED", message, { reason: code });
    this.name = "KnowledgeExtractionError";
    this.failureCode = code;
  }
}

/** What the capability that reads PDF and DOCX gives the platform. It calls no model. */
export interface KnowledgeExtractor {
  /**
   * The revision of the extraction, a whole number from 1. A new one means text extracted with
   * an older one may differ; it is recorded on the content.
   */
  readonly revision: number;
  /**
   * The text of the file by page, numbered from 1 in ascending order. A file without pages
   * answers one page per section. Throws `KnowledgeExtractionError` for a file no attempt
   * can read, and with `knowledge_file_too_many_pages` for one of more than `maxPages` pages,
   * found before the text of its pages is read.
   */
  extract(input: {
    bytes: Uint8Array;
    format: KnowledgeExtractedFormat;
    maxPages: number;
    signal: AbortSignal;
  }): Promise<KnowledgeExtractedPages>;
}

/** Where the extraction result of one content is kept in the instance's store of files. */
export function knowledgeExtractionKey(knowledgeBaseId: string, contentSha256: string): string {
  return `knowledge-bases/${knowledgeBaseId}/extracted/${contentSha256}.json`;
}

/** The stored result of one extraction, as the index job reads it. */
export const knowledgeExtractionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("extracted"),
    extractionRevision: z.number().int().min(1),
    pages: knowledgeExtractedPagesSchema.shape.pages
  }),
  z.strictObject({
    status: z.literal("failed"),
    code: z.enum(KNOWLEDGE_EXTRACTION_FAILURE_CODES)
  })
]);

export type KnowledgeExtractionResult = z.infer<typeof knowledgeExtractionResultSchema>;

/** Every failure code a document can show, for a parse of a stored code. */
export const knowledgeDocumentFailureCodeSchema = z.enum(KNOWLEDGE_DOCUMENT_FAILURE_CODES);

/**
 * The work of one extract job apart from the queue: the bytes, the extractor, the result.
 * `readFile` answers nothing where the copy or its bytes are gone. A thrown error other than a
 * `KnowledgeExtractionError` is passed on, for the executor to retry.
 */
export async function runKnowledgeExtraction(input: {
  format: KnowledgeExtractedFormat;
  extractor: KnowledgeExtractor;
  /** `knowledge.maxPagesPerDocument`: a file of more pages fails with `knowledge_file_too_many_pages`. */
  maxPages: number;
  readFile(): Promise<Uint8Array | undefined>;
  signal: AbortSignal;
}): Promise<KnowledgeExtractionResult> {
  const bytes = await input.readFile();
  if (!bytes) return { status: "failed", code: "knowledge_file_missing" };
  if (bytes.byteLength > KNOWLEDGE_FILE_MAX_BYTES) {
    return { status: "failed", code: "knowledge_file_over_limit" };
  }
  let extracted: KnowledgeExtractedPages;
  try {
    extracted = await input.extractor.extract({
      bytes,
      format: input.format,
      maxPages: input.maxPages,
      signal: input.signal
    });
  } catch (error) {
    if (error instanceof KnowledgeExtractionError && !input.signal.aborted) {
      return { status: "failed", code: error.failureCode };
    }
    throw error;
  }
  const pages = knowledgeExtractedPagesSchema.safeParse(extracted);
  if (!pages.success || !ascending(pages.data.pages.map((page) => page.page))) {
    throw new AppError("INTERNAL", "The extractor answered pages outside the contract");
  }
  // The extractor refuses such a file before converting it; this holds one that does not.
  if (pages.data.pages.length > input.maxPages) {
    return { status: "failed", code: "knowledge_file_too_many_pages" };
  }
  return {
    status: "extracted",
    extractionRevision: input.extractor.revision,
    pages: pages.data.pages
  };
}

function ascending(numbers: readonly number[]): boolean {
  return numbers.every((value, index) => index === 0 || value > (numbers[index - 1] ?? 0));
}

/** Stores the result of one extraction where the index job of its content reads it. */
export async function storeKnowledgeExtraction(
  objects: Pick<ObjectStorage, "put">,
  payload: Pick<KnowledgeContentJobPayload, "knowledgeBaseId" | "contentSha256">,
  result: KnowledgeExtractionResult
): Promise<void> {
  await objects.put(
    knowledgeExtractionKey(payload.knowledgeBaseId, payload.contentSha256),
    new TextEncoder().encode(JSON.stringify(knowledgeExtractionResultSchema.parse(result))),
    { contentType: "application/json" }
  );
}

function indexPayloadOf(payload: KnowledgeContentJobPayload): KnowledgeContentJobPayload {
  const { knowledgeBaseId, contentSha256, fileId, operationRunId } = payload;
  return { knowledgeBaseId, contentSha256, fileId, operationRunId };
}

/** The bytes of a copy the Knowledge Base of `payload` owns. Nothing where it is gone. */
async function readOwnedCopy(
  stores: Pick<PlatformStores, "files">,
  objects: Pick<ObjectStorage, "get">,
  clientInstanceId: ClientInstanceId,
  payload: KnowledgeContentJobPayload
): Promise<Uint8Array | undefined> {
  const file = await stores.files.getManagedFile({
    clientInstanceId,
    fileId: asManagedFileId(payload.fileId)
  });
  if (
    file?.owner?.kind !== "knowledge_base" ||
    file.owner.id !== payload.knowledgeBaseId ||
    file.status !== "available"
  ) {
    return undefined;
  }
  try {
    return await readObjectBytes(objects, file.objectKey);
  } catch (error) {
    if (error instanceof ObjectNotFound) return undefined;
    throw error;
  }
}

/**
 * The handler of `knowledge_base.extract` for the worker that hosts `extractor`: the
 * capability registers it and writes nothing else. `objects` is the instance's store of files,
 * the one `infrastructure.objectStorage.files` names, which holds the Knowledge Base's copies.
 */
export function defineKnowledgeExtractHandler(input: {
  clientInstanceId: ClientInstanceId;
  objects: Pick<ObjectStorage, "get" | "put">;
  extractor: KnowledgeExtractor;
  /** `knowledge.maxPagesPerDocument` of release config. */
  maxPages: number;
  slots: number;
}): RegisteredJobHandler {
  const { clientInstanceId, objects, extractor, maxPages } = input;
  return defineJobHandler<KnowledgeExtractJobPayload>({
    kind: knowledgeExtractJob,
    slots: input.slots,
    async run(job, control) {
      const { payload } = job;
      const copy = await control.transaction((stores) =>
        stores.files.getManagedFile({
          clientInstanceId,
          fileId: asManagedFileId(payload.fileId)
        })
      );
      // Re-select an available copy (or fail missing) without replacing retained text.
      if (copy?.status === "released") {
        await control.transaction((stores) =>
          enqueueKnowledgeIndex(stores.jobs, indexPayloadOf(payload), { clientInstanceId })
        );
        return;
      }
      const result = await runKnowledgeExtraction({
        format: payload.format,
        extractor,
        maxPages,
        signal: control.signal,
        readFile: () =>
          control.transaction((stores) => readOwnedCopy(stores, objects, clientInstanceId, payload))
      });
      await control.transaction(async (stores) => {
        const file = await stores.files.getManagedFile({
          clientInstanceId,
          fileId: asManagedFileId(payload.fileId),
          lock: true
        });
        if (
          file?.status === "released" ||
          file?.owner?.kind !== "knowledge_base" ||
          file.owner.id !== payload.knowledgeBaseId
        ) {
          // Indexing selects a live document again. A surviving document with the same hash
          // must not stay pending because the removed copy happened to be the extractor's.
          await enqueueKnowledgeIndex(stores.jobs, indexPayloadOf(payload), { clientInstanceId });
          return;
        }
        await storeKnowledgeExtraction(objects, payload, result);
        await enqueueKnowledgeIndex(stores.jobs, indexPayloadOf(payload), { clientInstanceId });
      });
    },
    async onExhausted(job, stores) {
      // Without the stored failure the index job would ask for the extraction again, so the
      // index job is queued only once the failure is stored. Where storing fails, the content
      // stays `pending` and Retry asks again.
      const file = await stores.files.getManagedFile({
        clientInstanceId,
        fileId: asManagedFileId(job.payload.fileId),
        lock: true
      });
      if (
        file?.status === "released" ||
        file?.owner?.kind !== "knowledge_base" ||
        file.owner.id !== job.payload.knowledgeBaseId
      ) {
        await enqueueKnowledgeIndex(stores.jobs, indexPayloadOf(job.payload), { clientInstanceId });
        return;
      }
      try {
        await storeKnowledgeExtraction(objects, job.payload, {
          status: "failed",
          code: "knowledge_extraction_failed"
        });
      } catch (error) {
        if (error instanceof AppError) return;
        throw error;
      }
      await enqueueKnowledgeIndex(stores.jobs, indexPayloadOf(job.payload), { clientInstanceId });
    }
  });
}

/**
 * A check a producer of `KnowledgeExtractor` runs in its own tests: what the platform needs of
 * every extractor. Answers the problems found, none when the extractor holds to the contract.
 *
 * - `revision` is a whole number from 1.
 * - Each sample is extracted to pages numbered from 1 in ascending order, whose text holds the
 *   sample's `expectText`.
 * - `unreadable` bytes of each format end in a `KnowledgeExtractionError` with the code
 *   `knowledge_file_unreadable`, not in an error that is retried.
 */
export async function verifyKnowledgeExtractor(
  extractor: KnowledgeExtractor,
  input: {
    samples: readonly {
      format: KnowledgeExtractedFormat;
      bytes: Uint8Array;
      expectText: string;
    }[];
    unreadable: readonly { format: KnowledgeExtractedFormat; bytes: Uint8Array }[];
  }
): Promise<string[]> {
  const problems: string[] = [];
  const signal = new AbortController().signal;
  if (!(Number.isInteger(extractor.revision) && extractor.revision >= 1)) {
    problems.push(`revision ${extractor.revision} is not a whole number from 1`);
  }
  for (const [index, sample] of input.samples.entries()) {
    const name = `sample ${index + 1} (${sample.format})`;
    try {
      const result = await runKnowledgeExtraction({
        format: sample.format,
        extractor,
        maxPages: KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
        signal,
        readFile: () => Promise.resolve(sample.bytes)
      });
      if (result.status === "failed") {
        problems.push(`${name} failed with ${result.code}`);
        continue;
      }
      if (result.pages.length === 0) problems.push(`${name} has no pages`);
      const text = result.pages.map((page) => page.text).join("\n");
      if (!text.includes(sample.expectText)) {
        problems.push(`${name} does not hold the expected text`);
      }
      knowledgeExtractionResultSchema.parse(JSON.parse(JSON.stringify(result)));
    } catch (error) {
      problems.push(`${name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [index, sample] of input.unreadable.entries()) {
    const name = `unreadable ${index + 1} (${sample.format})`;
    try {
      const result = await runKnowledgeExtraction({
        format: sample.format,
        extractor,
        maxPages: KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
        signal,
        readFile: () => Promise.resolve(sample.bytes)
      });
      if (result.status !== "failed" || result.code !== "knowledge_file_unreadable") {
        problems.push(
          `${name} answered ${result.status === "failed" ? result.code : "pages"}, not knowledge_file_unreadable`
        );
      }
    } catch (error) {
      problems.push(
        `${name} threw an error that is retried instead of KnowledgeExtractionError: ${error instanceof Error ? error.name : String(error)}`
      );
    }
  }
  return problems;
}

export {
  knowledgeProcessorOutputSchema,
  type KnowledgeProcessorOutput
} from "@work-shape/catalyst-asset-schemas";

/** One refusal for a built-in processor or a data Workflow outside the frozen contract. */
export function parseKnowledgeProcessorOutput(output: unknown): KnowledgeProcessorOutput {
  const result = knowledgeProcessorOutputSchema.safeParse(output);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The processor answered output outside the Knowledge Base contract",
      { reason: "knowledge_processor_output_invalid" }
    );
  }
  return result.data;
}
