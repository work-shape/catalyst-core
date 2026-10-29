import { z } from "zod";
import {
  KNOWLEDGE_INDEX_CONCURRENCY_DEFAULTS,
  KNOWLEDGE_MAX_PAGES_PER_DOCUMENT,
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
    userSelectableReasoningEfforts: z.array(z.enum(REASONING_EFFORTS)).optional(),
    /**
     * The chat binding that answers when this one is rate-limited or down. Validated against
     * the other bindings and their providers with the whole config.
     */
    fallback: z.string().min(1).optional()
  })
  .superRefine((binding, context) => {
    if (binding.fallback === binding.id) {
      context.addIssue({
        code: "custom",
        path: ["fallback"],
        message: `Model binding '${binding.id}' names itself as its fallback`
      });
    }
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
    if (binding.fallback !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["fallback"],
        message: `Embedding binding '${binding.id}' takes no fallback: another model's vectors do not fit its index`
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
 * `indexConcurrency` is how many contents are indexed at once, each sending its passages to the
 * embedding model: `perWorker` on one knowledge worker, `total` across all of them. Raise them
 * only where the embedding quota of the deployment allows.
 */
export const knowledgeConfigSchema = z
  .object({
    defaultEmbeddingBinding: z.string().min(1).optional(),
    withdrawShareConfirm: z.number().min(0).max(1).default(0.2),
    maxDocuments: z.number().int().positive().max(1_000_000).default(10_000),
    maxPagesPerDocument: z.number().int().positive().default(KNOWLEDGE_MAX_PAGES_PER_DOCUMENT),
    indexConcurrency: z
      .object({
        perWorker: z
          .number()
          .int()
          .min(1)
          .max(256)
          .default(KNOWLEDGE_INDEX_CONCURRENCY_DEFAULTS.perWorker),
        total: z.number().int().min(1).max(1024).default(KNOWLEDGE_INDEX_CONCURRENCY_DEFAULTS.total)
      })
      .strict()
      .prefault({})
  })
  .strict()
  .prefault({});
