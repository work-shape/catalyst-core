import { z } from "zod";
import type {
  AgentConfig,
  ApprovalCheckConfig,
  DataSourceConfig,
  CapabilityConfigMap,
  LocalizationConfig,
  AgentRuntimeConfig,
  ExecutionWorkspacesConfig,
  ModelContextConfig,
  ModelBindingConfig,
  ModelProviderConfig,
  SkillConfig,
  SkillResourceConfig,
  SkillResourceMediaType,
  UsageBudgetConfig,
  UsageCostConfig,
  UsageRateCardConfig,
  UsageSafeguardsConfig,
  WebAccessConfig
} from "@vivd-catalyst/core";
import {
  AGENT_EDITABLE_FIELDS,
  isSecretName,
  MODEL_USAGE_TIERS,
  REASONING_EFFORTS,
  SECRET_NAME_EXPECTATION,
  SKILL_RESOURCE_MEDIA_TYPES
} from "@vivd-catalyst/core";
import { infrastructureConfigSchema } from "./infrastructure";
import { localizationConfigSchema, localizedStringSchema } from "./localization";

export const userIdentitySchema = z.object({
  id: z.string().min(1).default("dev-user"),
  externalUserId: z.string().min(1).default("dev-user"),
  displayLabel: z.string().min(1).default("Development User"),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string().min(1)).default(["user", "admin"]),
  permissionRefs: z.array(z.string().min(1)).default([]),
  permissions: z.array(z.string().min(1)).default([]),
  authSource: z.string().min(1).default("development")
});

const defaultDevelopmentUser = {
  id: "dev-user",
  externalUserId: "dev-user",
  displayLabel: "Development User",
  roles: ["user", "admin"],
  permissionRefs: [],
  permissions: [],
  authSource: "development"
};

const developmentAuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  user: userIdentitySchema.default(defaultDevelopmentUser),
  users: z.array(userIdentitySchema).default([]),
  defaultUserId: z.string().min(1).optional()
});

const standaloneSeedUserSchema = z.object({
  email: z.string().email(),
  emailEnvName: z.string().min(1).optional(),
  displayLabel: z.string().min(1),
  /** The name of a secret, never the password. A refused name is not repeated in a message. */
  passwordEnvName: z.string().min(1).refine(isSecretName, SECRET_NAME_EXPECTATION),
  developmentPassword: z.string().min(8).optional(),
  roles: z.array(z.string().min(1)).default(["user"]),
  permissionRefs: z.array(z.string().min(1)).default([]),
  permissions: z.array(z.string().min(1)).default([])
});

const standaloneAuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
  trustedOrigins: z.array(z.string().url()).default([]),
  seedUsers: z.array(standaloneSeedUserSchema).default([])
});

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
  .default({ allowedScriptSrc: [] });

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

export const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u, {
    message:
      "Skill name must start with a letter and contain only letters, numbers, dots, underscores, or hyphens"
  });

export const skillResourcePathSchema = z
  .string()
  .min(1)
  .superRefine((path, context) => {
    const segments = path.split("/");
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Skill resource path must be a normalized relative path"
      });
    }
    if (path.toLowerCase() === "skill.md" || path.toLowerCase().endsWith("/skill.md")) {
      context.addIssue({
        code: "custom",
        message: "SKILL.md is the skill root and cannot also be a resource"
      });
    }
  });

export function skillResourceMediaTypeForPath(path: string): SkillResourceMediaType | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return undefined;
  }
}

export const skillResourceConfigSchema = z
  .object({
    path: skillResourcePathSchema,
    mediaType: z.enum(SKILL_RESOURCE_MEDIA_TYPES),
    content: z.string().refine((content) => !content.includes("\0"), {
      message: "Skill resources must contain text, not binary data"
    })
  })
  .superRefine((resource, context) => {
    const expectedMediaType = skillResourceMediaTypeForPath(resource.path);
    if (!expectedMediaType) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Unsupported skill resource extension"
      });
    } else if (resource.mediaType !== expectedMediaType) {
      context.addIssue({
        code: "custom",
        path: ["mediaType"],
        message: `Skill resource '${resource.path}' must use media type '${expectedMediaType}'`
      });
    }
  });

const skillConfigObjectSchema = z.object({
  name: skillNameSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  resources: z.array(skillResourceConfigSchema).optional()
});

export const skillConfigSchema = skillConfigObjectSchema.superRefine((skill, context) => {
  const seen = new Set<string>();
  for (const [index, resource] of (skill.resources ?? []).entries()) {
    const pathKey = resource.path.toLowerCase();
    if (seen.has(pathKey)) {
      context.addIssue({
        code: "custom",
        path: ["resources", index, "path"],
        message: `Duplicate skill resource path: ${resource.path}`
      });
    }
    seen.add(pathKey);
  }
});

export const skillFileFrontmatterSchema = skillConfigObjectSchema
  .omit({
    content: true,
    resources: true
  })
  .extend({
    name: skillNameSchema.optional()
  });

export const modelBindingConfigSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  agentSelectable: z.boolean().default(true),
  // Accepted for compatibility; no effect. Each agent lists the models its users may pick.
  userSelectable: z.boolean().default(false),
  supportsFastMode: z.boolean().default(false),
  description: localizedStringSchema.optional(),
  vendor: z.string().min(1).optional(),
  usageTier: z.enum(MODEL_USAGE_TIERS).optional(),
  userSelectableReasoningEfforts: z.array(z.enum(REASONING_EFFORTS)).optional()
});

const welcomeSubtitleSchema = z.union([
  z.string(),
  z
    .object({
      en: z.string().optional(),
      de: z.string().optional()
    })
    .strict()
    .refine((value) => value.en !== undefined || value.de !== undefined, {
      message: "At least one localized value is required"
    })
]);

export const agentConfigSchema = z.object({
  name: z.string().min(1),
  displayName: localizedStringSchema,
  description: localizedStringSchema.optional(),
  welcomeMessage: localizedStringSchema.optional(),
  welcomeSubtitle: welcomeSubtitleSchema.optional(),
  instructions: z.string().min(1),
  modelProviderId: z.string().min(1).optional(),
  modelBindingId: z.string().min(1).optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
  fastMode: z.boolean().optional(),
  userSelectableModelBindingIds: z.array(z.string().min(1)).optional(),
  modelReasoningEfforts: z.record(z.string().min(1), z.enum(REASONING_EFFORTS)).optional(),
  maxSteps: z.number().int().positive().optional(),
  toolNames: z.array(z.string().min(1)).default([]),
  skillNames: z.array(skillNameSchema).default([]),
  initialPrompts: z
    .array(
      z.object({
        title: localizedStringSchema,
        prompt: localizedStringSchema
      })
    )
    .default([])
});

export const usageBudgetConfigSchema = z
  .object({
    dailySpendLimit: z.number().positive().optional(),
    monthlySpendLimit: z.number().positive().optional(),
    costSafetyMultiplier: z.number().min(1).default(1)
  })
  .default({ costSafetyMultiplier: 1 });

export const usageSafeguardsConfigSchema = z
  .object({
    modelCallsPerDay: z.number().int().positive().optional(),
    tokensPerDay: z.number().int().positive().optional(),
    tokensPerMonth: z.number().int().positive().optional()
  })
  .default({});

const usageRateCardTokenRatesShape = {
  uncachedInputPricePerMillionTokens: z.number().nonnegative(),
  cachedInputPricePerMillionTokens: z.number().nonnegative(),
  outputPricePerMillionTokens: z.number().nonnegative()
};

export const usageRateCardConfigSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .default("USD"),
  models: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1),
        ...usageRateCardTokenRatesShape,
        fast: z.object(usageRateCardTokenRatesShape).optional()
      })
    )
    .default([]),
  webSearch: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1).optional(),
        pricePerCall: z.number().nonnegative()
      })
    )
    .default([])
});

export const usageCostConfigSchema = z
  .object({
    customer: usageRateCardConfigSchema.optional()
  })
  .default({});

export const approvalCheckConfigSchema = z.object({
  id: z.string().trim().min(1),
  appliesTo: z.string().trim().min(1),
  modelBindingId: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  onFail: z.enum(["warn", "block"])
}) satisfies z.ZodType<ApprovalCheckConfig>;

const approvalChecksConfigSchema = z
  .array(approvalCheckConfigSchema)
  .superRefine((checks, context) => {
    const ids = new Set<string>();
    checks.forEach((check, index) => {
      if (ids.has(check.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate approval check id '${check.id}'`
        });
      }
      ids.add(check.id);
    });
  })
  .default([]);

export const conversationTitleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    modelProviderId: z.string().min(1).optional(),
    modelBindingId: z.string().min(1).optional(),
    model: z.string().min(1).optional()
  })
  .default({
    enabled: true
  });

export const agentRuntimeConfigSchema = z
  .object({
    maxSteps: z.number().int().positive().default(64),
    repeatedToolCallLimit: z.number().int().positive().default(3)
  })
  .default({
    maxSteps: 64,
    repeatedToolCallLimit: 3
  });

export const modelContextConfigSchema = z
  .object({
    toolOutput: z
      .object({
        maxTokens: z.number().int().positive().default(60000),
        maxBytes: z.number().int().positive().optional()
      })
      .default({
        maxTokens: 60000
      })
  })
  .default({
    toolOutput: {
      maxTokens: 60000
    }
  });

const REMOVED_WEB_SEARCH_KEYS = ["mode", "managedProvider"] as const;

/**
 * The instance switch for web search. The two keys that chose between a provider's own search
 * and a managed one are refused by name: a model's adapter declares whether it can search.
 */
const webSearchConfigSchema = z.preprocess(
  (raw, context) => {
    if (typeof raw === "object" && raw !== null) {
      for (const key of REMOVED_WEB_SEARCH_KEYS) {
        if (key in raw) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `'webAccess.search.${key}' was removed: whether a model can search the web is declared by its provider, and 'webAccess.search.enabled' is the only switch. Delete the key`
          });
        }
      }
    }
    return raw;
  },
  z.object({ enabled: z.boolean().default(false) }).default({ enabled: false })
);

export const webAccessConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    search: webSearchConfigSchema,
    fetch: z
      .object({
        enabled: z.boolean().default(false),
        timeoutMs: z.number().int().positive().max(30000).default(10000),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024)
          .default(1024 * 1024),
        maxTextCharacters: z.number().int().positive().max(200000).default(20000),
        maxRedirects: z.number().int().nonnegative().max(10).default(5)
      })
      .default({
        enabled: false,
        timeoutMs: 10000,
        maxResponseBytes: 1024 * 1024,
        maxTextCharacters: 20000,
        maxRedirects: 5
      })
  })
  .default({
    enabled: false,
    search: {
      enabled: false
    },
    fetch: {
      enabled: false,
      timeoutMs: 10000,
      maxResponseBytes: 1024 * 1024,
      maxTextCharacters: 20000,
      maxRedirects: 5
    }
  });

export const executionWorkspacesConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sourceFiles: z
      .object({
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .default(25 * 1024 * 1024)
      })
      .default({
        maxFileBytes: 25 * 1024 * 1024
      }),
    command: z
      .object({
        defaultTimeoutSeconds: z.number().int().positive().default(60),
        maxTimeoutSeconds: z.number().int().positive().default(300),
        idleTimeoutSeconds: z.number().int().positive().default(30),
        maxStdoutBytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024),
        maxStderrBytes: z
          .number()
          .int()
          .positive()
          .default(64 * 1024),
        maxWorkspaceBytes: z
          .number()
          .int()
          .positive()
          .default(100 * 1024 * 1024)
      })
      .default({
        defaultTimeoutSeconds: 60,
        maxTimeoutSeconds: 300,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
        maxWorkspaceBytes: 100 * 1024 * 1024
      }),
    worker: z
      .object({
        concurrency: z.number().int().positive().default(1),
        pollIntervalMs: z.number().int().positive().default(1000),
        leaseDurationMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60 * 1000),
        heartbeatIntervalMs: z.number().int().positive().default(5000),
        cancellationPollIntervalMs: z.number().int().positive().default(1000),
        staleRecoveryIntervalMs: z.number().int().positive().default(30000),
        staleRecoveryLimit: z.number().int().positive().default(50)
      })
      .default({
        concurrency: 1,
        pollIntervalMs: 1000,
        leaseDurationMs: 10 * 60 * 1000,
        heartbeatIntervalMs: 5000,
        cancellationPollIntervalMs: 1000,
        staleRecoveryIntervalMs: 30000,
        staleRecoveryLimit: 50
      }),
    cleanup: z
      .object({
        deletedWorkspaceCleanupIntervalMs: z
          .number()
          .int()
          .positive()
          .default(60 * 60 * 1000),
        deletedWorkspaceCleanupBatchSize: z.number().int().positive().default(100),
        tempStateCleanupIntervalMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60 * 1000),
        hydratedWorkspaceIdleTtlMs: z
          .number()
          .int()
          .nonnegative()
          .default(60 * 60 * 1000)
      })
      .default({
        deletedWorkspaceCleanupIntervalMs: 60 * 60 * 1000,
        deletedWorkspaceCleanupBatchSize: 100,
        tempStateCleanupIntervalMs: 10 * 60 * 1000,
        hydratedWorkspaceIdleTtlMs: 60 * 60 * 1000
      })
  })
  .superRefine((config, context) => {
    if (config.command.defaultTimeoutSeconds > config.command.maxTimeoutSeconds) {
      context.addIssue({
        code: "custom",
        path: ["command", "defaultTimeoutSeconds"],
        message: "Default workspace command timeout must not exceed the maximum timeout"
      });
    }
    if (config.worker.heartbeatIntervalMs >= config.worker.leaseDurationMs) {
      context.addIssue({
        code: "custom",
        path: ["worker", "heartbeatIntervalMs"],
        message: "Workspace command heartbeat interval must be shorter than the lease duration"
      });
    }
  })
  .default({
    enabled: false,
    sourceFiles: {
      maxFileBytes: 25 * 1024 * 1024
    },
    command: {
      defaultTimeoutSeconds: 60,
      maxTimeoutSeconds: 300,
      idleTimeoutSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxWorkspaceBytes: 100 * 1024 * 1024
    },
    worker: {
      concurrency: 1,
      pollIntervalMs: 1000,
      leaseDurationMs: 10 * 60 * 1000,
      heartbeatIntervalMs: 5000,
      cancellationPollIntervalMs: 1000,
      staleRecoveryIntervalMs: 30000,
      staleRecoveryLimit: 50
    },
    cleanup: {
      deletedWorkspaceCleanupIntervalMs: 60 * 60 * 1000,
      deletedWorkspaceCleanupBatchSize: 100,
      tempStateCleanupIntervalMs: 10 * 60 * 1000,
      hydratedWorkspaceIdleTtlMs: 60 * 60 * 1000
    }
  });

// The base theme: warm paper neutrals with one restrained orange accent, and a warm near-black
// in dark mode. An instance that sets no colours gets it; a customer theme replaces all seven.
const defaultLightUiTheme = {
  accentColor: "#b5573a",
  accentStrongColor: "#8c3f26",
  backgroundColor: "#f6f3ec",
  surfaceColor: "#fdfbf7",
  textColor: "#201c17",
  mutedTextColor: "#655e54",
  borderColor: "#e7e1d5"
};

const defaultDarkUiTheme = {
  accentColor: "#d98c6c",
  accentStrongColor: "#e8ab90",
  backgroundColor: "#131210",
  surfaceColor: "#1c1a17",
  textColor: "#efebe4",
  mutedTextColor: "#b3ada3",
  borderColor: "#33302b"
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

export const uiConfigSchema = z
  .object({
    clientName: localizedStringSchema.optional(),
    logoUrl: z.string().url().or(z.string().startsWith("/")).optional(),
    logoUrlDark: z.string().url().or(z.string().startsWith("/")).optional(),
    logoInvertOnDark: z.boolean().default(false),
    faviconUrl: z.string().url().or(z.string().startsWith("/")).optional(),
    title: localizedStringSchema.default("Vivd Catalyst"),
    welcomeMessage: localizedStringSchema.default("How can I help?"),
    // The start page names the agent beside its icon; when false it shows the
    // icon alone, as a conversation always does.
    showAgentName: z.boolean().default(true),
    // When true the agent list shows each agent's description under its name.
    showAgentDescriptions: z.boolean().default(false),
    resources: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    accentColor: z.string().min(1).default(defaultLightUiTheme.accentColor),
    theme: lightUiThemeSchema,
    darkTheme: darkUiThemeSchema,
    defaultThemeMode: z.enum(["light", "dark", "system"]).default("system")
  })
  .default({
    title: "Vivd Catalyst",
    welcomeMessage: "How can I help?",
    showAgentName: true,
    showAgentDescriptions: false,
    resources: { enabled: true },
    accentColor: defaultLightUiTheme.accentColor,
    logoInvertOnDark: false,
    theme: defaultLightUiTheme,
    darkTheme: defaultDarkUiTheme,
    defaultThemeMode: "system"
  });

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
        enabled: z.boolean().default(false),
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
      .default({
        enabled: false,
        editableAgentFields: [],
        allowAgentCreation: false,
        allowAgentDeletion: false,
        allowDefaultAgentChange: false,
        allowSkillEditing: false,
        agentSkillChanges: { enabled: false, allowSkillCreation: false }
      })
  })
  .default({
    agentConfiguration: {
      enabled: false,
      editableAgentFields: [],
      allowAgentCreation: false,
      allowAgentDeletion: false,
      allowDefaultAgentChange: false,
      allowSkillEditing: false,
      agentSkillChanges: { enabled: false, allowSkillCreation: false }
    }
  });

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
const policyConfigSchema = z
  .object({
    defaults: z
      .object({
        reading: z.enum(["allow", "deny"]).default("allow"),
        changing: z.enum(["allow", "confirm", "approval", "deny"]).default("confirm")
      })
      .strict()
      .prefault({})
  })
  .strict()
  .prefault({});

export const clientInstanceConfigSchema = z.object({
  version: z.literal(1).default(1),
  clientInstance: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    environment: z.enum(["development", "staging", "production"]).default("development")
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
    .default({
      identityLinking: { byVerifiedEmail: true }
    }),
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
      allowUserDelete: z.boolean().default(true)
    })
    .default({
      conversationDays: 30,
      expireConversations: true,
      extendOnActivity: true,
      auditDays: 365,
      allowUserDelete: true
    }),
  infrastructure: infrastructureConfigSchema,
  modelBindings: z.array(modelBindingConfigSchema).default([]),
  localization: localizationConfigSchema,
  conversationTitles: conversationTitleConfigSchema,
  approvalChecks: approvalChecksConfigSchema,
  runtime: agentRuntimeConfigSchema,
  modelContext: modelContextConfigSchema,
  webAccess: webAccessConfigSchema,
  executionWorkspaces: executionWorkspacesConfigSchema,
  administration: administrationConfigSchema,
  rateLimits: rateLimitsConfigSchema,
  capabilities: z.record(z.string(), z.unknown()).default({}),
  usage: z
    .object({
      budget: usageBudgetConfigSchema,
      safeguards: usageSafeguardsConfigSchema,
      costs: usageCostConfigSchema
    })
    .default({
      budget: { costSafetyMultiplier: 1 },
      safeguards: {},
      costs: {}
    }),
  tools: z.array(toolInstanceConfigSchema).default([]),
  views: viewsConfigSchema,
  dataSources: z.record(z.string(), dataSourceConfigSchema).default({}),
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

export type UserIdentityConfig = z.infer<typeof userIdentitySchema>;
export type StandaloneSeedUserConfig = z.infer<typeof standaloneSeedUserSchema>;
export type ToolInstanceConfig = z.infer<typeof toolInstanceConfigSchema>;
export type {
  AgentConfig,
  ApprovalCheckConfig,
  DataSourceConfig,
  CapabilityConfigMap,
  ExecutionWorkspacesConfig,
  LocalizationConfig,
  ModelBindingConfig,
  ModelProviderConfig,
  SkillConfig,
  SkillResourceConfig,
  SkillResourceMediaType,
  UsageBudgetConfig,
  AgentRuntimeConfig,
  ModelContextConfig,
  UsageCostConfig,
  UsageRateCardConfig,
  UsageSafeguardsConfig,
  WebAccessConfig
};
export type RateLimitsConfig = z.infer<typeof rateLimitsConfigSchema>;
export type ClientInstanceConfig = z.infer<typeof clientInstanceConfigSchema>;
