import {
  POLICY_VALUES,
  providerRegionSchema,
  READING_POLICY_VALUES,
  THEME_MODE_PREFERENCES
} from "@work-shape/catalyst-asset-schemas";
import type {
  AgentConfig,
  AgentRuntimeConfig,
  CapabilityConfigMap,
  DataSourceConfig,
  ExecutionWorkspacesConfig,
  LocalizationConfig,
  ModelBindingConfig,
  ModelContextConfig,
  ModelProviderConfig,
  SkillConfig,
  SkillResourceConfig,
  SkillResourceMediaType,
  UsageBudgetConfig,
  UsageCostConfig,
  UsageRateCardConfig,
  UsageSafeguardsConfig,
  WebAccessConfig
} from "@work-shape/catalyst-core";
import { dataScopesSchema, AGENT_EDITABLE_FIELDS } from "@work-shape/catalyst-core";
import { z } from "zod";
import { developmentAuthConfigSchema, standaloneAuthConfigSchema } from "./auth-schema";
import {
  catalogueConfigSchema,
  egressConfigSchema,
  releaseConnectionsConfigSchema,
  secretStoreConfigSchema
} from "./connection-schema";
import { dataStoresConfigSchema } from "./data-store-schema";
import { releaseGuardrailsConfigSchema } from "./guardrail-schema";
import { infrastructureConfigSchema } from "./infrastructure";
import { instanceConfigSchema } from "./instance-schema";
import { localizationConfigSchema, localizedStringSchema } from "./localization";
import { knowledgeConfigSchema, modelBindingConfigSchema } from "./model-binding-schema";
import {
  agentRuntimeConfigSchema,
  conversationTitleConfigSchema,
  executionWorkspacesConfigSchema,
  modelContextConfigSchema,
  webAccessConfigSchema,
  workflowsConfigSchema
} from "./runtime-schema";
import {
  usageBudgetConfigSchema,
  usageCostConfigSchema,
  usageSafeguardsConfigSchema
} from "./usage-schema";

const toolInstanceConfigSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).default({})
  })
  .superRefine((tool, context) => {
    if (tool.name !== "show_view") {
      return;
    }
    // An earlier release read script settings from this tool's own config. Left there they
    // would be ignored without a word, so every key is refused and the new place is named.
    for (const key of Object.keys(tool.config)) {
      context.addIssue({
        code: "custom",
        path: ["config", key],
        message: `'show_view' takes no tool config: every view loads its runtime from the instance, and outside script hosts are named in the instance key 'views.allowedScriptSrc', which defaults to none`
      });
    }
  });

/**
 * One host a view may load scripts from besides the instance: an HTTPS origin or path, or
 * `https:` for every HTTPS host. Undefined when the value is not safe to put into a content
 * policy.
 */
function normalizeViewScriptSource(value: string): string | undefined {
  const trimmedValue = value.trim();
  if (trimmedValue === "*" || trimmedValue === "https:") {
    return "https:";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return undefined;
  }

  const source = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  return /[\s"'`;*<>{}]/u.test(source) ? undefined : source;
}

const viewScriptSourceSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!normalizeViewScriptSource(value)) {
      context.addIssue({
        code: "custom",
        message:
          'Script sources must be "*" for all HTTPS scripts, or HTTPS origins/paths without credentials, query strings, fragments, whitespace, quotes, semicolons, or wildcards.'
      });
    }
  })
  .transform((value) => normalizeViewScriptSource(value) ?? value);

const viewsConfigSchema = z
  .object({
    /**
     * Hosts a generated view may load scripts from besides the instance's own view runtime.
     * Read when a view is shown, so it also governs views saved earlier.
     */
    allowedScriptSrc: z
      .array(viewScriptSourceSchema)
      .default([])
      .transform((sources) => Array.from(new Set(sources)))
  })
  .prefault({});

const replyLinkHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/u, {
    message:
      'Link hosts must be host names such as "example.com", or "*.example.com" for every subdomain, without a scheme, port or path.'
  });

const repliesConfigSchema = z
  .object({
    /**
     * Hosts a link in a reply or in a Markdown file preview may point to besides the instance
     * itself. A link to any other host is shown as text with its address. Images from other
     * hosts are never loaded, whatever this list names.
     */
    allowedLinkHosts: z
      .array(replyLinkHostSchema)
      .default([])
      .transform((hosts) => Array.from(new Set(hosts)))
  })
  .strict()
  .prefault({});

const dataSourceConfigSchema = z.object({
  kind: z.literal("postgres"),
  connectionRef: z.string().min(1),
  description: z.string().min(1),
  sql: z.object({
    dialect: z.literal("postgres").default("postgres"),
    access: z.literal("read_only").default("read_only"),
    statementTimeoutMs: z.number().int().positive().default(10000),
    maxRows: z.number().int().positive().max(50000).default(5000),
    allowedSchemas: z.array(z.string().min(1)).default([]),
    schemaDescription: z.string().min(1).optional()
  }),
  tools: z
    .object({
      query: z
        .object({
          enabled: z.boolean().default(false),
          name: z.string().min(1).optional()
        })
        .optional(),
      renderView: z
        .object({
          enabled: z.boolean().default(false),
          name: z.string().min(1).optional(),
          modelVisibleOutput: z.literal("zero_data_ack").default("zero_data_ack")
        })
        .optional()
    })
    .optional()
});

export {
  agentConfigSchema,
  formatSkillMarkdown,
  parseSkillMarkdown as parseSkillManifest,
  SKILL_NAME_PATTERN,
  SKILL_NAME_RULE,
  skillConfigSchema,
  skillFileEntrySchema,
  skillFileFrontmatterSchema,
  SkillMarkdownError,
  skillNameSchema,
  skillPortabilityIssues,
  skillResourceConfigSchema,
  skillResourceMediaTypeForPath,
  skillResourcePathSchema,
  WORKFLOW_NAME_PATTERN,
  WORKFLOW_NAME_RULE,
  workflowConfigSchema,
  type SkillFileEntry,
  type WorkflowAssetConfig
} from "@work-shape/catalyst-asset-schemas";

// The base theme: clean off-white neutrals without a colour cast, one restrained orange accent,
// and a cool near-black in dark mode. An instance that sets no colours gets it; a customer
// theme replaces all seven.
const defaultLightUiTheme = {
  accentColor: "#b5573a",
  accentStrongColor: "#8c3f26",
  backgroundColor: "#f3f3f0",
  surfaceColor: "#fafaf8",
  textColor: "#1c1c1b",
  mutedTextColor: "#5e5d5a",
  borderColor: "#e1e0dc"
};

const defaultDarkUiTheme = {
  accentColor: "#d98c6c",
  accentStrongColor: "#e8ab90",
  backgroundColor: "#131315",
  surfaceColor: "#18181a",
  textColor: "#ececeb",
  mutedTextColor: "#a9aaac",
  borderColor: "#2d2d30"
};

function createUiThemeSchema(defaultTheme: typeof defaultLightUiTheme) {
  return z
    .object({
      accentColor: z.string().min(1).default(defaultTheme.accentColor),
      accentStrongColor: z.string().min(1).default(defaultTheme.accentStrongColor),
      backgroundColor: z.string().min(1).default(defaultTheme.backgroundColor),
      surfaceColor: z.string().min(1).default(defaultTheme.surfaceColor),
      textColor: z.string().min(1).default(defaultTheme.textColor),
      mutedTextColor: z.string().min(1).default(defaultTheme.mutedTextColor),
      borderColor: z.string().min(1).default(defaultTheme.borderColor)
    })
    .default(defaultTheme);
}

const lightUiThemeSchema = createUiThemeSchema(defaultLightUiTheme);

const darkUiThemeSchema = createUiThemeSchema(defaultDarkUiTheme);

/**
 * Where the instance's documentation is read. Only `http` and `https` are taken: the interface
 * renders the address as a link, and a `javascript:` or `data:` address there would run.
 */
const docsUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//iu.test(value), {
    message: "'ui.docsUrl' must be an http or https address"
  });

const DEFAULT_WELCOME_MESSAGE = { en: "How can I help?", de: "Wie kann ich helfen?" };

export const uiConfigSchema = z
  .object({
    clientName: localizedStringSchema.optional(),
    /**
     * The address the interface's links to the documentation start from. It has no default:
     * left out, or set to `null` over an inherited value, the interface shows no such link.
     */
    docsUrl: docsUrlSchema.nullable().optional(),
    logoUrl: z.string().url().or(z.string().startsWith("/")).optional(),
    logoUrlDark: z.string().url().or(z.string().startsWith("/")).optional(),
    logoInvertOnDark: z.boolean().default(false),
    faviconUrl: z.string().url().or(z.string().startsWith("/")).optional(),
    title: localizedStringSchema.default("Workshape Catalyst"),
    // A greeting in every language the interface ships, so an agent without one never greets
    // a German reader in English.
    welcomeMessage: localizedStringSchema.default(DEFAULT_WELCOME_MESSAGE),
    // The start page names the agent beside its icon; when false it shows the
    // icon alone, as a conversation always does.
    showAgentName: z.boolean().default(true),
    // The agent list shows each agent's description under its name, so a person sees what
    // each agent does before choosing it. False lists the names alone.
    showAgentDescriptions: z.boolean().default(true),
    /** Legacy switch of the module `resources`; use `modules.resources.enabled`. */
    resources: z.object({ enabled: z.boolean().optional() }).default({}),
    accentColor: z.string().min(1).default(defaultLightUiTheme.accentColor),
    theme: lightUiThemeSchema,
    darkTheme: darkUiThemeSchema,
    defaultThemeMode: z.enum(THEME_MODE_PREFERENCES).default("system")
  })
  .prefault({});

export const uiConfigOverlaySchema = uiConfigSchema
  .unwrap()
  .extend({
    resources: uiConfigSchema.unwrap().shape.resources.unwrap().strict().optional(),
    theme: lightUiThemeSchema.unwrap().strict().optional(),
    darkTheme: darkUiThemeSchema.unwrap().strict().optional()
  })
  .strict();

export const administrationConfigSchema = z
  .object({
    agentConfiguration: z
      .object({
        /** Legacy switch of the module `assetManagement`; use `modules.assetManagement.enabled`. */
        enabled: z.boolean().optional(),
        editableAgentFields: z.array(z.enum(AGENT_EDITABLE_FIELDS)).default([]),
        allowAgentCreation: z.boolean().default(false),
        allowAgentDeletion: z.boolean().default(false),
        allowDefaultAgentChange: z.boolean().default(false),
        allowSkillEditing: z.boolean().default(false),
        agentSkillChanges: z
          .object({
            enabled: z.boolean().default(false),
            allowSkillCreation: z.boolean().default(false)
          })
          .default({ enabled: false, allowSkillCreation: false })
      })
      .prefault({})
  })
  .prefault({});

const moduleSwitchSchema = z.object({ enabled: z.boolean() }).strict();

/**
 * One switch per module, `modules.<name>.enabled`. A module without an entry is off, except
 * that the four modules that had a switch before this section keep the state their legacy key
 * gives them for one transition release. `resolveModuleSwitches` reads the switches; nothing
 * else does.
 *
 * `modules.connections.personalModelRegions` lists the regions a model route may declare for a
 * run to call a personal Connection (MODEL-REGION-2). Left out, it is `[eu]`
 * (`DEFAULT_PERSONAL_MODEL_REGIONS`). The operator widens it only on the customer's written
 * instruction. An empty list would refuse every personal call without saying why, so it stops
 * startup instead.
 */
export const modulesConfigSchema = z
  .object({
    connections: moduleSwitchSchema
      .extend({
        personalModelRegions: z
          .array(providerRegionSchema)
          .min(1, {
            message: "List at least one region, or leave the key out for the default [eu]"
          })
          .optional()
      })
      .strict()
      .optional()
  })
  .catchall(moduleSwitchSchema)
  .default({});

/**
 * Written feedback on agent messages, of the module `feedback`. `exchangeSnapshot: false`
 * removes the box "Include my question and this answer": no comment then holds a copy of chat
 * content outside its conversation.
 */
export const feedbackConfigSchema = z
  .object({ exchangeSnapshot: z.boolean().default(true) })
  .strict()
  .prefault({});

/**
 * Where the operator of the platform takes problem reports (PLATFORM-REPORT). With `email`
 * set and platform mail configured, a run or a tool that failed for a platform reason offers
 * "Problem an Workshape melden": the run's id, the error code, the instance and the time go to
 * this address as a system mail, with the person's note if they write one. Unset, nothing is
 * offered and nothing is sent.
 */
export const supportConfigSchema = z
  .object({ email: z.string().trim().email().optional() })
  .strict()
  .prefault({});

/**
 * Apps of the module `apps`. `draftHosts.enabled: true` lets a person who builds an App allow
 * an outside host its draft lists for their own view of that draft, with one click, before the
 * draft is published (DRAFT-HOSTS-1). Off, the default, a draft connects only to the hosts of
 * its published revision, and no click is offered or accepted.
 */
export const appsConfigSchema = z
  .object({
    draftHosts: z
      .object({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({})
  })
  .strict()
  .prefault({});

const perMinuteSchema = z.number().int().positive();

/**
 * How often one caller may call one operation, per minute. The defaults stop spamming and
 * guessing only: nothing a person or a host backend does in ordinary use comes near them. A
 * caller over a limit reads 429 `RATE_LIMITED` with the seconds to wait. The defaults here are
 * the only copy.
 */
export const rateLimitsConfigSchema = z
  .object({
    /** False turns every limit on API calls off. */
    enabled: z.boolean().default(true),
    /** Calls to one reading operation, per signed-in person or service. */
    readPerMinute: perMinuteSchema.default(6000),
    /** Calls to one changing operation, per signed-in person or service. */
    writePerMinute: perMinuteSchema.default(1200),
    /** Sign-in and password tries on one account from one client address. */
    signInPerAccountPerMinute: perMinuteSchema.default(10),
    /** Sign-in and password tries from one client address, whatever the account. */
    signInPerAddressPerMinute: perMinuteSchema.default(300)
  })
  .strict()
  .prefault({});

/**
 * The policy value of an operation that nothing else names one for: no declaration of the
 * release and no setting of an admin. A reading operation runs or is refused; a changing one
 * may also ask its caller to confirm or another person to approve.
 */
/**
 * An operation's name, `me.operation_settings.set`, or every operation under a prefix,
 * `connection.crm.*`. A bare `*` or a part cut off, `connection.cr*`, names no operation.
 */
const ALWAYS_ALLOW_LOCK_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_-]*)*(?:\.\*)?$/u;

const policyConfigSchema = z
  .object({
    defaults: z
      .object({
        reading: z.enum(READING_POLICY_VALUES).default("allow"),
        changing: z.enum(POLICY_VALUES).default("confirm")
      })
      .strict()
      .prefault({}),
    /**
     * Whether people may set "Always allow" for their own agents' calls (OP-6). A `reversible`
     * change may be always allowed, `irreversible` and `outward` changes and changes without a
     * class may not. `locked` takes it away from operations by name or by a pattern such as
     * `connection.crm.*`; a lock never gives it. The admin's lock lives here until the Policies
     * screen (OP-2) holds it.
     */
    alwaysAllow: z
      .object({
        locked: z
          .array(
            z.string().trim().regex(ALWAYS_ALLOW_LOCK_PATTERN, {
              message:
                "Name an operation exactly, or every operation under a prefix such as 'connection.crm.*'; '*' and 'name*' are no names"
            })
          )
          .default([])
      })
      .strict()
      .prefault({})
  })
  .strict()
  .prefault({});

/** Whether a name is a time zone the runtime can read a clock in. */
function isTimeZoneName(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export const clientInstanceConfigSchema = z.object({
  scopes: dataScopesSchema.optional(),
  version: z.literal(1).default(1),
  clientInstance: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    environment: z.enum(["development", "staging", "production"]).default("development"),
    /**
     * The time zone of the instance, as an IANA name such as `Europe/Berlin`. The cron
     * expressions of scheduled Workflows are read on its clock, its daylight-saving days
     * included. UTC when left out. A name that is no time zone is refused.
     */
    timeZone: z
      .string()
      .min(1)
      .refine(isTimeZoneName, {
        message: "timeZone is an IANA time zone name such as 'Europe/Berlin', or 'UTC'"
      })
      .optional()
  }),
  auth: z
    .object({
      standalone: z.object(standaloneAuthConfigSchema.shape).optional(),
      development: z.object(developmentAuthConfigSchema.shape).optional(),
      sessionToken: z
        .object({
          issuer: z.string().min(1).default("vivd-catalyst"),
          ttlSeconds: z.number().int().positive().max(3600).default(900)
        })
        .optional(),
      identityLinking: z
        .object({
          byVerifiedEmail: z.boolean().default(true)
        })
        .default({ byVerifiedEmail: true })
    })
    .prefault({}),
  retention: z
    .object({
      conversationDays: z.number().int().positive().max(3650).default(30),
      /**
       * False keeps every conversation a user started: the retention job only
       * removes abandoned drafts without messages or draft attachments. New
       * conversations are still stamped from `conversationDays`, so turning
       * expiry back on expires everything already past its date.
       */
      expireConversations: z.boolean().default(true),
      /**
       * True counts `conversationDays` from the last message a user sent: accepting a message
       * moves the date. False keeps the date set at creation, a fixed maximum age. Only the
       * operator knows which of the two the customer was promised.
       */
      extendOnActivity: z.boolean().default(true),
      /**
       * The `audit.prune` job deletes audit events older than this once a day and records
       * one `audit.pruned` event with the count.
       */
      auditDays: z.number().int().positive().max(3650).default(365),
      /**
       * For how many days after a Workflow Run ended the inputs and outputs of its steps, and
       * its own input and result, are kept. The job `workflow_run.prune_data` removes them
       * once a day. The run and its step runs stay, with status, times and error codes.
       */
      workflowStepDataDays: z.number().int().positive().max(3650).default(30),
      allowUserDelete: z.boolean().default(true),
      /**
       * For how many days a comment of the module `feedback` is kept, from when it was sent,
       * with its copy of the question and answer. It does not follow `conversationDays`: a
       * comment is worth reading after its conversation is gone. The job `feedback.prune`
       * deletes older ones once a day.
       */
      feedbackDays: z.number().int().positive().max(3650).default(365)
    })
    .default({
      conversationDays: 30,
      expireConversations: true,
      extendOnActivity: true,
      auditDays: 365,
      workflowStepDataDays: 30,
      allowUserDelete: true,
      feedbackDays: 365
    }),
  infrastructure: infrastructureConfigSchema,
  /** Where the instance is reached: its public origin. */
  instance: instanceConfigSchema,
  modelBindings: z.array(modelBindingConfigSchema).default([]),
  /** The Knowledge Bases of the instance: which embedding binding semantic search uses. */
  knowledge: knowledgeConfigSchema,
  localization: localizationConfigSchema,
  conversationTitles: conversationTitleConfigSchema,
  /** The release's guardrails: the operator's floor. Seeded as read-only assets when the API starts. */
  guardrails: releaseGuardrailsConfigSchema,
  runtime: agentRuntimeConfigSchema,
  modelContext: modelContextConfigSchema,
  webAccess: webAccessConfigSchema,
  executionWorkspaces: executionWorkspacesConfigSchema,
  workflows: workflowsConfigSchema,
  administration: administrationConfigSchema,
  modules: modulesConfigSchema,
  /** Read with the module `feedback` on. */
  feedback: feedbackConfigSchema,
  /** Read with the module `apps` on. */
  apps: appsConfigSchema,
  /** The operator's support address for platform problem reports. */
  support: supportConfigSchema,
  rateLimits: rateLimitsConfigSchema,
  capabilities: z.record(z.string(), z.unknown()).default({}),
  usage: z
    .object({
      budget: usageBudgetConfigSchema,
      safeguards: usageSafeguardsConfigSchema,
      costs: usageCostConfigSchema
    })
    .prefault({}),
  tools: z.array(toolInstanceConfigSchema).default([]),
  views: viewsConfigSchema,
  replies: repliesConfigSchema,
  dataSources: z.record(z.string(), dataSourceConfigSchema).default({}),
  /** The Connections the release defines. Seeded as read-only assets when the API starts. */
  connections: releaseConnectionsConfigSchema,
  /** The keys Connection secrets are encrypted with. Needed once `connections` names one. */
  secretStore: secretStoreConfigSchema,
  /** The limits of the instance's Data Stores. Read with the module `dataStores` on. */
  dataStores: dataStoresConfigSchema,
  /**
   * The caps of each project's files (PRJ-2). Read with the module `projects` on. A project
   * and its files do not expire by themselves: only its conversations do.
   */
  projects: z
    .object({
      files: z
        .object({
          /** Files a project holds at most; a deleted file does not count. */
          maxFiles: z.number().int().positive().max(100_000).default(500),
          maxFileBytes: z
            .number()
            .int()
            .positive()
            .default(50 * 1024 * 1024),
          /** Every kept version counts, each stored object once. */
          maxProjectBytes: z
            .number()
            .int()
            .positive()
            .default(2 * 1024 * 1024 * 1024),
          /** Versions kept per file; the next one removes the oldest. */
          versionsPerFile: z.number().int().min(1).max(1000).default(20)
        })
        .strict()
        .prefault({})
    })
    .strict()
    .prefault({}),
  /** The outside targets Connections may reach. Empty refuses all of them. */
  egress: egressConfigSchema,
  /** The catalogue entries this instance offers in New connection. */
  catalogue: catalogueConfigSchema,
  ui: uiConfigSchema,
  policy: policyConfigSchema
});

const MOVED_ASSET_CONFIG_KEYS = [
  "agents",
  "agentFiles",
  "skills",
  "skillFiles",
  "defaultAgentName"
] as const;

export const clientInstanceConfigFileSchema = z.preprocess(
  (raw, context) => {
    if (typeof raw === "object" && raw !== null) {
      for (const key of MOVED_ASSET_CONFIG_KEYS) {
        if (key in raw) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `'${key}' moved to the platform asset store and is no longer read from config files - manage agents and skills with 'catalyst config push'`
          });
        }
      }
    }
    return raw;
  },
  clientInstanceConfigSchema
    .omit({
      ui: true
    })
    .extend({
      ui: z.unknown().optional(),
      uiFile: z.string().min(1).optional()
    })
);

export type ToolInstanceConfig = z.infer<typeof toolInstanceConfigSchema>;

export type {
  AgentConfig,
  AgentRuntimeConfig,
  CapabilityConfigMap,
  DataSourceConfig,
  ExecutionWorkspacesConfig,
  LocalizationConfig,
  ModelBindingConfig,
  ModelContextConfig,
  ModelProviderConfig,
  SkillConfig,
  SkillResourceConfig,
  SkillResourceMediaType,
  UsageBudgetConfig,
  UsageCostConfig,
  UsageRateCardConfig,
  UsageSafeguardsConfig,
  WebAccessConfig
};

export type RateLimitsConfig = z.infer<typeof rateLimitsConfigSchema>;

export type ClientInstanceConfig = z.infer<typeof clientInstanceConfigSchema>;
export {
  userIdentitySchema,
  type StandaloneSeedUserConfig,
  type UserIdentityConfig
} from "./auth-schema";

export {
  usageBudgetConfigSchema,
  usageCostConfigSchema,
  usageRateCardConfigSchema,
  usageSafeguardsConfigSchema
} from "./usage-schema";

export {
  agentRuntimeConfigSchema,
  conversationTitleConfigSchema,
  executionWorkspacesConfigSchema,
  modelContextConfigSchema,
  webAccessConfigSchema,
  workflowsConfigSchema
} from "./runtime-schema";
