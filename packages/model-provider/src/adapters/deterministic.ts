import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import { DeterministicModelProvider } from "../deterministic-provider";
import type { ModelProviderFactory } from "../types";

/** Answers from fixed rules inside the process. For development, tests and the demo. */
export const deterministicModelProvider = defineProvider({
  port: "models",
  type: "deterministic",
  configSchema: z.object({}),
  external: false,
  create(): ModelProviderFactory {
    return (provider) => new DeterministicModelProvider(provider.id);
  },
  describe() {
    return {};
  }
});
