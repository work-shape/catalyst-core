import type { ModelProviderConfig, ProviderDefinition } from "@vivd-catalyst/core";
import { deterministicModelProvider } from "./adapters/deterministic";
import { openAiCompatibleModelProvider } from "./adapters/openai-compatible";
import type { ModelAdapterFactory } from "./types";

/** Every model adapter of this package. The only file that imports them. */
export const modelProviderDefinitions: readonly ProviderDefinition<
  "models",
  ModelAdapterFactory
>[] = [openAiCompatibleModelProvider, deterministicModelProvider];

/**
 * The entries whose calls nobody bills: those a deterministic provider answers inside the
 * process. Config validation asks no price of them, and admission reserves no cost for them.
 */
export function unbilledModelProviderIds(providers: readonly ModelProviderConfig[]): string[] {
  return providers
    .filter((provider) => provider.type === deterministicModelProvider.type)
    .map((provider) => provider.id);
}
