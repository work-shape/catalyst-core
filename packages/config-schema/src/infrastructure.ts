import { z } from "zod";
import { PROVIDER_REGIONS, REASONING_EFFORTS, type ModelProviderConfig } from "@vivd-catalyst/core";

/** The model a `deterministic` entry answers with when it names none. */
const DETERMINISTIC_MODEL = "deterministic-local";

/**
 * What every entry states whatever serves it. The remaining keys of an entry belong to the
 * chosen provider's own schema, which startup validates once the providers are registered.
 */
const providerEntryFields = {
  provider: z.string().min(1),
  region: z.enum(PROVIDER_REGIONS).optional()
};

const providerEntrySchema = z.looseObject(providerEntryFields);

const modelEntrySchema = z.looseObject({
  ...providerEntryFields,
  model: z.string().min(1).optional(),
  api: z.enum(["chat_completions", "responses"]).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  contextManagement: z
    .object({
      compaction: z.object({ compactThresholdTokens: z.number().int().positive() }).optional()
    })
    .optional()
});

const mailEntrySchema = z.looseObject({
  ...providerEntryFields,
  /** Public URL of the chat UI; emailed links point here. */
  appUrl: z.string().url(),
  sender: z.object({
    fromAddress: z.string().email(),
    fromName: z.string().min(1).optional(),
    replyTo: z.string().email().optional()
  })
});

/**
 * What an instance runs on: one provider per port. `models` holds named entries because an
 * instance has several, `objectStorage` holds the two fixed stores, the other ports hold one
 * provider. An instance without mail, without a store or without a sandbox leaves that key out.
 */
export const infrastructureConfigSchema = z.strictObject(
  {
    secrets: z.looseObject({ provider: z.string().min(1) }).default({ provider: "environment" }),
    models: z
      .record(z.string().min(1), modelEntrySchema, {
        error: "'infrastructure.models' is required and needs at least one entry"
      })
      .superRefine((models, context) => {
        const entries = Object.entries(models);
        if (entries.length === 0) {
          context.addIssue({
            code: "custom",
            message:
              "'infrastructure.models' needs at least one entry; there is no default model provider"
          });
        }
        for (const [name, entry] of entries) {
          if (/^[0-9]+$/u.test(name)) {
            context.addIssue({
              code: "custom",
              path: [name],
              message: `'infrastructure.models.${name}' is not a usable id: an id made only of digits is read before the other entries whatever its place in the file, which would change the default provider. Rename it, for example to 'model-${name}', also where an agent names it`
            });
          }
          if (entry.model === undefined && entry.provider !== "deterministic") {
            context.addIssue({
              code: "custom",
              path: [name, "model"],
              message: `'infrastructure.models.${name}.model' is required`
            });
          }
          if (entry.contextManagement?.compaction && entry.api !== "responses") {
            context.addIssue({
              code: "custom",
              path: [name, "contextManagement", "compaction"],
              message: `Model provider '${name}' configures compaction, but provider compaction requires api: responses`
            });
          }
        }
      }),
    mail: mailEntrySchema.optional(),
    database: z
      .strictObject({
        // Connections each process of the instance keeps to PostgreSQL at most. A request that
        // finds all of them busy waits for one.
        poolSize: z.number().int().min(1).max(100).default(10)
      })
      .prefault({}),
    objectStorage: z
      .strictObject({
        files: providerEntrySchema.optional(),
        workspaces: providerEntrySchema.optional()
      })
      .default({}),
    sandbox: providerEntrySchema.optional()
  },
  {
    error: (issue) =>
      issue.input === undefined
        ? "'infrastructure' is required: it names the provider per port, and 'infrastructure.models' needs at least one entry"
        : undefined
  }
);

export type InfrastructureConfig = z.infer<typeof infrastructureConfigSchema>;

/**
 * The model providers of an instance in the order the config names them. The first one serves
 * an agent that names neither a provider nor a binding. The order holds because the schema
 * refuses an id made only of digits, the one kind of key an object reorders.
 */
export function getModelProviderConfigs(config: {
  infrastructure: InfrastructureConfig;
}): ModelProviderConfig[] {
  return Object.entries(config.infrastructure.models).map(([id, entry]) => ({
    id,
    type: entry.provider,
    model: entry.model ?? DETERMINISTIC_MODEL,
    ...(entry.region ? { region: entry.region } : {}),
    ...(entry.api ? { api: entry.api } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.contextManagement ? { contextManagement: entry.contextManagement } : {})
  }));
}
