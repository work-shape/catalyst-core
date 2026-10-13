import { createHash } from "node:crypto";
import type { ModelAdapterEmbedding, ModelAdapterEmbeddingRequest } from "./types";

// A SHA-256 digest gives 32 bytes, so each round of the hash yields this many vector values.
const VALUES_PER_DIGEST = 32;
// Text of the Latin alphabet runs at about four characters a token.
const CHARACTERS_PER_TOKEN = 4;

/**
 * Vectors made from a hash of each text, for tests and development: the same text gives the
 * same vector, different texts give different ones, and each has unit length like a real
 * model's. Nearness of meaning is not modelled; only identity is. The tokens are estimated.
 */
export function embedDeterministically(
  request: ModelAdapterEmbeddingRequest
): ModelAdapterEmbedding {
  const inputTokens = request.texts.reduce(
    (sum, text) => sum + Math.max(1, Math.ceil(text.length / CHARACTERS_PER_TOKEN)),
    0
  );
  return {
    vectors: request.texts.map((text) => hashVector(text, request.dimensions)),
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens, source: "estimated" }
  };
}

function hashVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let round = 0; values.length < dimensions; round += 1) {
    const digest = createHash("sha256").update(`${round}\u0000${text}`).digest();
    for (const byte of digest.subarray(
      0,
      Math.min(VALUES_PER_DIGEST, dimensions - values.length)
    )) {
      values.push(byte / 127.5 - 1);
    }
  }
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / length);
}
