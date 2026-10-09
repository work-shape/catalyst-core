import { z } from "zod";
import { defineProvider, secretRef } from "@vivd-catalyst/core";
import {
  OpenAiCompatibleChatProvider,
  openAiCompatibleCapabilities
} from "../openai-compatible-provider";
import type { ModelAdapterFactory, ModelAdapterRequest, ModelCompletionRequest } from "../types";

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
  async create(config, { secrets }): Promise<ModelAdapterFactory> {
    const apiKey = await secrets.resolve(config.credentialSecret);
    const organization = config.organizationSecret
      ? await secrets.resolve(config.organizationSecret)
      : undefined;
    return (entry) => {
      const provider = new OpenAiCompatibleChatProvider({
        id: entry.id,
        api: entry.api,
        model: entry.model,
        baseUrl: config.baseUrl,
        apiKey,
        authMode: config.authMode,
        organization,
        reasoningEffort: entry.reasoningEffort,
        contextManagement: entry.contextManagement
      });
      const capabilities = openAiCompatibleCapabilities(entry);
      const toRequest = (request: ModelAdapterRequest): ModelCompletionRequest => ({
        providerId: entry.id,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        fastMode: request.fastTier,
        continuation: request.continuation,
        messages: request.messages,
        tools: request.tools
      });
      return {
        capabilities: () => capabilities,
        complete: (request) => provider.complete(toRequest(request), request),
        stream: (request) => provider.stream(toRequest(request), request)
      };
    };
  },
  describe(config) {
    return { endpointHost: new URL(config.baseUrl).host, authMode: config.authMode };
  }
});
