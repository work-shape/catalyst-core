import { z } from "zod";
import { noReportedUsage } from "./openai-compatible-mapping";
import { ModelProviderError } from "./model-provider-error";
import type { ModelAdapterEmbedding, ModelAdapterEmbeddingRequest } from "./types";

/**
 * The body of `POST <baseUrl>/embeddings`. On Azure OpenAI's v1 endpoint `model` is the
 * deployment name. `dimensions` asks the model to shorten its vectors to the binding's length.
 */
export function toOpenAiEmbeddingsRequestBody(request: ModelAdapterEmbeddingRequest) {
  return {
    model: request.model,
    input: [...request.texts],
    dimensions: request.dimensions,
    encoding_format: "float"
  };
}

const openAiEmbeddingsUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional()
});

const openAiEmbeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number())
    })
  ),
  usage: openAiEmbeddingsUsageSchema.optional()
});

// The usage of an answer read on its own, so an answer refused for its vectors is still settled
// with what the provider counted for it.
const openAiEmbeddingsUsageOfAnswerSchema = z.object({ usage: openAiEmbeddingsUsageSchema });

/**
 * The vectors of an answer in the order of the texts, by each entry's `index`. An answer whose
 * indexes are not exactly those of the texts is refused, carrying the usage the provider
 * reported with it; the gateway checks the lengths.
 */
export function readOpenAiEmbeddings(payload: unknown, textCount: number): ModelAdapterEmbedding {
  const parsed = openAiEmbeddingsResponseSchema.safeParse(payload);
  const data = parsed.success ? [...parsed.data.data].sort((a, b) => a.index - b.index) : [];
  if (
    !parsed.success ||
    data.length !== textCount ||
    data.some((entry, position) => entry.index !== position)
  ) {
    const billed = openAiEmbeddingsUsageOfAnswerSchema.safeParse(payload);
    throw new ModelProviderError({
      kind: "invalid_response",
      message: "Model provider returned no embedding for each text",
      ...(billed.success
        ? { usage: { ...toEmbeddingUsage(billed.data.usage), webSearchCallCount: 0 } }
        : {})
    });
  }
  const usage = parsed.data.usage;
  return {
    vectors: data.map((entry) => entry.embedding),
    usage: usage ? toEmbeddingUsage(usage) : noReportedUsage()
  };
}

function toEmbeddingUsage(
  usage: z.output<typeof openAiEmbeddingsUsageSchema>
): ModelAdapterEmbedding["usage"] {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: 0,
    totalTokens: usage.prompt_tokens,
    source: "provider_reported"
  };
}
