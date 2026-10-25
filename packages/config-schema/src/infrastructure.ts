import {
  providerRegionSchema,
  localeCodes,
  MAIL_OUTBOUND_DEFAULT_LIMITS,
  MAIL_OUTBOUND_FOOTER_MAX_LENGTH,
  MAIL_RECIPIENT_DOMAINS_ANY,
  mailRecipientDomainSchema,
  OPENAI_COMPATIBLE_APIS
} from "@work-shape/catalyst-asset-schemas";
import {
  MANAGED_OAUTH_CLIENT_PATTERN,
  PROVIDER_REGIONS,
  REASONING_EFFORTS,
  secretRef,
  type ModelProviderConfig
} from "@work-shape/catalyst-core";
import { z } from "zod";

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
  region: providerRegionSchema.optional(),
  model: z.string().min(1).optional(),
  api: z.enum(OPENAI_COMPATIBLE_APIS).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  contextManagement: z
    .object({
      compaction: z.object({ compactThresholdTokens: z.number().int().positive() }).optional()
    })
    .optional()
});

/** Operator controls for counts-only notice mail; raising the batch drains a larger backlog. */
export const noticeMailSettingsSchema = z
  .strictObject({
    batchSize: z.number().int().positive().default(100),
    digestIntervalMs: z
      .number()
      .int()
      .positive()
      .refine((intervalMs) => Number.isFinite(new Date(Date.now() + intervalMs).getTime()), {
        message: "digestIntervalMs must produce a valid delivery date"
      })
      .default(5 * 60 * 1000)
  })
  .prefault({});

/**
 * Mail with content through `mail.send` (MAIL-SEND). A floor of release config that no
 * instance admin lowers: while `enabled` is false the operation is not registered. An instance
 * mails people of the instance always and other addresses only in `recipientDomains`: `[]`
 * admits nobody outside, `["*"]` everybody. `footer` is the operator's legal footer per
 * language, as plain text; a mail in a language without one carries the other's.
 */
export const mailOutboundSettingsSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    recipientDomains: z
      .array(mailRecipientDomainSchema)
      .max(100)
      .default([])
      .superRefine((domains, context) => {
        if (domains.includes(MAIL_RECIPIENT_DOMAINS_ANY) && domains.length > 1) {
          context.addIssue({
            code: "custom",
            message: `'*' admits every address and stands alone in 'recipientDomains'`
          });
        }
        const seen = new Set<string>();
        for (const [index, domain] of domains.entries()) {
          if (seen.has(domain)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: `'${domain}' is listed twice in 'recipientDomains'`
            });
          }
          seen.add(domain);
        }
      }),
    limits: z
      .strictObject({
        perWorkflowPerHour: z
          .number()
          .int()
          .positive()
          .default(MAIL_OUTBOUND_DEFAULT_LIMITS.perWorkflowPerHour),
        perInstancePerDay: z
          .number()
          .int()
          .positive()
          .default(MAIL_OUTBOUND_DEFAULT_LIMITS.perInstancePerDay)
      })
      .prefault({}),
    footer: z
      .partialRecord(
        z.enum(localeCodes),
        z.string().trim().min(1).max(MAIL_OUTBOUND_FOOTER_MAX_LENGTH)
      )
      .refine((footer) => Object.keys(footer).length > 0, {
        message: "'footer' names at least one language, such as de"
      })
      .optional()
  })
  .prefault({});

export type MailOutboundSettings = z.infer<typeof mailOutboundSettingsSchema>;

const mailEntrySchema = z.looseObject({
  notices: noticeMailSettingsSchema,
  outbound: mailOutboundSettingsSchema,
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
 * One managed OAuth client of the operator (MS-APP-1): an app the operator registered once at
 * a provider, which a catalogue part that names it (`managedClient`) signs people in with, so
 * the install asks for no client of its own. `credentialSecret` is the name of the host secret
 * that holds the client secret, never its value: it is read from the host when a token is
 * exchanged, refreshed or revoked and is never copied into the Secret Store or the database.
 * `tenant` fills the `{tenant}` path segment of the part's endpoints, such as the customer's
 * directory id; left out, the part's own value stands.
 */
export const managedOAuthClientSchema = z.strictObject({
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[\x21-\x7e]+$/u, { message: "must be the client id, printable text without spaces" }),
  credentialSecret: secretRef(),
  tenant: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u, {
      message: "must be one path segment, such as organizations or a directory id"
    })
    .optional()
});

export type ManagedOAuthClientConfig = z.infer<typeof managedOAuthClientSchema>;

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
    sandbox: providerEntrySchema.optional(),
    /** The operator's managed OAuth clients by id, such as `microsoft`. */
    oauthClients: z
      .record(
        z.string().regex(MANAGED_OAUTH_CLIENT_PATTERN, {
          message: "must be a lower-case id such as microsoft"
        }),
        managedOAuthClientSchema
      )
      .default({})
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
