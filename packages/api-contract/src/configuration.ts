import { timestampSchema } from "./shared";
import { z } from "zod";
import { auditActorSchema } from "./identity";

export const localeCodeSchema = z.enum(["en", "de"]);

export const localizationSchema = z.object({
  locale: localeCodeSchema,
  defaultLocale: localeCodeSchema,
  supportedLocales: z.array(localeCodeSchema)
});

export const reasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);

/**
 * The model and reasoning efforts a user last picked, which a new conversation starts from.
 * `reasoningEfforts` is keyed by the binding id of the model each effort was picked for.
 */
export const userModelPreferenceSchema = z.object({
  modelBindingId: z.string().min(1).optional(),
  reasoningEfforts: z.record(z.string().min(1), reasoningEffortSchema)
});
export const modelUsageTierSchema = z.enum(["low", "moderate", "high", "very_high"]);
export const modelResidencySchema = z.enum(["global", "eu", "unknown"]);

export const agentEditableFieldSchema = z.enum([
  "displayName",
  "description",
  "welcomeMessage",
  "welcomeSubtitle",
  "instructions",
  "modelBindingId",
  "reasoningEffort",
  "maxSteps",
  "toolNames",
  "skillNames",
  "initialPrompts"
]);

const editableAgentFieldsSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const legacy = value as { model?: unknown; maxSteps?: unknown };
  return [
    ...(legacy.model === true ? ["modelBindingId", "reasoningEffort"] : []),
    ...(legacy.maxSteps === true ? ["maxSteps"] : [])
  ];
}, z.array(agentEditableFieldSchema));

const clientUiBrandingSchema = z.object({
  localization: localizationSchema,
  clientName: z.string(),
  logoUrl: z.string().optional(),
  logoUrlDark: z.string().optional(),
  logoInvertOnDark: z.boolean(),
  faviconUrl: z.string().optional(),
  title: z.string(),
  welcomeMessage: z.string(),
  showAgentName: z.boolean(),
  showAgentDescriptions: z.boolean(),
  accentColor: z.string(),
  theme: z.object({
    accentColor: z.string(),
    accentStrongColor: z.string(),
    backgroundColor: z.string(),
    surfaceColor: z.string(),
    textColor: z.string(),
    mutedTextColor: z.string(),
    borderColor: z.string()
  }),
  darkTheme: z.object({
    accentColor: z.string(),
    accentStrongColor: z.string(),
    backgroundColor: z.string(),
    surfaceColor: z.string(),
    textColor: z.string(),
    mutedTextColor: z.string(),
    borderColor: z.string()
  }),
  defaultThemeMode: z.enum(["light", "dark", "system"])
});

export const clientBrandingSchema = clientUiBrandingSchema.extend({
  environment: z.string(),
  passwordResetEnabled: z.boolean().default(false)
});

export const safeConfigSchema = z.object({
  clientInstance: z.object({
    id: z.string(),
    displayName: z.string(),
    environment: z.string()
  }),
  localization: localizationSchema,
  retention: z.object({
    conversationDays: z.number(),
    expireConversations: z.boolean(),
    auditDays: z.number(),
    allowUserDelete: z.boolean()
  }),
  usage: z.object({
    safeguards: z.object({
      modelCallsPerDay: z.number().optional(),
      tokensPerDay: z.number().optional(),
      tokensPerMonth: z.number().optional()
    })
  }),
  features: z.object({
    attachments: z.object({
      enabled: z.boolean(),
      accept: z.string()
    }),
    resources: z.object({
      enabled: z.boolean()
    }),
    collaborationWorkspaces: z.object({
      enabled: z.boolean()
    }),
    configAssets: z.object({
      enabled: z.boolean(),
      editableAgentFields: editableAgentFieldsSchema,
      allowAgentCreation: z.boolean().default(false),
      allowAgentDeletion: z.boolean().default(false),
      allowDefaultAgentChange: z.boolean().default(false),
      allowSkillEditing: z.boolean().default(false),
      agentSkillChanges: z
        .object({ enabled: z.boolean(), allowSkillCreation: z.boolean() })
        .default({ enabled: false, allowSkillCreation: false })
    }),
    userInvitations: z.object({ enabled: z.boolean() }).default({ enabled: false })
  }),
  defaultAgentName: z.string().optional(),
  agents: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      defaultModelBindingId: z.string().optional(),
      /** The agent's own model first (no `bindingId` when it uses a provider default), then the models users may pick instead. */
      selectableModels: z.array(
        z.object({
          bindingId: z.string().optional(),
          model: z.string(),
          compactThresholdTokens: z.number().optional(),
          /** Who makes the model, when release config names it; otherwise read from the model id. */
          vendor: z.string().optional(),
          description: z.string().optional(),
          residency: modelResidencySchema.optional(),
          usageTier: modelUsageTierSchema.optional(),
          /** The effort a run uses when the user picks none. */
          reasoningEffort: reasoningEffortSchema.optional(),
          /** Efforts the user may pick instead; empty when the model offers no choice. */
          selectableReasoningEfforts: z.array(reasoningEffortSchema)
        })
      ),
      compactThresholdTokens: z.number().optional(),
      welcomeMessage: z.string().optional(),
      welcomeSubtitle: z.string().optional(),
      initialPrompts: z.array(
        z.object({
          title: z.string(),
          prompt: z.string()
        })
      )
    })
  ),
  ui: clientUiBrandingSchema
});

export const collaborationWorkspaceAgentsSchema = z.object({
  defaultAgentName: z.string().optional(),
  items: safeConfigSchema.shape.agents,
  nextCursor: z.string().optional()
});

export const usageSafeguardsSchema = safeConfigSchema.shape.usage.shape.safeguards;

export const configAssetKindSchema = z.enum(["agent", "skill"]);

export const agentAvailabilitySchema = z.object({
  mode: z.enum(["all", "selected"]),
  personalWorkspaces: z.boolean(),
  collaborationWorkspaceIds: z.array(z.string())
});

export const setConfigAgentAvailabilityRequestSchema = z.object({
  mode: agentAvailabilitySchema.shape.mode,
  // Both apply to `selected` only and are ignored for `all`.
  personalWorkspaces: z.boolean().optional(),
  collaborationWorkspaceIds: z.array(z.string().min(1)).optional()
});

export const administeredCollaborationWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: timestampSchema
});

export const configAssetSummarySchema = z.object({
  kind: configAssetKindSchema,
  name: z.string(),
  revision: z.number().int().positive(),
  updatedAt: timestampSchema,
  // Agents only. An agent without availability is hidden in every workspace.
  availability: agentAvailabilitySchema.optional()
});

// Agent and skill configs are validated against their full schemas by the
// chat-server workflow without coupling this transport package to config-schema.
export const configAssetConfigSchema = z.record(z.string(), z.unknown());

export const configAssetSchema = z.object({
  kind: configAssetKindSchema,
  name: z.string(),
  revision: z.number().int().positive(),
  config: configAssetConfigSchema,
  updatedAt: timestampSchema
});

export const configAssetRevisionSchema = z.object({
  revision: z.number().int().positive(),
  operation: z.enum(["create", "update", "delete", "revert"]),
  config: configAssetConfigSchema.nullable(),
  actor: auditActorSchema.nullable(),
  origin: z
    .object({ kind: z.literal("approval_request"), requestId: z.string(), summary: z.string() })
    .optional(),
  globalVersion: z.number().int().positive(),
  createdAt: timestampSchema
});

export const configAssetsOverviewSchema = z.object({
  version: z.number().int().nonnegative(),
  defaultAgentName: z.string().optional(),
  assets: z.array(configAssetSummarySchema),
  references: z.object({
    modelProviderIds: z.array(z.string()),
    modelBindingIds: z.array(z.string()),
    modelBindings: z.array(
      z.object({
        id: z.string(),
        model: z.string()
      })
    ),
    fastModeModelBindingIds: z.array(z.string()),
    reasoningEfforts: z.array(reasoningEffortSchema),
    enabledToolNames: z.array(z.string())
  })
});

export const configAssetBundleSchema = z.object({
  defaultAgentName: z.string().min(1).optional(),
  agents: z.array(configAssetConfigSchema),
  skills: z.array(configAssetConfigSchema)
});

export const exportConfigAssetsResponseSchema = configAssetBundleSchema.extend({
  version: z.number().int().nonnegative(),
  perAssetConcurrency: z.literal(true).optional(),
  revisions: z.record(z.string(), z.number().int().positive()).optional()
});

export const putConfigAssetRequestSchema = z.object({
  config: configAssetConfigSchema,
  baseVersion: z.number().int().nonnegative().optional()
});

export const putConfigAssetResponseSchema = z.object({
  version: z.number().int().positive(),
  revision: z.number().int().positive()
});

export const configAssetMutationVersionRequestSchema = z.object({
  baseVersion: z.number().int().nonnegative().optional()
});

export const configAssetMutationVersionResponseSchema = z.object({
  version: z.number().int().positive()
});

export const setDefaultConfigAgentRequestSchema = z.object({
  agentName: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative().optional()
});

export const revertConfigAssetRequestSchema = z.object({
  revision: z.number().int().positive(),
  baseVersion: z.number().int().nonnegative().optional()
});

export const replaceConfigAssetsRequestSchema = configAssetBundleSchema.extend({
  baseVersion: z.number().int().nonnegative().nullable(),
  mode: z.enum(["mirror", "merge"]).optional(),
  baseRevisions: z.record(z.string(), z.number().int().positive().nullable()).optional(),
  baseDefaultAgentName: z.string().nullable().optional(),
  deleteAssets: z.array(z.object({ kind: configAssetKindSchema, name: z.string() })).optional()
});

export const replaceConfigAssetsResponseSchema = configAssetMutationVersionResponseSchema.extend({
  // Agents written by this push that are not available in any workspace afterwards.
  hiddenAgentNames: z.array(z.string()).optional()
});

export const validateConfigAssetsResponseSchema = z.object({
  valid: z.literal(true)
});

export type ClientBranding = z.infer<typeof clientBrandingSchema>;
export type SafeConfig = z.infer<typeof safeConfigSchema>;
export type LocaleCode = z.infer<typeof localeCodeSchema>;
export type ConfigAssetKind = z.infer<typeof configAssetKindSchema>;
export type ConfigAssetSummary = z.infer<typeof configAssetSummarySchema>;
export type ConfigAsset = z.infer<typeof configAssetSchema>;
export type ConfigAssetRevision = z.infer<typeof configAssetRevisionSchema>;
export type ConfigAssetsOverview = z.infer<typeof configAssetsOverviewSchema>;
export type AgentAvailability = z.infer<typeof agentAvailabilitySchema>;
export type CollaborationWorkspaceAgents = z.infer<typeof collaborationWorkspaceAgentsSchema>;
export type AdministeredCollaborationWorkspace = z.infer<
  typeof administeredCollaborationWorkspaceSchema
>;
export type ConfigAssetBundle = z.infer<typeof configAssetBundleSchema>;

export type UserModelPreference = z.infer<typeof userModelPreferenceSchema>;
