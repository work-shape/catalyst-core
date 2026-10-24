import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  createPlatformId,
  defineJobHandler,
  defineJobKind,
  isAuthenticatedServicePrincipal,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_EMBEDDING_STATES,
  KNOWLEDGE_JOB_KINDS,
  KNOWLEDGE_OPERATION_PREFIX,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type DataStoreRecordsStore,
  type JobControl,
  type KnowledgeDocumentStore,
  type KnowledgeEmbeddingGenerationProgress,
  type KnowledgeEmbeddingModel,
  type OperationDefinition,
  type OperationResource,
  type PlatformStores,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import {
  approvedEmbeddingModel,
  knowledgeBaseDefinitionSchema,
  type BuiltinKnowledgeDefinition,
  type KnowledgeBaseDefinition,
  type KnowledgeEmbedding
} from "./definition";
import { embeddingTarget as reindexTarget, sameModel, unusedGenerations } from "./generations";
import {
  batchesByTokens,
  embeddingText,
  indexTargetOf,
  KNOWLEDGE_EMBEDDING_BATCH,
  KNOWLEDGE_EMBEDDING_BATCH_TOKENS,
  refusedAsTooLarge,
  waitOf,
  type KnowledgeEmbed
} from "./index-job";
import type { KnowledgeRuntime } from "./runtime";

// Changing the embedding model of a Knowledge Base (KB-8). Spec: data-stores-and-knowledge-bases.md,
// "Changing the embedding model", checks 24, 26, 27, 61 and 65.
//
// - The model is the binding `indexing.embedding.binding` names, else the instance's default.
//   A Knowledge Base keeps its active generation until a re-index is started: by publishing a
//   changed binding, or by `knowledge.<id>.reindex` (`catalyst knowledge-base reindex`), both
//   by a holder of `knowledge_base.publish`. A change of the default re-embeds nothing.
// - Before it starts, the statement: the passages, the estimated tokens and cost from the rate
//   card, and whether the store has room for both generations. It starts only on a
//   confirmation that names the statement's token; without it nothing starts.
// - The re-index starts a generation `building` beside the active one. This job embeds the
//   stored passages into its table, nothing is extracted again, and search keeps answering
//   from the active one. When every passage search reads has its vector, the switch makes it
//   active and drops the old table in one transaction.
// - A Knowledge Base whose active generation names a binding release config no longer has, or
//   one that now names another model, answers by words and titles alone and makes no
//   embedding call; its page says that a re-index is needed.
// - Turning `semantic` on embeds the passages already there (KB-SEM-1), with the same
//   statement and confirmation: into a generation built beside nothing, while search answers
//   by words and titles, or, where an active generation with the model is still there (turned
//   off and on before the drop below ran), into that one, only the passages it lacks.
//   `knowledge.<id>.reindex` does the same for a Knowledge Base that searches by meaning and
//   has passages but no generation, as one published before KB-SEM-1 may have.
// - What the published revision no longer uses is dropped (`generations.ts`): every generation
//   once `semantic` is turned off, and one being built with another model than the binding
//   names now, as when it is set back before the re-index finished. The publish queues this
//   job to drop it, and each run of the job drops it first; the index job embeds nothing into
//   it meanwhile.
//
// Usage: `knowledge_embedding`, attributed to the run that started the re-index, its person and
// the Knowledge Base's workspace, outside chat's limits (KB-ISO-1a). A usage limit or the
// provider's 429 makes the job queue itself for later. Audit: `knowledge_base.reindex_started`
// and `knowledge_base.reindex_finished` with the generation, the binding and counts, never a
// passage or a file name.

/** How long the statement and the start may take: two reads of the store and one write. */
const REINDEX_TIMEOUT_MS = 60_000;

/**
 * About how many bytes one vector row takes in the store beside its values: the row, the
 * chunk's id and the primary key's entry. An estimate for the room the statement names.
 */
const VECTOR_ROW_OVERHEAD_BYTES = 200;

const reindexOnlyPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  /** The binding the re-index embeds with: a later change of it supersedes this job. */
  bindingId: z.string().min(1).max(200),
  /** The run that started it, which its embedding usage is counted for. */
  operationRunId: z.string().min(1).max(200)
});

/**
 * A job of the same kind that only drops the generations the published revision no longer
 * uses: of the same kind, so it never runs beside a re-index of the same Knowledge Base.
 */
const dropUnusedPayloadSchema = z.strictObject({
  knowledgeBaseId: z.string().min(1).max(200),
  dropUnused: z.literal(true)
});

const reindexPayloadSchema = z.union([reindexOnlyPayloadSchema, dropUnusedPayloadSchema]);

type ReindexPayload = z.infer<typeof reindexOnlyPayloadSchema>;

/** One per Knowledge Base at a time; heartbeats keep its lease while it embeds. */
export const knowledgeReindexJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.reindex,
  payloadSchema: reindexPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 10 * 60_000 },
  leaseMs: 2 * 60_000,
  concurrency: { perKey: 1 }
});

/** The embedding of a Knowledge Base as its page shows it. */
export interface KnowledgeEmbeddingState {
  /**
   * `current`: the active generation embeds with the model it should. `reindex_needed`: the
   * active generation's model is gone from the instance, so search answers by words and titles
   * alone. `reindex_available`: it still answers by meaning, with another model than the one
   * it is set to. `reindexing`: a generation is being built. `none`: nothing embedded yet.
   */
  state: (typeof KNOWLEDGE_EMBEDDING_STATES)[number];
  /** The model search answers from. */
  active?: KnowledgeEmbeddingModel;
  /** The model it is set to, where the instance approves it. */
  target?: KnowledgeEmbeddingModel;
  /** The generation being built: passages embedded of its goal. */
  progress?: { embedded: number; total: number };
}

/** The state of the embedding of a Knowledge Base that searches by meaning, for its page. */
export function knowledgeEmbeddingState(
  generations: readonly KnowledgeEmbeddingGenerationProgress[],
  definition: KnowledgeBaseDefinition,
  embedding: KnowledgeEmbedding
): KnowledgeEmbeddingState {
  const target = reindexTarget(definition, embedding);
  const active = generations.find((each) => each.state === "active");
  const building = generations.find((each) => each.state === "building");
  const model = (each: KnowledgeEmbeddingModel): KnowledgeEmbeddingModel => ({
    bindingId: each.bindingId,
    model: each.model,
    dimensions: each.dimensions
  });
  const base = {
    ...(active ? { active: model(active) } : {}),
    ...(target ? { target } : {})
  };
  if (building) {
    // The model being built, which is what the switch makes active.
    return {
      ...base,
      target: model(building),
      state: "reindexing",
      progress: {
        embedded: Math.min(building.embeddedCount, building.chunkCount),
        total: building.chunkCount
      }
    };
  }
  if (!active) return { ...base, state: "none" };
  const usable = approvedEmbeddingModel(embedding, active.bindingId);
  if (!usable || !sameModel(usable, active)) return { ...base, state: "reindex_needed" };
  return { ...base, state: target && !sameModel(target, active) ? "reindex_available" : "current" };
}

/**
 * What a re-index embeds: `again`, every passage into a generation beside the active one;
 * `first`, every passage into the first generation, where none is active; `missing`, the
 * passages the active generation, already of the model, has no vector for.
 */
type KnowledgeReindexKind = "again" | "first" | "missing";

/** What a re-index would cost and whether the store has room for it, before it starts. */
export interface KnowledgeReindexStatement {
  kind: KnowledgeReindexKind;
  bindingId: string;
  model: string;
  dimensions: number;
  /** The passages it embeds: those search reads now. */
  chunks: number;
  /** Their estimated tokens, prefixes included. */
  tokens: number;
  /** From the customer rate card; missing where the model has no rate. */
  cost?: { amount: number; currency: string };
  /** Whether the store's size limit holds the vectors it adds (both generations, for `again`). */
  room: boolean;
  storeBytes: number;
  /** About what the new generation's table takes. */
  addedBytes: number;
  limitBytes?: number;
  /** What a confirmation names to start it. */
  confirmation: string;
}

/** The statement of a re-index of the Knowledge Base `assetId` to `target`. */
async function reindexStatement(
  runtime: Pick<KnowledgeRuntime, "clientInstanceId">,
  input: {
    assetId: string;
    store: KnowledgeDocumentStore;
    target: KnowledgeEmbeddingModel;
    embedding: KnowledgeEmbedding;
    records: DataStoreRecordsStore;
  },
  signal?: AbortSignal
): Promise<KnowledgeReindexStatement> {
  const { target, store, embedding } = input;
  const generations = await store.embeddingGenerations(signal);
  const active = generations.find((each) => each.state === "active");
  const kind: KnowledgeReindexKind = !active
    ? "first"
    : sameModel(active, target)
      ? "missing"
      : "again";
  const [estimate, record] = await Promise.all([
    store.reindexEstimate(
      kind === "missing" && active ? { missingFrom: active.generation } : {},
      signal
    ),
    input.records.getDataStore({ clientInstanceId: runtime.clientInstanceId, id: input.assetId })
  ]);
  const rate = embedding.processingPrices?.find((price) => price.bindingId === target.bindingId);
  const addedBytes = estimate.chunks * (target.dimensions * 2 + VECTOR_ROW_OVERHEAD_BYTES);
  const limitBytes = record?.sizeLimitBytes;
  // The confirmation names what is decided: the Knowledge Base, the model it moves from and to,
  // and the rate. Documents added meanwhile are embedded anyway and do not ask again.
  const confirmation = createHash("sha256")
    .update(
      JSON.stringify([
        "reindex",
        kind,
        input.assetId,
        active ? [active.generation, active.bindingId, active.model, active.dimensions] : null,
        [target.bindingId, target.model, target.dimensions],
        rate ? [rate.currency, rate.perMillionTokens] : null
      ])
    )
    // Whole, as `assets.publish` takes a confirmation of 64 hex digits.
    .digest("hex");
  return {
    kind,
    ...target,
    chunks: estimate.chunks,
    tokens: estimate.tokens,
    ...(rate
      ? {
          cost: {
            amount: (estimate.tokens * rate.perMillionTokens) / 1_000_000,
            currency: rate.currency
          }
        }
      : {}),
    room: limitBytes === undefined || estimate.storeBytes + addedBytes <= limitBytes,
    storeBytes: estimate.storeBytes,
    addedBytes,
    ...(limitBytes === undefined ? {} : { limitBytes }),
    confirmation
  };
}

/** The statement as lines of the publish question and the CLI, in the reader's language. */
export function reindexStatementLines(
  statement: KnowledgeReindexStatement,
  locale: string | undefined
): string[] {
  const de = locale === "de";
  const number = (value: number, digits = 0) =>
    new Intl.NumberFormat(de ? "de-DE" : "en-US", { maximumFractionDigits: digits }).format(value);
  // Cents from one unit up; below it two significant digits, so a small estimate never reads 0.
  const amount = (value: number) =>
    value >= 1 || value === 0
      ? number(value, 2)
      : new Intl.NumberFormat(de ? "de-DE" : "en-US", { maximumSignificantDigits: 2 }).format(
          value
        );
  const cost = statement.cost
    ? `${amount(statement.cost.amount)} ${statement.cost.currency}`
    : de
      ? "unbekannt, das Modell hat keinen Preis"
      : "unknown, the model has no rate";
  const megabytes = (bytes: number) => number(bytes / 1_000_000, 1);
  const again = statement.kind === "again";
  const what = de
    ? again
      ? "beide Indexe"
      : "die Vektoren"
    : again
      ? "both indexes"
      : "the vectors";
  const room = statement.room
    ? de
      ? `Der Speicher hat Platz für ${what}.`
      : `The store has room for ${what}.`
    : de
      ? `Der Speicher hat keinen Platz für ${what}: ${megabytes(statement.storeBytes)} MB belegt, etwa ${megabytes(statement.addedBytes)} MB kämen dazu, die Grenze liegt bei ${megabytes(statement.limitBytes ?? 0)} MB.`
      : `The store has no room for ${what}: ${megabytes(statement.storeBytes)} MB used, about ${megabytes(statement.addedBytes)} MB more, a limit of ${megabytes(statement.limitBytes ?? 0)} MB.`;
  const counts = de
    ? `${number(statement.chunks)} Passagen, etwa ${number(statement.tokens)} Tokens, geschätzte Kosten ${cost}`
    : `${number(statement.chunks)} passages, about ${number(statement.tokens)} tokens, estimated cost ${cost}`;
  const model = `${statement.model} (${statement.bindingId})`;
  if (de) {
    const lead = {
      again: `Neu einbetten mit ${model}: ${counts}. Nichts wird neu extrahiert, und die Suche antwortet bis zur Umstellung aus dem bisherigen Index.`,
      first: `Die vorhandenen Passagen einbetten mit ${model}: ${counts}. Nichts wird neu extrahiert, und die Suche findet über Wörter und Titel, bis jede Passage ihren Vektor hat.`,
      missing: `Die Passagen ohne Vektor einbetten mit ${model}: ${counts}. Nichts wird neu extrahiert.`
    }[statement.kind];
    return [`${lead} ${room}`];
  }
  const lead = {
    again: `Re-embed with ${model}: ${counts}. Nothing is extracted again, and search answers from the current index until the switch.`,
    first: `Embed the existing passages with ${model}: ${counts}. Nothing is extracted again, and search finds by words and titles until every passage has its vector.`,
    missing: `Embed the passages without a vector with ${model}: ${counts}. Nothing is extracted again.`
  }[statement.kind];
  return [`${lead} ${room}`];
}

/** Refuses a start where the store cannot hold both generations. */
function assertRoom(statement: KnowledgeReindexStatement, name: string): void {
  if (statement.room) return;
  throw new AppError(
    "CONFLICT",
    `Knowledge Base '${name}' cannot be re-indexed: its store holds ${statement.storeBytes} bytes, the new index needs about ${statement.addedBytes} more, and its size limit is ${statement.limitBytes ?? 0} bytes.`,
    { reason: "knowledge_reindex_no_room" },
    { exposeMessage: true }
  );
}

/** Queues the job of a re-index, in `stores`' transaction where a publish holds one. */
function enqueueKnowledgeReindex(
  stores: Pick<PlatformStores, "jobs">,
  clientInstanceId: KnowledgeRuntime["clientInstanceId"],
  payload: z.infer<typeof reindexPayloadSchema>
): Promise<unknown> {
  return stores.jobs.enqueue(knowledgeReindexJob, payload, {
    clientInstanceId,
    subject: payload.knowledgeBaseId,
    concurrencyKey: payload.knowledgeBaseId
  });
}

/**
 * What a publish needs confirmed before it embeds what is stored: the statement where the
 * published revision names another binding than the one before, and the Knowledge Base
 * already has an active generation with another model; and where it turns `semantic` on over
 * passages that have no vector in a generation of the model (KB-SEM-1). Nothing otherwise: a
 * first index uses the binding as it is.
 */
export async function publishReindexReview(
  runtime: KnowledgeRuntime,
  input: {
    assetId: string;
    config: unknown;
    previous: unknown;
    embedding: KnowledgeEmbedding;
    records: DataStoreRecordsStore;
  }
): Promise<{ statement: KnowledgeReindexStatement; target: KnowledgeEmbeddingModel } | undefined> {
  const next = knowledgeBaseDefinitionSchema.safeParse(input.config);
  const before = knowledgeBaseDefinitionSchema.safeParse(input.previous);
  if (!next.success || !before.success || "backend" in next.data || "backend" in before.data) {
    return undefined;
  }
  const named = (definition: KnowledgeBaseDefinition) =>
    "backend" in definition ? undefined : definition.indexing?.embedding?.binding;
  const searchesByMeaning = (definition: KnowledgeBaseDefinition) =>
    definition.methods.some((method) => method === "semantic");
  const turnsOn = searchesByMeaning(next.data) && !searchesByMeaning(before.data);
  if (named(next.data) === named(before.data) && !turnsOn) return undefined;
  const target = reindexTarget(next.data, input.embedding);
  if (!target) return undefined;
  const store = await publishedStoreOf(runtime, input.assetId, next.data, input.records);
  if (!store) return undefined;
  const generations = await store.embeddingGenerations();
  const active = generations.find((each) => each.state === "active");
  const building = generations.find((each) => each.state === "building");
  if (building && sameModel(building, target)) return undefined;
  // Another binding over nothing embedded yet: the first index uses it.
  if (!turnsOn && (!active || sameModel(active, target))) return undefined;
  const statement = await reindexStatement(runtime, {
    assetId: input.assetId,
    store,
    target,
    embedding: input.embedding,
    records: input.records
  });
  // Turned on over no passage, or over none that lacks its vector: nothing to embed.
  if (statement.kind !== "again" && statement.chunks === 0) return undefined;
  return { statement, target };
}

/** The store of a built-in Knowledge Base a publish names, where it is made. */
async function publishedStoreOf(
  runtime: KnowledgeRuntime,
  assetId: string,
  definition: Pick<BuiltinKnowledgeDefinition, "name" | "methods">,
  records: DataStoreRecordsStore
): Promise<KnowledgeDocumentStore | undefined> {
  const record = await records.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: assetId
  });
  if (record?.status !== "ready" || record.migrations.length === 0) return undefined;
  return runtime.backend.documentStore(
    { backend: "builtin", assetId, name: definition.name, methods: definition.methods },
    records
  );
}

/**
 * Whether a publish leaves generations of embeddings its revision no longer uses
 * (`unusedGenerations`): where it turns `semantic` off, or names another binding while a
 * generation is being built. The publish then queues the job that drops them.
 */
export async function publishDropsEmbeddings(
  runtime: KnowledgeRuntime,
  input: {
    assetId: string;
    config: unknown;
    previous: unknown;
    embedding: KnowledgeEmbedding;
    records: DataStoreRecordsStore;
  }
): Promise<boolean> {
  const next = knowledgeBaseDefinitionSchema.safeParse(input.config);
  const before = knowledgeBaseDefinitionSchema.safeParse(input.previous);
  if (!next.success || !before.success || "backend" in next.data || "backend" in before.data) {
    return false;
  }
  const searchesByMeaning = (definition: KnowledgeBaseDefinition) =>
    definition.methods.some((method) => method === "semantic");
  const turnsOff = searchesByMeaning(before.data) && !searchesByMeaning(next.data);
  const named = (definition: KnowledgeBaseDefinition) =>
    "backend" in definition ? undefined : definition.indexing?.embedding?.binding;
  if (!turnsOff && named(next.data) === named(before.data)) return false;
  const store = await publishedStoreOf(runtime, input.assetId, next.data, input.records);
  if (!store) return false;
  const generations = await store.embeddingGenerations();
  return unusedGenerations(generations, next.data, input.embedding).length > 0;
}

/** Queues the job that drops what a publish no longer uses, in the publish's transaction. */
export function enqueueDropUnusedEmbeddings(
  runtime: KnowledgeRuntime,
  stores: Pick<PlatformStores, "jobs">,
  knowledgeBaseId: string
): Promise<unknown> {
  return enqueueKnowledgeReindex(stores, runtime.clientInstanceId, {
    knowledgeBaseId,
    dropUnused: true
  });
}

/**
 * Starts the re-index a publish confirmed: an Operation Run of `knowledge.<id>.reindex` in the
 * publisher's name, which its usage is counted for, and the job, in the publish's transaction.
 * The job starts the generation, because the store is not part of that transaction.
 */
export async function startPublishedReindex(
  runtime: KnowledgeRuntime,
  stores: PlatformStores,
  input: {
    assetId: string;
    name: string;
    revision: number;
    actor: AuthenticatedIdentity;
    statement: KnowledgeReindexStatement;
  }
): Promise<void> {
  // A publish that would fill the store refuses, as a start from the page does.
  assertRoom(input.statement, input.name);
  const runId = createPlatformId<"OperationRunId">("oprun");
  await stores.operationRuns.create({
    id: runId,
    clientInstanceId: runtime.clientInstanceId,
    operation: `${KNOWLEDGE_OPERATION_PREFIX}${input.name}.reindex`,
    effect: "changing",
    actor: {
      kind: isAuthenticatedServicePrincipal(input.actor) ? "service_principal" : "user",
      id: input.actor.id,
      label: input.actor.displayLabel
    },
    origin: { kind: "user" },
    target: "live",
    inputHash: input.statement.confirmation,
    correlationId: runId,
    startedAt: runtime.now().toISOString()
  });
  await enqueueKnowledgeReindex(stores, runtime.clientInstanceId, {
    knowledgeBaseId: input.assetId,
    bindingId: input.statement.bindingId,
    operationRunId: runId
  });
  // Done once started, as a start from the page is: the job's own run carries the work.
  await stores.operationRuns.finish({
    clientInstanceId: runtime.clientInstanceId,
    id: runId,
    end: { status: "done", finishedAt: runtime.now().toISOString() }
  });
  await stores.audit.appendAuditEvent({
    clientInstanceId: runtime.clientInstanceId,
    type: "knowledge_base.reindex_started",
    status: "success",
    actor: auditActorFromIdentity(input.actor),
    subject: input.assetId,
    correlationId: runId,
    metadata: reindexMetadata(input.name, input.statement)
  });
}

function reindexMetadata(name: string, statement: KnowledgeReindexStatement) {
  return {
    knowledgeBase: name,
    binding: statement.bindingId,
    model: statement.model,
    chunks: statement.chunks,
    tokens: statement.tokens
  };
}

const reindexInputSchema = z.strictObject({
  /** The statement's `confirmation`: without it, or with another, nothing starts. */
  confirm: z.string().trim().min(1).max(64).optional()
});

const modelSchema = z.object({ bindingId: z.string(), model: z.string(), dimensions: z.number() });

export const knowledgeReindexOutputSchema = z.object({
  /** Whether this call started a re-index. */
  started: z.boolean(),
  /** The embedding as it is after the call. */
  state: z.enum(KNOWLEDGE_EMBEDDING_STATES),
  active: modelSchema.optional(),
  target: modelSchema.optional(),
  progress: z.object({ embedded: z.number(), total: z.number() }).optional(),
  /** What a re-index embeds and costs; where one would start or did. */
  statement: z
    .object({
      bindingId: z.string(),
      model: z.string(),
      chunks: z.number(),
      tokens: z.number(),
      cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
      room: z.boolean(),
      storeBytes: z.number(),
      addedBytes: z.number(),
      limitBytes: z.number().optional(),
      confirmation: z.string()
    })
    .optional(),
  /** The statement as sentences, in the instance's language. */
  lines: z.array(z.string()).optional()
});

/** The Knowledge Base a re-index serves. */
export interface ReindexTarget {
  name: string;
  assetId: string;
  resource: OperationResource;
  store: KnowledgeDocumentStore;
  definition: KnowledgeBaseDefinition;
}

/**
 * `knowledge.<id>.reindex` (right `knowledge_base.publish`): without `confirm` it states what a
 * re-index to the model the Knowledge Base is set to would embed and cost, and starts nothing;
 * with the statement's confirmation it starts the generation and queues the job. Where the
 * active generation already embeds with that model, or one is being built with it, it says so.
 */
export function reindexOperation(
  runtime: KnowledgeRuntime,
  embedding: KnowledgeEmbedding,
  knowledgeBase: ReindexTarget
): OperationDefinition {
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.reindex`,
    effect: "changing",
    // It embeds what is there again; the old index answers until the switch.
    changeClass: "reversible",
    action: KNOWLEDGE_BASE_ACTIONS.publish,
    scope: "config_assets:write",
    auth: "principal",
    inputSchema: reindexInputSchema,
    outputSchema: knowledgeReindexOutputSchema,
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: REINDEX_TIMEOUT_MS,
    async execute(input, context) {
      const { confirm } = reindexInputSchema.parse(input);
      const { signal } = context.runtime;
      const { store, definition } = knowledgeBase;
      if (!definition.methods.some((method) => method === "semantic")) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Knowledge Base '${knowledgeBase.name}' does not search by meaning, so it has no embeddings to re-index.`,
          { reason: "knowledge_reindex_not_semantic" },
          { exposeMessage: true }
        );
      }
      const target = reindexTarget(definition, embedding);
      if (!target) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Knowledge Base '${knowledgeBase.name}' has no approved embedding model to re-index with: name an approved binding in 'indexing.embedding.binding' and publish, or ask the operator to approve one.`,
          { reason: "knowledge_reindex_no_model" },
          { exposeMessage: true }
        );
      }
      const stateNow = async () =>
        knowledgeEmbeddingState(await store.generationProgress(signal), definition, embedding);
      const before = await stateNow();
      if (before.state === "current") return { started: false, ...before };
      const building = before.state === "reindexing";
      const generations = await store.embeddingGenerations(signal);
      if (
        building &&
        generations.some((each) => each.state === "building" && sameModel(each, target))
      ) {
        return { started: false, ...before };
      }
      const statement = await reindexStatement(
        runtime,
        {
          assetId: knowledgeBase.assetId,
          store,
          target,
          embedding,
          records: runtime.stores.dataStores
        },
        signal
      );
      // Nothing embedded yet and no passage to embed: the first index starts the generation.
      if (before.state === "none" && statement.chunks === 0) return { started: false, ...before };
      const lines = reindexStatementLines(statement, runtime.defaultLocale);
      if (confirm !== statement.confirmation) {
        return { started: false, ...before, statement, lines };
      }
      assertRoom(statement, knowledgeBase.name);
      // Started here, so the page shows it at once; the job finds it started.
      const generation = await store.startGeneration(target, signal);
      await enqueueKnowledgeReindex(runtime.stores, runtime.clientInstanceId, {
        knowledgeBaseId: knowledgeBase.assetId,
        bindingId: target.bindingId,
        operationRunId: context.runId
      });
      await context.audit.record({
        type: "knowledge_base.reindex_started",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        subject: knowledgeBase.assetId,
        correlationId: context.correlationId,
        metadata: {
          ...reindexMetadata(knowledgeBase.name, statement),
          generation: generation.generation
        }
      });
      return { started: true, ...(await stateNow()), statement, lines };
    }
  };
}

/** What the re-index job needs beside the Knowledge Base runtime. */
export interface KnowledgeReindexJobInput {
  auditRecorder: AuditRecorder;
  embedding: KnowledgeEmbedding;
  embed: KnowledgeEmbed;
}

/**
 * The handler of `knowledge_base.reindex`: drops the generations the published revision no
 * longer uses, then embeds every passage search reads into the generation being built and
 * switches. A job whose binding is no longer the one the Knowledge Base is set to ends: the
 * publish that changed it queued its own.
 */
export function createKnowledgeReindexHandler(
  runtime: KnowledgeRuntime,
  input: KnowledgeReindexJobInput
): RegisteredJobHandler {
  const { auditRecorder, embedding, embed } = input;

  async function finished(
    payload: ReindexPayload,
    correlationId: string,
    outcome: { status: "success" | "failed"; metadata: Record<string, string | number> }
  ) {
    await auditRecorder.record({
      type: "knowledge_base.reindex_finished",
      status: outcome.status,
      subject: payload.knowledgeBaseId,
      correlationId,
      ...(outcome.status === "failed" ? { reason: "knowledge_reindex_failed" } : {}),
      metadata: { binding: payload.bindingId, ...outcome.metadata }
    });
  }

  return defineJobHandler({
    kind: knowledgeReindexJob,
    slots: 1,
    async run(job, control: JobControl) {
      const { signal } = control;
      const found = await indexTargetOf(runtime, job.payload.knowledgeBaseId);
      if (!found) return;
      const { store, definition, scope, target: kb } = found;
      // First what the published revision no longer uses, so nothing is paid for into it.
      const dropped = await store.retireGenerations(
        unusedGenerations(await store.embeddingGenerations(signal), definition, embedding).map(
          (each) => each.generation
        ),
        signal
      );
      if (dropped.length > 0) {
        control.logger.info(
          { knowledgeBaseId: job.payload.knowledgeBaseId, generations: dropped },
          "Generations of embeddings the Knowledge Base no longer uses are dropped"
        );
      }
      if (!("bindingId" in job.payload)) return;
      const payload = job.payload;
      const target = reindexTarget(definition, embedding);
      // Set to another model since, or the model is gone: this re-index is superseded.
      if (target?.bindingId !== payload.bindingId) {
        control.logger.info(
          { knowledgeBaseId: payload.knowledgeBaseId },
          "A re-index ends: the Knowledge Base is set to another embedding model now"
        );
        return;
      }
      // Already answering from that model: what it lacks goes into it, as after turning
      // `semantic` on again, or where an index job started it while this job waited.
      const live = await store.embeddingGenerations(signal);
      const current = live.find((each) => each.state === "active" && sameModel(each, target));
      const generation = current ?? (await store.startGeneration(target, signal));
      const run = await runtime.stores.operationRuns.get({
        clientInstanceId: runtime.clientInstanceId,
        id: payload.operationRunId
      });
      const attribution = {
        kind: "system" as const,
        purpose: "knowledge_embedding" as const,
        operationRunId: payload.operationRunId,
        ...(run?.actor.kind === "user" ? { userId: run.actor.id } : {}),
        ...(scope.kind === "workspace" ? { workspaceId: scope.workspaceId } : {})
      };
      let embedded = 0;
      for (;;) {
        const passages = await store.passagesToReindex(
          { generation: generation.generation, limit: KNOWLEDGE_EMBEDDING_BATCH },
          signal
        );
        if (passages.length === 0 && current) {
          await finished(payload, job.correlationId, {
            status: "success",
            metadata: { knowledgeBase: kb.name, generation: generation.generation, embedded }
          });
          return;
        }
        if (passages.length === 0) {
          const switched = await store.switchGeneration(generation.generation, signal);
          // A passage came in meanwhile: it is embedded on the next round.
          if (!switched.switched) {
            const still = await store.embeddingGenerations(signal);
            if (!still.some((each) => each.generation === generation.generation)) return;
            continue;
          }
          await finished(payload, job.correlationId, {
            status: "success",
            metadata: {
              knowledgeBase: kb.name,
              generation: generation.generation,
              ...(switched.retired === undefined ? {} : { retired: switched.retired }),
              embedded
            }
          });
          return;
        }
        const queue = batchesByTokens(
          passages.map((passage) => ({
            chunkId: passage.chunkId,
            text: embeddingText(passage, passage)
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
            if (refusedAsTooLarge(error) && batch.length > 1) {
              const half = Math.ceil(batch.length / 2);
              queue.unshift(batch.slice(0, half), batch.slice(half));
              continue;
            }
            const wait = waitOf(error);
            if (!wait) throw error;
            await control.transaction((stores) =>
              stores.jobs.enqueue(knowledgeReindexJob, payload, {
                clientInstanceId: runtime.clientInstanceId,
                subject: payload.knowledgeBaseId,
                concurrencyKey: payload.knowledgeBaseId,
                runAfter: new Date(runtime.now().getTime() + wait.ms)
              })
            );
            control.logger.info(
              {
                knowledgeBaseId: payload.knowledgeBaseId,
                waitMs: wait.ms,
                reason: wait.code ?? "rate_limited"
              },
              "A re-index waits"
            );
            return;
          }
          embedded += await store.writeEmbeddings(
            {
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
      }
    },
    async onExhausted(job) {
      if (!("bindingId" in job.payload)) return;
      // The generation stays `building` and the old one answers; a new start goes on from it.
      try {
        await finished(job.payload, job.correlationId, { status: "failed", metadata: {} });
      } catch (error) {
        runtime.logger.warn(
          {
            knowledgeBaseId: job.payload.knowledgeBaseId,
            errorName: error instanceof Error ? error.name : "unknown"
          },
          "Recording a re-index that gave up failed"
        );
      }
    }
  });
}
