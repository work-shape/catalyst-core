import type { ClientInstanceCapability } from "@vivd-catalyst/client-assembly";
import { defineProvider } from "@vivd-catalyst/core";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelCompletion
} from "@vivd-catalyst/model-provider";
import { z } from "zod";
import { deferred } from "./assertions";

/** The provider type an instance names in `infrastructure.models` to answer with the held model. */
export const HELD_MODEL_PROVIDER = "held-test";

const PIECES = ["A held ", "answer ", "in three pieces."] as const;
const answer: ModelCompletion = {
  text: PIECES.join(""),
  toolCalls: [],
  sources: [],
  citations: [],
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported",
    webSearchCallCount: 0
  }
};

/**
 * A model that streams the first piece of each answer and stops until the test releases it. A test that acts on a run in progress holds the
 * run with it, so the run cannot end before the test has acted.
 */
export function createHeldModel(): { capability: ClientInstanceCapability; release(): void } {
  const hold = deferred<void>();
  const provider = defineProvider({
    port: "models",
    type: HELD_MODEL_PROVIDER,
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: async () => answer,
        async *stream() {
          const [first, ...rest] = PIECES;
          yield { type: "text_delta", delta: first };
          await hold.promise;
          for (const delta of rest) yield { type: "text_delta", delta };
          yield { type: "completed", completion: answer };
        }
      });
    },
    describe() {
      return {};
    }
  });
  return {
    capability: { name: "held-model", providers: [provider], create: () => ({}) },
    release: () => hold.resolve()
  };
}
