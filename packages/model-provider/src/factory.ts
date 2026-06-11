import { AppError, type ModelProviderConfig } from "@vivd-stage/core";
import { DeterministicModelProvider } from "./deterministic-provider";
import { OpenAiCompatibleChatProvider } from "./openai-compatible-provider";
import { ModelProviderRegistry } from "./registry";

export function createModelProviderRegistry(input: {
  configs: ModelProviderConfig[];
  env: Record<string, string | undefined>;
}): ModelProviderRegistry {
  return new ModelProviderRegistry(
    input.configs.map((config) => {
      if (config.type === "deterministic") {
        return new DeterministicModelProvider(config.id);
      }

      const apiKey = input.env[config.apiKeyEnvName];
      if (!apiKey) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Missing API key environment variable '${config.apiKeyEnvName}' for model provider '${config.id}'`
        );
      }

      return new OpenAiCompatibleChatProvider({
        id: config.id,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey,
        organization: config.organizationEnvName ? input.env[config.organizationEnvName] : undefined
      });
    })
  );
}
