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
  type AuthenticatedIdentity,
  type KnowledgeDocumentStore,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  enqueueDropUnusedEmbeddings,
  publishDropsEmbeddings,
  publishReindexReview,
  reindexStatementLines,
  startPublishedReindex
} from "./reindex";
import { knowledgeProcessingOf, knowledgeDocumentTypesSchema } from "./document-types";
import {
  knowledgeBaseDefinitionSchema,
  knowledgeTargetOf,
  type KnowledgeBaseDefinition,
  type KnowledgeEmbedding
} from "./definition";
import type { KnowledgeRuntime } from "./runtime";
import { initialSyncIds } from "./builtin/source-lifecycle";

/** What re-embedding the affected contents costs, as a reader words it. */
export type KnowledgeProcessingCost =
  | { kind: "none" }
  | { kind: "estimate"; min: number; max: number; currency: string }
  | { kind: "unavailable" };

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
async function knowledgeProcessingReview(
  runtime: KnowledgeRuntime,
  config: unknown,
  previous: unknown,
  assetId: string,
  embedding: KnowledgeEmbedding,
  draftOnly = false,
  /** Where the store's record is read: a publish passes the rows of its transaction. */
  records: DataStoreRecordsStore = runtime.stores.dataStores,
  locale?: string
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
  // A store whose tables are not made yet, as right after the first publish, holds nothing to
  // process again. Its record is ready before its tables are.
  if (record?.status !== "ready" || record.migrations.length === 0) return undefined;
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
  const embeddingCost: KnowledgeProcessingCost = !next.methods.includes("semantic")
    ? { kind: "none" }
    : price
      ? {
          kind: "estimate",
          min: ((tokens * price.perMillionTokens) / 1_000_000) * 0.5,
          max: ((conservativeTokens * price.perMillionTokens) / 1_000_000) * 2,
          currency: price.currency
        }
      : { kind: "unavailable" };
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
    cost: embeddingCost,
    confirmation,
    lines: [
      processingSentence(count, embeddingCost, locale),
      `Confirm with assets.publish confirmProcessing: '${confirmation}' (CLI: --confirm ${confirmation}).`
    ],
    priced: !next.methods.includes("semantic") || price !== undefined
  };
}

/**
 * What a publish processes again and what that costs, in the reader's language (German or
 * English) and as the Studio publish dialog words it from the same fields.
 */
function processingSentence(
  count: number,
  cost: KnowledgeProcessingCost,
  locale: string | undefined
): string {
  const de = locale === "de";
  const format = (value: number, options: Intl.NumberFormatOptions = {}) =>
    new Intl.NumberFormat(de ? "de-DE" : "en-US", options).format(value);
  const read = de
    ? count === 1
      ? "1 Dokument wird mit den neuen Einstellungen noch einmal gelesen."
      : `${format(count)} Dokumente werden mit den neuen Einstellungen noch einmal gelesen.`
    : count === 1
      ? "1 document is read again with the new settings."
      : `${format(count)} documents are read again with the new settings.`;
  if (cost.kind === "none")
    return `${read} ${de ? "Das kostet nichts, weil nichts eingebettet wird." : "This costs nothing, because nothing is embedded."}`;
  if (cost.kind === "unavailable")
    return `${read} ${
      de
        ? "Für das Einbettungsmodell ist kein Preis hinterlegt, darum sind die Kosten unbekannt und die Veröffentlichung ist noch nicht möglich."
        : "The embedding model has no price set, so the cost is unknown and this cannot be published yet."
    }`;
  // Cents from one unit up; below it two significant digits, so a small estimate never reads 0.
  const amount = (value: number) =>
    `${format(
      value,
      cost.max >= 1 || cost.max === 0
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { maximumSignificantDigits: 2 }
    )} ${cost.currency}`;
  return `${read} ${
    de
      ? `Das Lesen ist kostenlos. Das Einbetten der Ergebnisse kostet geschätzt ${amount(cost.min)} bis ${amount(cost.max)}, möglicherweise mehr.`
      : `Reading them is free. Embedding the results costs an estimated ${amount(cost.min)} to ${amount(cost.max)}, possibly more.`
  }`;
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

/**
 * What a publish of a Knowledge Base asks to be confirmed: documents processed again
 * (`knowledgeProcessingReview`) and the embedding model changed (KB-8), as one statement with
 * one confirmation. Nothing where it changes neither.
 */
export async function knowledgePublishReview(
  runtime: KnowledgeRuntime,
  input: {
    config: unknown;
    previous: unknown;
    assetId: string;
    embedding: KnowledgeEmbedding;
    draftOnly?: boolean;
    records?: DataStoreRecordsStore;
    locale?: string;
  }
) {
  const records = input.records ?? runtime.stores.dataStores;
  const processing = await knowledgeProcessingReview(
    runtime,
    input.config,
    input.previous,
    input.assetId,
    input.embedding,
    input.draftOnly ?? false,
    records,
    input.locale
  );
  const reindex = await publishReindexReview(runtime, {
    assetId: input.assetId,
    config: input.config,
    previous: input.previous,
    embedding: input.embedding,
    records
  });
  if (!processing && !reindex) return undefined;
  const confirmation =
    processing && reindex
      ? createHash("sha256")
          .update(`${processing.confirmation}:${reindex.statement.confirmation}`)
          .digest("hex")
      : (processing?.confirmation ?? reindex?.statement.confirmation ?? "");
  // The processing statement without its own line on how to confirm.
  const statement = [
    ...(processing ? processing.lines.slice(0, -1) : []),
    ...(reindex ? reindexStatementLines(reindex.statement, input.locale) : [])
  ];
  return {
    processing,
    reindex,
    confirmation,
    priced: processing?.priced ?? true,
    /** What the publish does, for a reader who confirms it with a button. */
    statement,
    lines: [
      ...statement,
      `Confirm with assets.publish confirmProcessing: '${confirmation}' (CLI: --confirm ${confirmation}).`
    ]
  };
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
    /** Who publishes: a re-index it starts is counted for them. */
    actor: AuthenticatedIdentity;
  },
  embedding: KnowledgeEmbedding
) {
  const review = await knowledgePublishReview(runtime, {
    config: input.config,
    previous: input.replaced,
    assetId: input.assetId,
    embedding,
    records: stores.dataStores,
    locale: runtime.defaultLocale
  });
  // Turning `semantic` off, or setting the binding back while a re-index builds: what the
  // revision no longer uses is dropped by a job after the publish, and nothing is asked.
  const drops = await publishDropsEmbeddings(runtime, {
    assetId: input.assetId,
    config: input.config,
    previous: input.replaced,
    embedding,
    records: stores.dataStores
  });
  if (!review) {
    if (drops) await enqueueDropUnusedEmbeddings(runtime, stores, input.assetId);
    return;
  }
  if (input.confirmProcessing !== review.confirmation || !review.priced)
    throw new AppError(
      "VALIDATION_FAILED",
      review.lines.join("\n"),
      {
        reason: review.processing
          ? "knowledge_processing_confirmation_required"
          : "knowledge_reindex_confirmation_required",
        ...(review.processing ? { count: review.processing.count } : {}),
        ...(review.reindex
          ? { chunks: review.reindex.statement.chunks, tokens: review.reindex.statement.tokens }
          : {}),
        confirmation: review.confirmation
      },
      { exposeMessage: true }
    );
  if (drops) await enqueueDropUnusedEmbeddings(runtime, stores, input.assetId);
  const next = knowledgeBaseDefinitionSchema.parse(input.config);
  const before = knowledgeBaseDefinitionSchema.parse(input.replaced);
  if (review.reindex) {
    await startPublishedReindex(runtime, stores, {
      assetId: input.assetId,
      name: next.name,
      revision: input.revision,
      actor: input.actor,
      statement: review.reindex.statement
    });
  }
  if (!review.processing) return;
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
