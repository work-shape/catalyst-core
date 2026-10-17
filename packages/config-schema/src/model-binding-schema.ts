import { z } from "zod";
import {
  KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
  KNOWLEDGE_MAX_PAGES_PER_DOCUMENT_CEILING,
  MODEL_BINDING_KINDS,
  MODEL_EMBEDDING_MAX_DIMENSIONS,
  MODEL_USAGE_TIERS,
  REASONING_EFFORTS
} from "@work-shape/catalyst-core";
import { localizedStringSchema } from "./localization";

/**
 * One entry of `modelBindings`. A binding without `kind` is a chat binding. An embedding binding
 * states the length of its vectors and is never offered to agents: unset, `agentSelectable` is
 * true for a chat binding and false for an embedding binding.
 */
export const modelBindingConfigSchema = z
  .object({
    id: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1).optional(),
    kind: z.enum(MODEL_BINDING_KINDS).optional(),
    dimensions: z.number().int().positive().max(MODEL_EMBEDDING_MAX_DIMENSIONS).optional(),
    reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
    agentSelectable: z.boolean().optional(),
    // Accepted for compatibility; no effect. Each agent lists the models its users may pick.
    userSelectable: z.boolean().default(false),
    supportsFastMode: z.boolean().default(false),
    description: localizedStringSchema.optional(),
    label: z.string().trim().min(1).optional(),
    vendor: z.string().min(1).optional(),
    usageTier: z.enum(MODEL_USAGE_TIERS).optional(),
    userSelectableReasoningEfforts: z.array(z.enum(REASONING_EFFORTS)).optional()
  })
  .superRefine((binding, context) => {
    if (binding.kind !== "embedding") {
      if (binding.dimensions !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `Model binding '${binding.id}' states 'dimensions', which only a binding of kind 'embedding' has`
        });
      }
      return;
    }
    if (binding.dimensions === undefined) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: `Embedding binding '${binding.id}' needs 'dimensions', the length of the vectors it returns`
      });
    }
    if (binding.agentSelectable === true) {
      context.addIssue({
        code: "custom",
        path: ["agentSelectable"],
        message: `Embedding binding '${binding.id}' cannot be chosen for agents: leave out 'agentSelectable'`
      });
    }
  })
  .transform(({ agentSelectable, ...binding }) => ({
    ...binding,
    agentSelectable: agentSelectable ?? binding.kind !== "embedding"
  }));

/**
 * The Knowledge Bases of an instance. `defaultEmbeddingBinding` names the embedding binding a
 * Knowledge Base with semantic search uses unless it names another. Without it the instance
 * offers no semantic search; keyword and structured Knowledge Bases work all the same.
 * `maxDocuments` is how many documents one Knowledge Base holds at most: adding a file beyond
 * it is refused with the limit named. `maxPagesPerDocument` is how many pages of one PDF or
 * DOCX extraction reads: a longer one fails with `knowledge_file_too_many_pages`, counted
 * before conversion. It applies to Knowledge Bases only; chat uploads keep their own limits.
 */
export const knowledgeConfigSchema = z
  .object({
    defaultEmbeddingBinding: z.string().min(1).optional(),
    maxDocuments: z.number().int().positive().max(1_000_000).default(10_000),
    maxPagesPerDocument: z
      .number()
      .int()
      .positive()
      .max(KNOWLEDGE_MAX_PAGES_PER_DOCUMENT_CEILING)
      .default(KNOWLEDGE_MAX_PAGES_PER_DOCUMENT)
  })
  .strict()
  .prefault({});
