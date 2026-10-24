import type {
  KnowledgeEmbeddingGeneration,
  KnowledgeEmbeddingModel
} from "@work-shape/catalyst-core";
import {
  approvedEmbeddingModel,
  knowledgeEmbeddingBinding,
  type KnowledgeBaseDefinition,
  type KnowledgeEmbedding
} from "./definition";

/** Whether a generation embeds with exactly this model. */
export function sameModel(generation: KnowledgeEmbeddingModel, model: KnowledgeEmbeddingModel) {
  return (
    generation.bindingId === model.bindingId &&
    generation.model === model.model &&
    generation.dimensions === model.dimensions
  );
}

/** The model a Knowledge Base that searches by meaning should embed with now, where approved. */
export function embeddingTarget(
  definition: KnowledgeBaseDefinition,
  embedding: KnowledgeEmbedding
): KnowledgeEmbeddingModel | undefined {
  if (!definition.methods.some((method) => method === "semantic")) return undefined;
  return approvedEmbeddingModel(embedding, knowledgeEmbeddingBinding(definition, embedding));
}

/**
 * The generations the published revision no longer uses, which nothing embeds into and which
 * are dropped: every one where it does not search by meaning, as turning `semantic` off drops
 * the embeddings; else one being built with another model than the one it is set to, as after
 * its binding is set back before a re-index finished. The active generation stays while it
 * searches by meaning, also one whose model is gone: its page says that a re-index is needed.
 */
export function unusedGenerations(
  generations: readonly KnowledgeEmbeddingGeneration[],
  definition: KnowledgeBaseDefinition,
  embedding: KnowledgeEmbedding
): KnowledgeEmbeddingGeneration[] {
  if (!definition.methods.some((method) => method === "semantic")) return [...generations];
  const target = embeddingTarget(definition, embedding);
  return generations.filter(
    (each) => each.state === "building" && (!target || !sameModel(each, target))
  );
}
