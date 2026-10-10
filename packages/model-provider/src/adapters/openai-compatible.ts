import { z } from "zod";
import {
  defineProvider,
  providerCheckResultOfStatus,
  secretRef,
  type ProviderCheckContext,
  type ProviderCheckResult
} from "@vivd-catalyst/core";
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

/**
 * The check of an endpoint: its list of models, which is authenticated, generates nothing and
 * costs nothing. The answer's body is not read.
 */
async function listModels(
  endpoint: {
    baseUrl: string;
    apiKey: string;
    authMode: "bearer" | "api-key";
    organization: string | undefined;
  },
  { signal }: ProviderCheckContext
): Promise<ProviderCheckResult> {
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl.replace(/\/$/u, "")}/models`, {
      headers: {
        ...(endpoint.authMode === "api-key"
          ? { "api-key": endpoint.apiKey }
          : { authorization: `Bearer ${endpoint.apiKey}` }),
        ...(endpoint.organization ? { "openai-organization": endpoint.organization } : {})
      },
      signal
    });
  } catch {
    return { ok: false, errorClass: "unreachable" };
  }
  await response.body?.cancel().catch(() => undefined);
  return providerCheckResultOfStatus(response.status);
}

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
    const build: ModelAdapterFactory = (entry) => {
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
    build.check = (context) => listModels({ ...config, apiKey, organization }, context);
    return build;
  },
  async check(build, context) {
    return (await build.check?.(context)) ?? { ok: true };
  },
  describe(config) {
    return { endpointHost: new URL(config.baseUrl).host, authMode: config.authMode };
  }
});
