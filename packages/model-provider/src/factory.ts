import {
  createProvider,
  type ModelProviderConfig,
  type ProviderCreateContext
} from "@vivd-catalyst/core";
import { modelProviderDefinitions } from "./registration";
import { ModelProviderRegistry } from "./registry";

/**
 * Creates every model provider of an instance from its entries under `infrastructure.models`.
 * Each adapter resolves its secrets here, once, at startup.
 */
export async function createModelProviderRegistry(input: {
  providers: readonly ModelProviderConfig[];
  entries: Record<string, unknown>;
  context: ProviderCreateContext;
}): Promise<ModelProviderRegistry> {
  const providers = [];
  for (const provider of input.providers) {
    const build = await createProvider(
      modelProviderDefinitions,
      "models",
      { path: `infrastructure.models.${provider.id}`, entry: input.entries[provider.id] },
      input.context
    );
    providers.push(build(provider));
  }
  return new ModelProviderRegistry(providers);
}
