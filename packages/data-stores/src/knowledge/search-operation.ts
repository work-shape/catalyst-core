import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  auditActorFromIdentity,
  isAuthenticatedServicePrincipal,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
  KNOWLEDGE_SEARCH_LIMIT_MAX,
  KNOWLEDGE_SEARCH_QUERY_MAX_CHARS,
  KNOWLEDGE_SEARCH_SIGNALS,
  knowledgeSearchOperationName,
  type KnowledgeDocumentStore,
  type KnowledgeQueryEmbedding,
  type KnowledgeSearchFilter,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationResource
} from "@work-shape/catalyst-core";
import type { KnowledgeFilterDeclaration } from "./definition";
import type { KnowledgeRuntime } from "./runtime";

// `knowledge.<id>.search` (right `knowledge_base.use`, asked on every call): the passages of a
// Knowledge Base's documents that answer a query best, from its published revision. Every
// call is recorded: its Operation Run holds a hash of the input and no output, and its audit
// row `knowledge_base.searched` a SHA-256 of the query, the count, the lists fused and the
// duration. Nothing of the query, a passage or a file name is logged. With search by meaning
// the query is embedded once per call with the model of the active generation, as a usage
// event `knowledge_query` of this run. Spec: "Search, the agent tool and citations", check
// 32, "Documents in a Knowledge Base", 5.

const knowledgeSearchInputSchema = z.strictObject({
  /** Words or a question. Quoted words are a phrase, and a word after `-` is left out. */
  query: z.string().trim().min(1).max(KNOWLEDGE_SEARCH_QUERY_MAX_CHARS),
  limit: z.coerce.number().int().min(1).max(KNOWLEDGE_SEARCH_LIMIT_MAX).optional()
});

/** How long the value of a filter may be. */
const KNOWLEDGE_FILTER_VALUE_MAX_CHARS = 1_000;

/** The value one declared filter takes: a date as `YYYY-MM-DD`, a text otherwise. */
function filterValueSchema(filter: KnowledgeFilterDeclaration) {
  return (
    filter.type === "date"
      ? z.iso.date({ error: `'${filter.name}' is a date: YYYY-MM-DD` })
      : z.string().min(1).max(KNOWLEDGE_FILTER_VALUE_MAX_CHARS)
  ).describe(filter.description);
}

/**
 * The input of the search of one Knowledge Base: the query, the limit, and a value for any of
 * the filters it declares (DS-6b). A filter it does not declare is refused before a run exists.
 */
export function knowledgeSearchInputSchemaOf(filters: readonly KnowledgeFilterDeclaration[] = []) {
  return knowledgeSearchInputSchema.extend({
    filters: z
      .strictObject(
        Object.fromEntries(
          filters.map((filter) => [filter.name, filterValueSchema(filter).optional()])
        )
      )
      .optional()
  });
}

/** The filters a search applies: each declared one the input gives a value, as the store compares it. */
function searchFiltersOf(
  declared: readonly KnowledgeFilterDeclaration[],
  values: Readonly<Record<string, string | undefined>> | undefined
): KnowledgeSearchFilter[] {
  return declared.flatMap((filter) => {
    const value = values?.[filter.name];
    return value === undefined ? [] : [{ field: filter.field, op: filter.op ?? "eq", value }];
  });
}

const knowledgePassageSchema = z.object({
  /** `K1`, `K2` and so on, in the order of the answer. */
  ref: z.string(),
  knowledgeBase: z.string(),
  documentId: z.string(),
  /** The copy of the file the Knowledge Base owns. */
  fileId: z.string(),
  fileName: z.string(),
  title: z.string(),
  page: z.number().int().optional(),
  heading: z.string().optional(),
  text: z.string(),
  /** The fused score: compared only with passages of the same Knowledge Base. */
  score: z.number(),
  originLink: z.string().optional()
});

const searchOutputSchema = z.object({
  passages: z.array(knowledgePassageSchema),
  /** The ranked lists fused: `semantic`, `keyword` and `title`. */
  signals: z.array(z.enum(KNOWLEDGE_SEARCH_SIGNALS))
});

/** The Knowledge Base a search serves: one that keeps documents, with how it searches them. */
export interface SearchTarget {
  name: string;
  assetId: string;
  resource: OperationResource;
  store: KnowledgeDocumentStore;
  methods: readonly string[];
  /** The filters its published revision declares. */
  filters?: readonly KnowledgeFilterDeclaration[];
}

/** How long a search may take, the embedding of its query included. */
const SEARCH_TIMEOUT_MS = 60_000;

export function searchOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: SearchTarget
): OperationDefinition {
  const declared = knowledgeBase.filters ?? [];
  const inputSchema = knowledgeSearchInputSchemaOf(declared);
  return {
    name: knowledgeSearchOperationName(knowledgeBase.name),
    effect: "reading",
    // A read of a customer's documents is recorded, every time.
    recordsEveryCall: true,
    action: KNOWLEDGE_BASE_ACTIONS.use,
    scope: "data_store_rows:read",
    auth: "principal",
    inputSchema,
    outputSchema: searchOutputSchema,
    resource: () => knowledgeBase.resource,
    module: "knowledge",
    timeoutMs: SEARCH_TIMEOUT_MS,
    async execute(input, context) {
      const { query, limit, filters: values } = inputSchema.parse(input);
      const filters = searchFiltersOf(declared, values);
      const started = performance.now();
      const embed = knowledgeBase.methods.includes("semantic")
        ? queryEmbedding(runtime, query, context)
        : undefined;
      const answer = await knowledgeBase.store.search(
        {
          query,
          limit: limit ?? KNOWLEDGE_SEARCH_LIMIT_DEFAULT,
          ...(embed ? { embed } : {}),
          ...(filters.length > 0 ? { filters } : {})
        },
        context.runtime.signal
      );
      await context.audit.record({
        type: "knowledge_base.searched",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        subject: knowledgeBase.assetId,
        correlationId: context.correlationId,
        metadata: {
          knowledgeBase: knowledgeBase.name,
          queryHash: createHash("sha256").update(query).digest("hex"),
          results: answer.hits.length,
          signals: answer.signals,
          // Which filters narrowed it, by name: a value may name a person or an object.
          ...(filters.length > 0
            ? {
                filters: declared
                  .filter((filter) => values?.[filter.name] !== undefined)
                  .map((filter) => filter.name)
              }
            : {}),
          durationMs: Math.round(performance.now() - started)
        }
      });
      return {
        passages: answer.hits.map((hit, index) => ({
          ref: `K${index + 1}`,
          knowledgeBase: knowledgeBase.name,
          ...hit
        })),
        signals: answer.signals
      };
    }
  };
}

/** The query's embedding for this call, as a usage event of its run. None without a gateway. */
function queryEmbedding(
  runtime: KnowledgeRuntime,
  query: string,
  context: OperationExecutionContext
): KnowledgeQueryEmbedding | undefined {
  const { embedQuery } = runtime;
  if (!embedQuery) return undefined;
  const { actor, origin, workspaceId, runId, correlationId } = context;
  return ({ bindingId, model, dimensions }) =>
    embedQuery({
      bindingId,
      model,
      dimensions,
      text: query,
      attribution: {
        ...(isAuthenticatedServicePrincipal(actor) ? {} : { userId: actor.id }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(origin.kind === "agent" ? { conversationId: origin.conversationId } : {}),
        operationRunId: runId
      },
      ...(origin.kind === "agent" ? { agentRunId: origin.agentRunId } : {}),
      correlationId,
      ...(context.runtime.signal ? { signal: context.runtime.signal } : {})
    });
}
