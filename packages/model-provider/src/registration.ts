import type { ProviderDefinition } from "@vivd-catalyst/core";
import { deterministicModelProvider } from "./adapters/deterministic";
import { openAiCompatibleModelProvider } from "./adapters/openai-compatible";
import type { ModelProviderFactory } from "./types";

/** Every model adapter of this package. The only file that imports them. */
export const modelProviderDefinitions: readonly ProviderDefinition<
  "models",
  ModelProviderFactory
>[] = [openAiCompatibleModelProvider, deterministicModelProvider];
