import { z } from "zod";
import { defineProvider, secretRef } from "@vivd-catalyst/core";
import { OpenAiCompatibleChatProvider } from "../openai-compatible-provider";
import type { ModelProviderFactory } from "../types";

const openAiCompatibleConfigSchema = z.object({
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  credentialSecret: secretRef().default("OPENAI_API_KEY"),
  authMode: z.enum(["bearer", "api-key"]).default("bearer"),
  organizationSecret: secretRef().optional()
});

/** Any endpoint that speaks the OpenAI chat completions or responses wire format. */
export const openAiCompatibleModelProvider = defineProvider({
  port: "models",
  type: "openai-compatible",
  configSchema: openAiCompatibleConfigSchema,
  external: true,
  async create(config, { secrets }): Promise<ModelProviderFactory> {
    const apiKey = await secrets.resolve(config.credentialSecret);
    const organization = config.organizationSecret
      ? await secrets.resolve(config.organizationSecret)
      : undefined;
    return (provider) =>
      new OpenAiCompatibleChatProvider({
        id: provider.id,
        api: provider.api,
        model: provider.model,
        baseUrl: config.baseUrl,
        apiKey,
        authMode: config.authMode,
        organization,
        reasoningEffort: provider.reasoningEffort,
        contextManagement: provider.contextManagement
      });
  },
  describe(config) {
    return { endpointHost: new URL(config.baseUrl).host, authMode: config.authMode };
  }
});
