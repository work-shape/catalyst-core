import { processingRules } from "./processing-rules";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  defineJobKind,
  defineJobHandler,
  enqueueKnowledgeIndex,
  KNOWLEDGE_JOB_KINDS,
  KNOWLEDGE_FILE_MAX_BYTES,
  type DataStoreRecordsStore,
  type KnowledgeProcessingContent,
  type KnowledgeDocumentStore,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { knowledgeProcessingOf, knowledgeDocumentTypesSchema } from "./document-types";
import {
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf,
  type KnowledgeBaseDefinition,
  type KnowledgeEmbedding
} from "./definition";
import type { KnowledgeRuntime } from "./runtime";
import { initialSyncIds } from "./builtin/source-lifecycle";

// Background reconciliation only: bounded metadata pages, never document text in a job.
const PROCESSING_PAGE_CONTENTS = 100;
const knowledgeReprocessJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.reprocess,
  payloadSchema: z.strictObject({
    knowledgeBaseId: z.string(),
    knowledgeBase: z.string(),
    revision: z.number().int().positive(),
    previousTypes: z.array(z.record(z.string(), z.json())).optional()
  }),
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 600_000 },
  leaseMs: 120_000,
  concurrency: { perKey: 1 }
});
function changed(
  content: KnowledgeProcessingContent,
  before: Pick<KnowledgeBaseDefinition, "documentTypes">,
  next: KnowledgeBaseDefinition
) {
  return (
    (content.processingKey ?? knowledgeProcessingOf(before.documentTypes, content).key) !==
      knowledgeProcessingOf(next.documentTypes, content).key ||
    (content.processorRevision ?? "text@1") !==
      knowledgeProcessingOf(next.documentTypes, content).processorRevision
  );
}
async function* contents(store: KnowledgeDocumentStore, signal?: AbortSignal) {
  let after = "";
  for (;;) {
    signal?.throwIfAborted();
    const rows = await store.processingContents({ after, limit: PROCESSING_PAGE_CONTENTS }, signal);
    for (const row of rows) yield row;
    if (rows.length < PROCESSING_PAGE_CONTENTS) return;
    after = rows.at(-1)?.contentSha256 ?? after;
  }
}
export async function knowledgeProcessingReview(
  runtime: KnowledgeRuntime,
  config: unknown,
  previous: unknown,
  assetId: string,
  embedding: KnowledgeEmbedding,
  draftOnly = false,
  /** Where the store's record is read: a publish passes the rows of its transaction. */
  records: DataStoreRecordsStore = runtime.stores.dataStores
) {
  const next = knowledgeBaseDefinitionSchema.parse(config);
  const before = knowledgeBaseDefinitionSchema.safeParse(previous);
  if (!before.success || "backend" in next) return undefined;
  const previousRules = processingRules(before.data.documentTypes);
  const nextRules = processingRules(next.documentTypes);
  const record = await records.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: assetId
  });
  if (record?.status !== "ready") return undefined;
  const store = runtime.backend.documentStore(knowledgeTargetOf(next, assetId), records);
  if (!store) return undefined;
  // Unchanged rules need only a release-version check, without classifying documents or
  // reading chunks. Publish always reviews the affected set again inside its transaction.
  if (
    draftOnly &&
    JSON.stringify(previousRules) === JSON.stringify(nextRules) &&
    !(await store.hasOutdatedProcessor([
      ...new Set(nextRules.map((rule) => rule.processorRevision))
    ]))
  )
    return undefined;
  const hash = createHash("sha256").update(
    JSON.stringify([assetId, next.methods, next.documentTypes, embedding.processingPrices])
  );
  const groups = await store.processingSummary({ previous: previousRules, next: nextRules });
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  const tokens = groups.reduce((sum, group) => sum + group.tokens, 0);
  hash.update(JSON.stringify(groups));
  if (!count) return undefined;
  const generations = await store.embeddingGenerations();
  const bindings = generations.length
    ? generations
        .filter((generation) =>
          embedding.models?.some(
            (model) =>
              model.bindingId === generation.bindingId &&
              model.model === generation.model &&
              model.dimensions === generation.dimensions
          )
        )
        .map((generation) => generation.bindingId)
    : [embedding.defaultBinding];
  const rates = bindings.map((bindingId) =>
    embedding.processingPrices?.find((rate) => rate.bindingId === bindingId)
  );
  const priced = rates.every((rate) => rate !== undefined);
  const price = priced
    ? {
        currency: rates[0]?.currency ?? "USD",
        perMillionTokens: rates.reduce((sum, rate) => sum + (rate?.perMillionTokens ?? 0), 0)
      }
    : undefined;
  // Cross-database file metadata is not read one upload at a time. Until passage tokens
  // exist, use the accepted file byte limit as an explicit conservative estimate.
  const unestimated = groups.reduce((sum, group) => sum + group.unestimated, 0);
  const conservativeTokens = tokens + unestimated * Math.ceil(KNOWLEDGE_FILE_MAX_BYTES / 3);
  const basis = unestimated
    ? `existing passages/source byte sizes; ${unestimated} contents without size estimates use the ${KNOWLEDGE_FILE_MAX_BYTES}-byte file limit conservatively`
    : "existing passages or original byte sizes";
  const cost = !next.methods.includes("semantic")
    ? "0 (keyword only)"
    : price
      ? `${(((tokens * price.perMillionTokens) / 1_000_000) * 0.5).toFixed(6)}–${(((conservativeTokens * price.perMillionTokens) / 1_000_000) * 2).toFixed(6)} ${price.currency} estimated from ${basis}; changed output may cost more`
      : "embedding cost unavailable: configure the approved binding's customer rate";
  const confirmation = hash
    .update(
      JSON.stringify({
        tokens: conservativeTokens,
        ...(next.methods.includes("semantic") ? { bindings, price } : {})
      })
    )
    .digest("hex");
  return {
    count,
    confirmation,
    lines: [
      `Reprocess ${count} affected contents. Built-in processing has no model cost. Re-embedding: ${cost}. Only the affected types are reprocessed.`,
      `Confirm with assets.publish confirmProcessing: '${confirmation}' (CLI: --confirm ${confirmation}).`
    ],
    priced: !next.methods.includes("semantic") || price !== undefined
  };
}

export function createKnowledgeReprocessHandler(runtime: KnowledgeRuntime) {
  return defineJobHandler({
    kind: knowledgeReprocessJob,
    slots: 1,
    async run(job, control) {
      const { payload } = job;
      const asset = await runtime.stores.configAssets.getConfigAsset({
        clientInstanceId: runtime.clientInstanceId,
        kind: "knowledge_base",
        name: payload.knowledgeBase
      });
      if (
        !asset ||
        asset.id !== payload.knowledgeBaseId ||
        asset.publishedRevision !== payload.revision
      )
        return;
      const next = knowledgeBaseDefinitionSchema.parse(asset.publishedConfig);
      const store = runtime.backend.documentStore(knowledgeTargetOf(next, asset.id));
      if (!store) return;
      const previousTypes = payload.previousTypes
        ? knowledgeDocumentTypesSchema.parse(payload.previousTypes)
        : undefined;
      for await (const content of contents(store, control.signal)) {
        if (
          !changed(
            content,
            {
              documentTypes: previousTypes
            },
            next
          )
        )
          continue;
        const current = await runtime.stores.configAssets.getConfigAsset({
          clientInstanceId: runtime.clientInstanceId,
          kind: "knowledge_base",
          name: asset.name
        });
        if (current?.publishedRevision !== payload.revision) return;
        const processing = knowledgeProcessingOf(next.documentTypes, content);
        await store.requestProcessing(
          { contentSha256: content.contentSha256, processingKey: processing.key },
          control.signal
        );
        // Released originals must be fetched again only when the processor's output changes.
        if (
          content.sourceId &&
          runtime.sources &&
          runtime.files &&
          (content.processorRevision ?? "text@1") !== processing.processorRevision
        ) {
          await runtime.sources.retry(
            asset.id,
            { documentIds: [content.documentId] },
            {
              ...initialSyncIds(asset.id, content.sourceId),
              operationRunId: `processing:${asset.id}:${payload.revision}`
            },
            control.signal,
            runtime.files,
            true
          );
        } else
          await control.transaction((stores) =>
            enqueueKnowledgeIndex(
              stores.jobs,
              {
                knowledgeBaseId: asset.id,
                contentSha256: content.contentSha256,
                fileId: content.fileId,
                operationRunId: `processing:${asset.id}:${payload.revision}`
              },
              { clientInstanceId: runtime.clientInstanceId, dedupe: true }
            )
          );
      }
    }
  });
}

export async function confirmKnowledgeProcessing(
  runtime: KnowledgeRuntime,
  stores: PlatformStores,
  input: {
    assetId: string;
    revision: number;
    config: unknown;
    replaced: unknown;
    confirmProcessing?: string;
  },
  embedding: KnowledgeEmbedding
) {
  const review = await knowledgeProcessingReview(
    runtime,
    input.config,
    input.replaced,
    input.assetId,
    embedding,
    false,
    stores.dataStores
  );
  if (!review) return;
  if (input.confirmProcessing !== review.confirmation || !review.priced)
    throw new AppError(
      "VALIDATION_FAILED",
      review.lines.join("\n"),
      {
        reason: "knowledge_processing_confirmation_required",
        count: review.count,
        confirmation: review.confirmation
      },
      { exposeMessage: true }
    );
  const next = knowledgeBaseDefinitionSchema.parse(input.config);
  const before = knowledgeBaseDefinitionSchema.parse(input.replaced);
  await stores.jobs.enqueue(
    knowledgeReprocessJob,
    {
      knowledgeBaseId: input.assetId,
      knowledgeBase: next.name,
      revision: input.revision,
      ...(before.documentTypes
        ? { previousTypes: z.array(z.record(z.string(), z.json())).parse(before.documentTypes) }
        : {})
    },
    {
      clientInstanceId: runtime.clientInstanceId,
      subject: input.assetId,
      concurrencyKey: input.assetId
    }
  );
}
