import { z } from "zod";
import type {
  AgentConfig,
  ModelProviderConfig,
  UsageBudgetConfig,
  UsagePricingConfig,
  UsageSafeguardsConfig
} from "@agent-chat-platform/core";

export const userIdentitySchema = z.object({
  id: z.string().min(1).default("dev-user"),
  externalUserId: z.string().min(1).default("dev-user"),
  displayLabel: z.string().min(1).default("Development User"),
  email: z.string().email().optional(),
  emailVerified: z.boolean().optional(),
  roles: z.array(z.string().min(1)).default(["user", "admin"]),
  permissionRefs: z.array(z.string().min(1)).default(["demo-tools"]),
  authSource: z.string().min(1).default("development")
});

const defaultDevelopmentUser = {
  id: "dev-user",
  externalUserId: "dev-user",
  displayLabel: "Development User",
  roles: ["user", "admin"],
  permissionRefs: ["demo-tools"],
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
  passwordEnvName: z.string().min(1),
  developmentPassword: z.string().min(8).optional(),
  roles: z.array(z.string().min(1)).default(["user"]),
  permissionRefs: z.array(z.string().min(1)).default([])
});

const standaloneAuthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().optional(),
  trustedOrigins: z.array(z.string().url()).default([]),
  seedUsers: z.array(standaloneSeedUserSchema).default([])
});

const deterministicModelProviderSchema = z.object({
  id: z.string().min(1),
  type: z.literal("deterministic"),
  model: z.string().min(1).default("deterministic-local")
});

const openAiCompatibleModelProviderSchema = z.object({
  id: z.string().min(1),
  type: z.literal("openai-compatible"),
  model: z.string().min(1),
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  apiKeyEnvName: z.string().min(1).default("OPENAI_API_KEY"),
  organizationEnvName: z.string().min(1).optional()
});

export const modelProviderConfigSchema = z.discriminatedUnion("type", [
  deterministicModelProviderSchema,
  openAiCompatibleModelProviderSchema
]);

export const agentConfigSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  instructions: z.string().min(1),
  modelProviderId: z.string().min(1).optional(),
  toolNames: z.array(z.string().min(1)).default([]),
  initialPrompts: z
    .array(
      z.object({
        title: z.string().min(1),
        prompt: z.string().min(1)
      })
    )
    .default([])
});

export const usageBudgetConfigSchema = z
  .object({
    monthlySpendLimit: z.number().positive().optional(),
    costSafetyMultiplier: z.number().min(1).default(1)
  })
  .default({
    costSafetyMultiplier: 1
  });

export const usageSafeguardsConfigSchema = z
  .object({
    modelCallsPerDay: z.number().int().positive().optional(),
    tokensPerDay: z.number().int().positive().optional(),
    tokensPerMonth: z.number().int().positive().optional()
  })
  .default({});

export const usagePricingConfigSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/u).default("USD"),
    models: z
      .array(
        z.object({
          providerId: z.string().min(1),
          model: z.string().min(1),
          inputPricePerMillionTokens: z.number().nonnegative(),
          outputPricePerMillionTokens: z.number().nonnegative()
        })
      )
      .default([])
  })
  .default({
    currency: "USD",
    models: []
  });

export const conversationTitleConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    modelProviderId: z.string().min(1).optional(),
    model: z.string().min(1).optional()
  })
  .default({
    enabled: true
  });

const uiThemeSchema = z
  .object({
    accentColor: z.string().min(1).default("#0f766e"),
    accentStrongColor: z.string().min(1).default("#0b5f59"),
    backgroundColor: z.string().min(1).default("#f5f3ee"),
    surfaceColor: z.string().min(1).default("#fffdfa"),
    textColor: z.string().min(1).default("#17201d"),
    mutedTextColor: z.string().min(1).default("#6b746f"),
    borderColor: z.string().min(1).default("#d8d3c7")
  })
  .default({
    accentColor: "#0f766e",
    accentStrongColor: "#0b5f59",
    backgroundColor: "#f5f3ee",
    surfaceColor: "#fffdfa",
    textColor: "#17201d",
    mutedTextColor: "#6b746f",
    borderColor: "#d8d3c7"
  });

export const clientInstanceConfigSchema = z.object({
  version: z.literal(1).default(1),
  clientInstance: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    environment: z.enum(["development", "production"]).default("development")
  }),
  auth: z
    .object({
      standalone: z
        .object(standaloneAuthConfigSchema.shape)
        .optional(),
      development: z
        .object(developmentAuthConfigSchema.shape)
        .optional(),
      sessionToken: z
        .object({
          issuer: z.string().min(1).default("agent-chat-platform"),
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
      auditDays: z.number().int().positive().max(3650).default(365),
      allowUserDelete: z.boolean().default(true)
    })
    .default({
      conversationDays: 30,
      auditDays: 365,
      allowUserDelete: true
    }),
  modelProviders: z
    .array(modelProviderConfigSchema)
    .min(1)
    .default([{ id: "local", type: "deterministic", model: "deterministic-local" }]),
  conversationTitles: conversationTitleConfigSchema,
  usage: z
    .object({
      budget: usageBudgetConfigSchema,
      safeguards: usageSafeguardsConfigSchema,
      pricing: usagePricingConfigSchema
    })
    .default({
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: []
      }
    }),
  defaultAgentName: z.string().min(1),
  agents: z.array(agentConfigSchema).min(1),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        enabled: z.boolean().default(true)
      })
    )
    .default([]),
  ui: z
    .object({
      clientName: z.string().min(1).optional(),
      logoUrl: z.string().url().optional(),
      title: z.string().min(1).default("Agent Chat"),
      welcomeMessage: z.string().min(1).default("How can I help?"),
      accentColor: z.string().min(1).default("#0f766e"),
      theme: uiThemeSchema
    })
    .default({
      title: "Agent Chat",
      welcomeMessage: "How can I help?",
      accentColor: "#0f766e",
      theme: {
        accentColor: "#0f766e",
        accentStrongColor: "#0b5f59",
        backgroundColor: "#f5f3ee",
        surfaceColor: "#fffdfa",
        textColor: "#17201d",
        mutedTextColor: "#6b746f",
        borderColor: "#d8d3c7"
      }
    })
});

export const clientInstanceConfigFileSchema = clientInstanceConfigSchema
  .omit({
    agents: true
  })
  .extend({
    agents: z.array(agentConfigSchema).default([]),
    agentFiles: z.array(z.string().min(1)).default([])
  });

export type UserIdentityConfig = z.infer<typeof userIdentitySchema>;
export type StandaloneSeedUserConfig = z.infer<typeof standaloneSeedUserSchema>;
export type {
  AgentConfig,
  ModelProviderConfig,
  UsageBudgetConfig,
  UsagePricingConfig,
  UsageSafeguardsConfig
};
export type ClientInstanceConfig = z.infer<typeof clientInstanceConfigSchema>;
