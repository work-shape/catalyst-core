import { vi } from "vitest";
import { createProvider } from "@vivd-catalyst/core";
import {
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelAdapterStreamEvent
} from "@vivd-catalyst/model-provider";
import { RECORDED_BEDROCK_PROFILE } from "./model-adapter-recordings";
import { silentTestLogger } from "./model-gateway";

/** What the tests of the Bedrock adapter share: an adapter with a test key and a scripted `fetch`. */

export const BEDROCK_TEST_ACCOUNT_ID = "123456789012";
export const hello: Pick<ModelAdapterRequest, "messages" | "tools"> = {
  messages: [{ role: "user", content: "Say hello." }],
  tools: []
};

export interface SentRequest {
  url: string;
  headers: Headers;
  body: unknown;
}

/** Replaces `fetch` by `answer` until `vi.unstubAllGlobals()`, and collects what was sent. */
export function answerWith(answer: (request: SentRequest) => Response): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request: SentRequest = {
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    };
    sent.push(request);
    return answer(request);
  });
  return sent;
}

export function message(
  content: unknown[],
  stopReason = "end_turn",
  usage: Record<string, number> = { input_tokens: 8, output_tokens: 5 }
): Record<string, unknown> {
  return { type: "message", role: "assistant", content, stop_reason: stopReason, usage };
}

export async function bedrockFactory(
  settings: Record<string, unknown> = {}
): Promise<ModelAdapterFactory> {
  return createProvider<"models", ModelAdapterFactory>(
    modelProviderDefinitions,
    "models",
    {
      path: "infrastructure.models.bedrock",
      entry: {
        provider: "aws-bedrock",
        region: "eu",
        model: RECORDED_BEDROCK_PROFILE,
        credentialSecret: "TEST_BEDROCK_KEY",
        ...settings
      }
    },
    { secrets: { resolve: async () => "test-bedrock-key" }, logger: silentTestLogger }
  );
}

export async function bedrock(): Promise<ModelAdapter> {
  return (await bedrockFactory())({
    id: "bedrock",
    type: "aws-bedrock",
    region: "eu",
    model: RECORDED_BEDROCK_PROFILE
  });
}

export async function collect(
  stream: AsyncIterable<ModelAdapterStreamEvent>
): Promise<ModelAdapterStreamEvent[]> {
  const events: ModelAdapterStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal");
}
