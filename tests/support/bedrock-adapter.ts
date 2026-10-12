import { vi } from "vitest";
import { asClientInstanceId, createProvider } from "@vivd-catalyst/core";
import {
  createModelGateway,
  modelProviderDefinitions,
  type ModelCall,
  type ModelGateway,
  type ModelAdapter,
  type ModelAdapterFactory,
  type ModelAdapterRequest,
  type ModelAdapterStreamEvent
} from "@vivd-catalyst/model-provider";
import { RECORDED_BEDROCK_PROFILE } from "./model-adapter-recordings";
import { createRecordingGovernance, silentTestLogger } from "./model-gateway";

/** What the tests of the Bedrock adapter share: an adapter with a test key and a scripted `fetch`. */

/** The account of `RECORDED_BEDROCK_PROFILE`, which the test entry states as its own. */
export const BEDROCK_TEST_ACCOUNT_ID = "000000000000";
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
        accountId: BEDROCK_TEST_ACCOUNT_ID,
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

/** A refusal as Bedrock answers it: the exception in a header, its words in the body. */
export function bedrockRefusal(
  status: number,
  type: string,
  body: string | Record<string, string>,
  headers: Record<string, string> = {}
): Response {
  return Response.json(typeof body === "string" ? { message: body } : body, {
    status,
    headers: {
      "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
      "x-amzn-requestid": "0f8fad5b-d9cb-469f-a165-70867728950e",
      ...headers
    }
  });
}

/** A streamed answer of the given bytes. With `staysOpen` it never ends by itself. */
export function bedrockEventStream(
  pieces: Uint8Array[],
  options: { staysOpen?: boolean; onCancel?: () => void } = {}
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        if (!options.staysOpen) controller.close();
      },
      cancel() {
        options.onCancel?.();
      }
    }),
    { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } }
  );
}

/**
 * The adapter behind the gateway, called by the binding `claude`: what a test needs to see how
 * often a call is sent and what a log line holds.
 */
export async function bedrockGateway(): Promise<{
  gateway: ModelGateway;
  warnings: Record<string, unknown>[];
  call: ModelCall;
}> {
  const warnings: Record<string, unknown>[] = [];
  const provider = {
    id: "bedrock",
    type: "aws-bedrock",
    region: "eu" as const,
    model: RECORDED_BEDROCK_PROFILE
  };
  return {
    warnings,
    gateway: createModelGateway({
      providers: [provider],
      bindings: [{ id: "claude", providerId: "bedrock", model: RECORDED_BEDROCK_PROFILE }],
      adapters: new Map([["bedrock", await bedrock()]]),
      governance: createRecordingGovernance(),
      logger: {
        ...silentTestLogger,
        warn(input: unknown) {
          if (typeof input === "object" && input !== null) warnings.push({ ...input });
        }
      }
    }),
    call: {
      binding: { bindingId: "claude" },
      ...hello,
      attribution: { kind: "system", purpose: "document_extraction" },
      clientInstanceId: asClientInstanceId("client-bedrock-adapter"),
      correlationId: "bedrock-adapter"
    }
  };
}
