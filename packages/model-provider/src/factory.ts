import type {
  ModelBindingConfig,
  ModelProviderConfig,
  ProviderCreateContext,
  ProviderRegistry
} from "@vivd-catalyst/core";
import { createModelGateway, type ModelCallGovernance, type ModelGateway } from "./gateway";
import type { ModelAdapter } from "./types";

/**
 * Creates the model gateway of an instance from its entries under `infrastructure.models`.
 * Each adapter resolves its secrets here, once, at startup. The adapters come from the
 * instance's registry, so one that a capability registers is created like a built-in one.
 */
export async function createInstanceModelGateway(input: {
  registry: ProviderRegistry;
  providers: readonly ModelProviderConfig[];
  entries: Record<string, unknown>;
  context: ProviderCreateContext;
  bindings: readonly ModelBindingConfig[];
  governance: ModelCallGovernance;
}): Promise<ModelGateway> {
  const adapters = new Map<string, ModelAdapter>();
  for (const provider of input.providers) {
    const build = await input.registry.create(
      "models",
      { path: `infrastructure.models.${provider.id}`, entry: input.entries[provider.id] },
      input.context
    );
    adapters.set(provider.id, build(provider));
  }
  return createModelGateway({
    providers: input.providers,
    bindings: input.bindings,
    adapters,
    governance: input.governance,
    logger: input.context.logger
  });
}
