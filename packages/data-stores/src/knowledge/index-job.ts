import {
  AppError,
  asManagedFileId,
  defineJobHandler,
  enqueueKnowledgeExtract,
  enqueueKnowledgeIndex,
  isModelUsageLimitReached,
  KNOWLEDGE_BASE_ASSET_KIND,
  KNOWLEDGE_EXTRACTED_FORMATS,
  knowledgeExtractionKey,
  knowledgeExtractionResultSchema,
  knowledgeIndexJob,
  ObjectNotFound,
  readObjectBytes,
  type AssetScope,
  type AuditRecorder,
  type BuiltinKnowledgeTarget,
  type ClientInstanceId,
  type Job,
  type JobControl,
  type KnowledgeContentJobPayload,
  type KnowledgeDocumentFailureCode,
  type KnowledgeDocumentFormat,
  type KnowledgeDocumentStore,
  type KnowledgeDocumentWaitCode,
  type KnowledgeEmbeddingGeneration,
  type KnowledgeExtractedFormat,
  type KnowledgeExtractionResult,
  type KnowledgeFiles,
  type RegisteredJobHandler,
  type SystemModelAttribution
} from "@work-shape/catalyst-core";
import {
  chunkKnowledgeText,
  decodeKnowledgeText,
  estimateKnowledgeTokens,
  KNOWLEDGE_CHUNKING_REVISION,
  KNOWLEDGE_TEXT_EXTRACTION_REVISION,
  knowledgeChunkPrefix,
  normalizeKnowledgeText,
  type KnowledgeTextPage
} from "./builtin/chunking";
import {
  approvedEmbeddingModel,
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf,
  type KnowledgeEmbedding
} from "./definition";
import type { KnowledgeRuntime } from "./runtime";

// `knowledge_base.index`: one content of a Knowledge Base on the built-in backend, from its
// bytes to its passages in the store the Knowledge Base owns. Spec: Embeddings and documents on
// the built-in backend, "Ingestion as jobs".
//
//   pending ── index job ──> extracted (the page shows `indexed`)
//      │            └──────> failed, with a code (Retry puts it back to pending)
//      ├─ PDF or DOCX: the job asks for extraction (`knowledge-extraction.ts` in core) and
//      │  ends; the extract job queues this job again once the text is stored.
//      └─ searching by meaning: the chunks are written, the content stays pending until every
//         chunk has its vector, then it is extracted. A usage limit or the provider's 429 makes
//         the job queue itself for later and end (KB-5d).
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
// Embeddings (KB-5d), only where the published revision lists `semantic`: a Knowledge Base
// without it makes no embedding call and has no vectors.
// - Generation 1 is started with the instance's default embedding binding when the Knowledge
//   Base has no generation yet. Its model and dimensions are recorded with it, and its vectors
//   go into `embeddings_1` as `halfvec(<dimensions>)`.
// - A later change of the default or of the binding re-embeds nothing by itself: a generation
//   whose binding is gone from release config, or now names another model or another length,
//   gets no vector here. KB-8's re-index starts a generation for the new model.
// - Passages that have no vector in a generation being served or built are sent through
//   `gateway.embed`, the passage with its prefix (title, file name, heading), in batches of up
//   to 2,048 passages and up to `KNOWLEDGE_EMBEDDING_BATCH_TOKENS` estimated tokens, prefixes
//   counted. A batch the provider still refuses as too large is split in two, so the same
//   request is never sent twice; a single passage it refuses fails the content. The skip rule:
//   a passage with a vector makes no call, so a rerun after a crash pays only for what is
//   missing.
// - Usage: `knowledge_embedding`, attributed to the Operation Run of the call that queued the
//   job (`add_files` or `retry`), its person, and the Knowledge Base's workspace. Admission
//   counts it against the limits; a limit that refuses it leaves the content pending with
//   `knowledge_usage_limit_reached`, and the job queues itself to look again. A provider's 429
//   that outlasts the gateway's own waits queues the job for its `Retry-After`. Neither uses
//   up an attempt.
//
// Sensitive data. The job reads the document's text and writes it into the store only, and
// sends the passages of a Knowledge Base that searches by meaning to its approved embedding
// binding (region `eu`, enforced by release config). The audit event
// `knowledge_base.content_indexed` names the Knowledge Base, the file id, the counts or the
// failure code; logs name ids and codes. Neither holds a file name or text.

/**
 * The most passages one embedding call carries: the provider's cap on texts per request
 * (`MODEL_EMBEDDING_MAX_TEXTS_PER_CALL` of the gateway).
 */
export const KNOWLEDGE_EMBEDDING_BATCH = 2_048;

/**
 * The most estimated tokens one embedding call carries, all its texts with their prefixes.
 * Azure OpenAI takes at most 300,000 input tokens in one request; the estimate counts close to
 * a tokenizer for German and English text but can fall short on long compounds and other
 * scripts, so the bound keeps half of the cap. A provider that still refuses a batch as too
 * large gets it in halves.
 */
const KNOWLEDGE_EMBEDDING_BATCH_TOKENS = 150_000;

/** How long ingestion waits before it asks again while a usage limit refuses its calls. */
export const KNOWLEDGE_USAGE_LIMIT_WAIT_MS = 30 * 60_000;

/** How long ingestion waits on a provider's 429 that names no pause. */
const KNOWLEDGE_RATE_LIMIT_WAIT_MS = 60_000;

/** What an embedding call of the index job carries: `gateway.embed`'s call. */
export interface KnowledgeEmbedCall {
  binding: { bindingId: string };
  texts: readonly string[];
  attribution: SystemModelAttribution & { purpose: "knowledge_embedding" };
  clientInstanceId: ClientInstanceId;
  /** Ties the usage event to the job. */
  correlationId: string;
  signal?: AbortSignal;
}

/** How the index job embeds passages: the process's `gateway.embed`. */
export type KnowledgeEmbed = (call: KnowledgeEmbedCall) => Promise<{ vectors: number[][] }>;

/** What the index job needs beside the Knowledge Base runtime. */
export interface KnowledgeIndexJobInput {
  files: KnowledgeFiles;
  auditRecorder: AuditRecorder;
  /** The approved embedding models and the default, as release config names them. */
  embedding: KnowledgeEmbedding;
  embed: KnowledgeEmbed;
}

/** The Knowledge Base a job names, while it is published on the built-in backend. */
interface IndexTarget {
  target: BuiltinKnowledgeTarget;
  store: KnowledgeDocumentStore;
  /** Who owns the Knowledge Base: its workspace is the one embedding usage counts against. */
  scope: AssetScope;
}

async function indexTargetOf(
  runtime: KnowledgeRuntime,
  knowledgeBaseId: string
): Promise<IndexTarget | undefined> {
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
  return store && { target, store, scope: asset.scope };
}

/**
 * How long a failed embedding call makes the job wait, and what the page says meanwhile; or
 * nothing where the error is one the job's own retries are for.
 */
function waitOf(error: unknown): { ms: number; code?: KnowledgeDocumentWaitCode } | undefined {
  if (isModelUsageLimitReached(error)) {
    return { ms: KNOWLEDGE_USAGE_LIMIT_WAIT_MS, code: "knowledge_usage_limit_reached" };
  }
  if (!(error instanceof AppError) || error.code !== "RATE_LIMITED") return undefined;
  // The gateway's rate limit keeps the provider's error, with the pause of its `Retry-After`.
  const cause: unknown = error.cause;
  const retryAfterMs =
    typeof cause === "object" &&
    cause !== null &&
    "retryAfterMs" in cause &&
    typeof cause.retryAfterMs === "number" &&
    cause.retryAfterMs > 0
      ? cause.retryAfterMs
      : undefined;
  return { ms: retryAfterMs ?? KNOWLEDGE_RATE_LIMIT_WAIT_MS };
}

/**
 * Whether the provider refused an embedding call for its size: Azure's and OpenAI's 400
 * `max_tokens_per_request`, or a 413. Read from the fields of the gateway's provider error,
 * which this package does not import.
 */
function refusedAsTooLarge(error: unknown): boolean {
  if (!(error instanceof AppError) || !("status" in error)) return false;
  if (error.status === 413) return true;
  return (
    error.status === 400 &&
    "providerCode" in error &&
    error.providerCode === "max_tokens_per_request"
  );
}

/**
 * Packs the texts, in order, into batches of at most `maxTokens` estimated tokens each. A text
 * above the bound alone is a batch of its own.
 */
function batchesByTokens<T extends { text: string }>(
  items: readonly T[],
  maxTokens: number
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const itemTokens = estimateKnowledgeTokens(item.text);
    if (batch.length > 0 && tokens + itemTokens > maxTokens) {
      batches.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(item);
    tokens += itemTokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The text a passage is embedded as: its prefix line, then its text. */
function embeddingText(
  document: { title: string; fileName: string },
  passage: { heading?: string; text: string }
): string {
  const prefix = knowledgeChunkPrefix({
    title: document.title,
    fileName: document.fileName,
    ...(passage.heading === undefined ? {} : { heading: passage.heading })
  });
  return prefix.length > 0 ? `${prefix}\n\n${passage.text}` : passage.text;
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
  const { files, auditRecorder, embedding, embed } = input;

  async function audit(
    payload: KnowledgeContentJobPayload,
    target: BuiltinKnowledgeTarget,
    correlationId: string,
    outcome:
      | { chunks?: number; pages?: number; embedded?: number }
      | { code: KnowledgeDocumentFailureCode }
  ): Promise<void> {
    const failed = "code" in outcome;
    await auditRecorder.record({
      type: "knowledge_base.content_indexed",
      status: failed ? "failed" : "success",
      subject: payload.knowledgeBaseId,
      correlationId,
      ...(failed ? { reason: outcome.code } : {}),
      metadata: { knowledgeBase: target.name, fileId: payload.fileId, ...(failed ? {} : outcome) }
    });
  }

  /** Who and what the embedding calls of a job are counted for. */
  async function attributionOf(
    payload: KnowledgeContentJobPayload,
    scope: AssetScope
  ): Promise<KnowledgeEmbedCall["attribution"]> {
    const run = await runtime.stores.operationRuns.get({
      clientInstanceId: runtime.clientInstanceId,
      id: payload.operationRunId
    });
    return {
      kind: "system",
      purpose: "knowledge_embedding",
      operationRunId: payload.operationRunId,
      // A service principal's call has no person; its run names it.
      ...(run?.actor.kind === "user" ? { userId: run.actor.id } : {}),
      ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {})
    };
  }

  /**
   * Embeds the content's passages that have no vector in a generation being served or built,
   * starting generation 1 where there is none. Answers how many vectors it wrote, that the
   * job queued itself to go on later, or that the provider refuses a passage as too large.
   */
  async function embedContent(
    job: Job<KnowledgeContentJobPayload>,
    control: JobControl,
    found: IndexTarget,
    document: { title: string; fileName: string }
  ): Promise<{ vectors: number } | "waits" | "too_large"> {
    const { payload } = job;
    const { signal } = control;
    const { store } = found;
    let generations: KnowledgeEmbeddingGeneration[] = await store.embeddingGenerations(signal);
    if (generations.length === 0) {
      const model = approvedEmbeddingModel(embedding, embedding.defaultBinding);
      // No model approved: semantic search is refused on the instance, and nothing is sent.
      if (!model) return { vectors: 0 };
      generations = await store.startFirstGeneration(model, signal);
    }
    let attribution: KnowledgeEmbedCall["attribution"] | undefined;
    let vectors = 0;
    const sent = new Set<string>();
    for (const generation of generations) {
      const model = approvedEmbeddingModel(embedding, generation.bindingId);
      // The binding is gone, or embeds with another model now: never mix two models in one
      // generation. Its re-index is KB-8's.
      if (model?.model !== generation.model || model.dimensions !== generation.dimensions) {
        continue;
      }
      for (;;) {
        const passages = await store.passagesToEmbed(
          {
            contentSha256: payload.contentSha256,
            chunkingRevision: KNOWLEDGE_CHUNKING_REVISION,
            generation: generation.generation,
            limit: KNOWLEDGE_EMBEDDING_BATCH
          },
          signal
        );
        if (passages.length === 0) break;
        for (const passage of passages) {
          const key = `${generation.generation}:${passage.chunkId}`;
          // A passage sent once in this job and asked for again did not keep its vector:
          // stop before the same text is paid for twice.
          if (sent.has(key)) {
            throw new AppError("INTERNAL", "An embedded passage was offered for embedding again");
          }
          sent.add(key);
        }
        attribution ??= await attributionOf(payload, found.scope);
        const queue = batchesByTokens(
          passages.map((passage) => ({
            chunkId: passage.chunkId,
            text: embeddingText(document, passage)
          })),
          KNOWLEDGE_EMBEDDING_BATCH_TOKENS
        );
        for (let batch = queue.shift(); batch; batch = queue.shift()) {
          let answer: { vectors: number[][] };
          try {
            answer = await embed({
              binding: { bindingId: generation.bindingId },
              texts: batch.map((item) => item.text),
              attribution,
              clientInstanceId: runtime.clientInstanceId,
              correlationId: job.correlationId,
              signal
            });
          } catch (error) {
            if (refusedAsTooLarge(error)) {
              // No passage is above the provider's limit for one input, so a single one refused
              // will be refused again: the content fails rather than pay for the same refusal.
              if (batch.length === 1) return "too_large";
              const half = Math.ceil(batch.length / 2);
              queue.unshift(batch.slice(0, half), batch.slice(half));
              control.logger.info(
                { knowledgeBaseId: payload.knowledgeBaseId, passages: batch.length },
                "The provider refused an embedding batch as too large; it is split"
              );
              continue;
            }
            const wait = waitOf(error);
            if (!wait) throw error;
            if (wait.code) {
              await store.waitContent(
                { contentSha256: payload.contentSha256, code: wait.code },
                signal
              );
            }
            await control.transaction((stores) =>
              enqueueKnowledgeIndex(stores.jobs, payload, {
                clientInstanceId: runtime.clientInstanceId,
                runAfter: new Date(runtime.now().getTime() + wait.ms)
              })
            );
            control.logger.info(
              {
                knowledgeBaseId: payload.knowledgeBaseId,
                waitMs: wait.ms,
                reason: wait.code ?? "rate_limited"
              },
              "Embedding a content waits"
            );
            return "waits";
          }
          vectors += await store.writeEmbeddings(
            {
              contentSha256: payload.contentSha256,
              generation,
              vectors: batch.map((item, index) => {
                const vector = answer.vectors[index];
                if (!vector) throw new AppError("INTERNAL", "The embedding answer misses a vector");
                return { chunkId: item.chunkId, vector };
              })
            },
            signal
          );
        }
        if (passages.length < KNOWLEDGE_EMBEDDING_BATCH) break;
      }
    }
    return { vectors };
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
      // A failure waits for Retry.
      if (content.state === "failed") return;
      const semantic = target.methods.includes("semantic");
      const chunked = content.chunkingRevision === KNOWLEDGE_CHUNKING_REVISION;
      // The skip rule. A Knowledge Base that searches by meaning looks for passages without a
      // vector, which costs no call where there are none.
      if (content.state === "extracted" && chunked && !semantic) return;
      const { document } = content;
      let written: { chunks: number; pages: number } | undefined;
      if (!chunked) {
        const pages = await pagesOf(runtime, files, control, payload, {
          format: content.format,
          fileId: document.fileId
        });
        if (pages.kind === "requested") return;
        if (pages.kind === "failed") {
          await store.failContent(
            { contentSha256: payload.contentSha256, code: pages.code },
            signal
          );
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
            chunks,
            complete: !semantic
          },
          signal
        );
        written = { chunks: chunks.length, pages: pages.pages.length };
        if (!semantic) {
          await audit(payload, target, job.correlationId, written);
          return;
        }
      }
      // Chunks written while the Knowledge Base searched by meaning, and it no longer does:
      // nothing is embedded.
      const embedded = semantic ? await embedContent(job, control, found, document) : undefined;
      if (embedded === "waits") return;
      if (embedded === "too_large") {
        await store.failContent(
          { contentSha256: payload.contentSha256, code: "knowledge_index_failed" },
          signal
        );
        await audit(payload, target, job.correlationId, { code: "knowledge_index_failed" });
        return;
      }
      await store.completeContent(
        { contentSha256: payload.contentSha256, chunkingRevision: KNOWLEDGE_CHUNKING_REVISION },
        signal
      );
      if (written || (embedded?.vectors ?? 0) > 0 || content.state !== "extracted") {
        await audit(payload, target, job.correlationId, {
          ...written,
          ...(embedded ? { embedded: embedded.vectors } : {})
        });
      }
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
