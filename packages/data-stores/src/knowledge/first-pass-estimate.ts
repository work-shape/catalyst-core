import {
  KNOWLEDGE_DOCUMENT_FORMATS,
  knowledgeFirstPassConfirmationSchema,
  type KnowledgeDocumentFormat,
  type KnowledgeFirstPassConfirmation
} from "@work-shape/catalyst-core";
import { embeddingTarget } from "./generations";
import { embeddingCost, embeddingRate, vectorBytes } from "./reindex";
import type { KnowledgeBaseDefinition, KnowledgeEmbedding } from "./definition";
import type { FirstPassStop } from "./first-pass";

// The estimate a stopped first pass shows (KB-ISO-1b), read from what it keeps on its run.

/**
 * Tokens per listed byte, low and high, by format. Text is about three to five bytes a token;
 * a PDF or DOCX file holds its text among layout, fonts and images, so far fewer per byte.
 * Estimates until MD-5 measures real sources.
 */
const TOKENS_PER_BYTE: Record<KnowledgeDocumentFormat, readonly [number, number]> = {
  txt: [0.2, 0.3],
  markdown: [0.2, 0.3],
  pdf: [0.01, 0.04],
  docx: [0.02, 0.08]
};

/** The chunker's cap on a passage, in tokens. */
const PASSAGE_TOKENS = 512;

/** About how many bytes a passage's text and row take beside its tokens. */
const PASSAGE_BYTES_PER_TOKEN = 4;

/**
 * What a stopped first pass shows and the confirmation's audit event carries: counts, the token
 * and passage range, the cost range where the model has a price, and whether the store's size
 * limit holds the high estimate.
 */
export function firstPassConfirmation(input: {
  syncRunId: string;
  stop: FirstPassStop;
  definition: KnowledgeBaseDefinition;
  embedding: KnowledgeEmbedding | undefined;
  storeBytes: number;
  limitBytes: number | undefined;
}): KnowledgeFirstPassConfirmation {
  const { stop } = input;
  let low = 0;
  let high = 0;
  for (const format of KNOWLEDGE_DOCUMENT_FORMATS) {
    const bytes = stop.formats[format] ?? 0;
    low += bytes * TOKENS_PER_BYTE[format][0];
    high += bytes * TOKENS_PER_BYTE[format][1];
  }
  const tokens = { min: Math.round(low), max: Math.round(high) };
  const passages = {
    min: Math.max(stop.items, Math.ceil(tokens.min / PASSAGE_TOKENS)),
    max: stop.items + Math.ceil(tokens.max / PASSAGE_TOKENS)
  };
  const target = input.embedding ? embeddingTarget(input.definition, input.embedding) : undefined;
  const rate =
    target && input.embedding ? embeddingRate(input.embedding, target.bindingId) : undefined;
  const addedBytes = Math.round(
    tokens.max * PASSAGE_BYTES_PER_TOKEN +
      (target ? vectorBytes(passages.max, target.dimensions) : 0)
  );
  return knowledgeFirstPassConfirmationSchema.parse({
    syncRunId: input.syncRunId,
    items: stop.items,
    bytes: Math.round(stop.bytes),
    stop: stop.at,
    tokens,
    passages,
    ...(target ? { model: target.model } : {}),
    ...(rate
      ? {
          cost: {
            min: embeddingCost(tokens.min, rate).amount,
            max: embeddingCost(tokens.max, rate).amount,
            currency: rate.currency
          }
        }
      : {}),
    room: input.limitBytes === undefined || input.storeBytes + addedBytes <= input.limitBytes,
    storeBytes: input.storeBytes,
    addedBytes,
    ...(input.limitBytes === undefined ? {} : { limitBytes: input.limitBytes })
  });
}

/** The confirmation's audit metadata: counts and the estimate, never a name. */
export function firstPassAuditMetadata(
  source: string,
  confirmation: KnowledgeFirstPassConfirmation
) {
  return {
    source,
    syncRunId: confirmation.syncRunId,
    items: confirmation.items,
    bytes: confirmation.bytes,
    stop: confirmation.stop,
    tokensMin: confirmation.tokens.min,
    tokensMax: confirmation.tokens.max,
    ...(confirmation.cost
      ? {
          costMin: confirmation.cost.min,
          costMax: confirmation.cost.max,
          currency: confirmation.cost.currency
        }
      : {})
  };
}
