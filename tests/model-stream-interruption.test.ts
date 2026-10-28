import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  ProviderRegistry
} from "@work-shape/catalyst-core";
import {
  createInstanceModelGateway,
  modelProviderDefinitions,
  ModelProviderError,
  type ModelCallStreamEvent
} from "@work-shape/catalyst-model-provider";
import { createFailingTestLogger, createFakeSecrets } from "./support/fixtures";
import { createRecordingGovernance } from "./support/model-gateway";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(["responses", "chat_completions"] as const)("%s interrupted streams", (api) => {
  it("retries streams without a completion marker before any output and returns one answer", async () => {
    vi.useFakeTimers();
    const f = await fixture(api, (attempt) => (attempt < 3 ? sse([]) : successfulResponse(api)));
    const pending = collect(f.stream());
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await pending).map((event) => event.type)).toEqual(["text_delta", "completed"]);
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.settled).toBe(1);
  });

  it("fails as a typed timeout after the existing three attempts are exhausted", async () => {
    vi.useFakeTimers();
    const f = await fixture(api, () => sse([]));
    const pending = collect(f.stream()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    const error = await pending;
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: "TIMEOUT", kind: "timeout", retryable: true });
    expect(f.fetchMock).toHaveBeenCalledTimes(3);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.settled).toBe(1);
  });

  it("preserves visible text and never replays a stream that ends without its completion marker", async () => {
    const f = await fixture(api, () => sse([textDelta(api)]));
    const seen: ModelCallStreamEvent[] = [];
    const pending = (async () => {
      for await (const event of f.stream()) seen.push(event);
    })();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", kind: "timeout" });
    expect(seen).toEqual([{ type: "text_delta", delta: "Hello" }]);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.governance.settled).toBe(1);
    expect(f.governance.recorded[0]?.outputTokens).toBeGreaterThan(0);
  });
});

it.each([
  { type: "response.reasoning_summary_text.delta", item_id: "reason_1", delta: "Thinking" },
  { type: "response.output_item.added", item: { id: "search_1", type: "web_search_call" } }
])("does not replay Responses after visible $type", async (event) => {
  const f = await fixture("responses", () => sse([event]));
  const seen: ModelCallStreamEvent[] = [];
  await expect(
    (async () => {
      for await (const output of f.stream()) seen.push(output);
    })()
  ).rejects.toMatchObject({ code: "TIMEOUT" });
  expect(seen).toHaveLength(1);
  expect(f.fetchMock).toHaveBeenCalledTimes(1);
});

async function fixture(
  api: "responses" | "chat_completions",
  respond: (attempt: number) => Response
) {
  let attempts = 0;
  const fetchMock = vi.fn(async () => respond(++attempts));
  vi.stubGlobal("fetch", fetchMock);
  const governance = createRecordingGovernance();
  const gateway = await createInstanceModelGateway({
    registry: new ProviderRegistry(modelProviderDefinitions),
    providers: [{ id: "main", type: "openai-compatible", model: "test-model", api }],
    entries: {
      main: {
        provider: "openai-compatible",
        model: "test-model",
        baseUrl: "https://models.example.test/v1",
        credentialSecret: "MODEL_KEY"
      }
    },
    context: {
      logger: createFailingTestLogger("Unexpected provider error log"),
      secrets: createFakeSecrets({ MODEL_KEY: "test-key" })
    },
    bindings: [],
    governance
  });
  return {
    fetchMock,
    governance,
    stream: () =>
      gateway.stream({
        binding: { providerId: "main" },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        attribution: {
          kind: "agent_run",
          conversationId: asConversationId("conv_interrupted"),
          runId: asAgentRunId("run_interrupted"),
          agentName: "assistant",
          userId: "user-1"
        },
        clientInstanceId: asClientInstanceId("stream-test"),
        correlationId: "corr-interrupted"
      })
  };
}

function textDelta(api: "responses" | "chat_completions") {
  return api === "responses"
    ? { type: "response.output_text.delta", delta: "Hello" }
    : { choices: [{ delta: { content: "Hello" } }] };
}

function successfulResponse(api: "responses" | "chat_completions") {
  return sse([
    textDelta(api),
    ...(api === "responses"
      ? [
          {
            type: "response.completed",
            response: { output: [], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }
          }
        ]
      : ["[DONE]"])
  ]);
}

function sse(events: unknown[]) {
  return new Response(
    events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

async function collect(stream: AsyncIterable<ModelCallStreamEvent>) {
  const events: ModelCallStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
