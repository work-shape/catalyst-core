import type {
  ModelProviderConfig,
  ProviderCreateContext,
  ProviderRegistry
} from "@vivd-catalyst/core";
import { ModelProviderRegistry } from "./registry";

/**
 * Creates every model provider of an instance from its entries under `infrastructure.models`.
 * Each adapter resolves its secrets here, once, at startup. The providers come from the
 * instance's registry, so one that a capability registers is created like a built-in one.
 */
export async function createModelProviderRegistry(input: {
  registry: ProviderRegistry;
  providers: readonly ModelProviderConfig[];
  entries: Record<string, unknown>;
  context: ProviderCreateContext;
}): Promise<ModelProviderRegistry> {
  const providers = [];
  for (const provider of input.providers) {
    const build = await input.registry.create(
      "models",
      { path: `infrastructure.models.${provider.id}`, entry: input.entries[provider.id] },
      input.context
    );
    providers.push(build(provider));
  }
  return new ModelProviderRegistry(providers);
}
