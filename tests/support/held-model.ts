import type { ClientInstanceCapability } from "@work-shape/catalyst-client-assembly";
import { createPlatformId, defineProvider } from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  modelContentText,
  parseToolInput,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelCompletion
} from "@work-shape/catalyst-model-provider";
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
    // It runs in the test's own process: there is nothing to reach.
    check: async () => ({ ok: true }),
    describe() {
      return {};
    }
  });
  return {
    capability: { name: "held-model", providers: [provider], create: () => ({}) },
    release: () => hold.resolve()
  };
}

/** The provider type an instance names to answer with the tool-calling model. */
export const TOOL_CALLING_MODEL_PROVIDER = "tool-calling-test";

/**
 * A model that makes every call the person's message lists, one `/tool <name> <json>` per
 * line, in one step, and answers with what the calls returned once their results follow the
 * message. Unlike the deterministic model, one step can hold several calls.
 */
export function createToolCallingModel(): {
  capability: ClientInstanceCapability;
  /** What the model was given each time it was asked, in order. */
  requests: ModelAdapterRequest[];
} {
  const requests: ModelAdapterRequest[] = [];
  const answerTo = (request: ModelAdapterRequest): ModelCompletion => {
    requests.push(request);
    const lastUser = request.messages.findLastIndex((message) => message.role === "user");
    const results = request.messages
      .slice(lastUser + 1)
      .filter((message) => message.role === "tool")
      .map((message) => modelContentText(message.content));
    if (results.length > 0) {
      return { ...answer, text: `Tool work completed:\n\n${results.join("\n\n")}` };
    }
    const said = modelContentText(request.messages[lastUser]?.content ?? "");
    const toolCalls = said.split("\n").flatMap((line) => {
      const [, toolName, json = "{}"] = line.trim().match(/^\/tool\s+(\S+)\s*(.*)$/u) ?? [];
      return toolName
        ? [{ toolCallId: createPlatformId("toolcall"), toolName, ...parseToolInput(json) }]
        : [];
    });
    return toolCalls.length > 0
      ? { ...answer, text: "", toolCalls }
      : { ...answer, text: `I received: ${said}` };
  };
  const provider = defineProvider({
    port: "models",
    type: TOOL_CALLING_MODEL_PROVIDER,
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete: async (request) => answerTo(request),
        async *stream(request) {
          const completion = answerTo(request);
          if (completion.text) yield { type: "text_delta", delta: completion.text };
          yield { type: "completed", completion };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe() {
      return {};
    }
  });
  return {
    capability: { name: "tool-calling-model", providers: [provider], create: () => ({}) },
    requests
  };
}
