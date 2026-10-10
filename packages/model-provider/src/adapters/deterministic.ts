import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import { DETERMINISTIC_CAPABILITIES, DeterministicModelProvider } from "../deterministic-provider";
import type { ModelAdapterFactory, ModelAdapterRequest } from "../types";

/** Answers from fixed rules inside the process. For development, tests and the demo. */
export const deterministicModelProvider = defineProvider({
  port: "models",
  type: "deterministic",
  configSchema: z.object({}),
  external: false,
  create(): ModelAdapterFactory {
    return (entry) => {
      const provider = new DeterministicModelProvider(entry.id);
      const toRequest = (request: ModelAdapterRequest) => ({
        providerId: entry.id,
        model: request.model,
        messages: request.messages,
        tools: request.tools
      });
      return {
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: (request) => provider.complete(toRequest(request)),
        stream: (request) => provider.stream(toRequest(request))
      };
    };
  },
  // It answers inside the process: there is nothing to reach.
  async check() {
    return { ok: true };
  },
  describe() {
    return {};
  }
});
