import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@vivd-stage/core";
import {
  DeterministicModelProvider,
  ModelProviderRegistry,
  OpenAiCompatibleChatProvider,
  type ModelCompletionStreamEvent
} from "@vivd-stage/model-provider";

describe("OpenAI-compatible model provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips provider tool names without dot/underscore collisions", async () => {
    let requestBody: {
      tools: Array<{ function: { name: string; description: string } }>;
    } | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const secondToolName = requestBody?.tools.find(
        (tool) => tool.function.description === "second"
      )?.function.name;

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: secondToolName,
                      arguments: "{}"
                    }
                  }
                ]
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const clientInstanceId = asClientInstanceId("client-test");
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      model: "gpt-test",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });
    const completion = await provider.complete(
      {
        providerId: "openai",
        model: "gpt-test",
        messages: [{ role: "user", content: "run a tool" }],
        tools: [
          { name: "a.b", description: "first" },
          { name: "a__dot__b", description: "second" }
        ]
      },
      {
        clientInstanceId,
        correlationId: "corr-test",
        user: {
          id: "user-test",
          externalUserId: "user-test",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      }
    );

    const providerToolNames = requestBody?.tools.map((tool) => tool.function.name) ?? [];
    expect(new Set(providerToolNames).size).toBe(2);
    expect(completion.toolCalls[0]?.toolName).toBe("a__dot__b");
    expect(completion.usage).toMatchObject({
      totalTokens: 12,
      source: "provider_reported"
    });
  });

  it("streams OpenAI-compatible text deltas and final usage", async () => {
    let requestBody: { stream?: boolean; stream_options?: { include_usage?: boolean } } | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        createSseStream([
          {
            choices: [
              {
                delta: {
                  content: "Hello"
                }
              }
            ]
          },
          {
            choices: [
              {
                delta: {
                  content: " world"
                }
              }
            ]
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 2,
              total_tokens: 5
            }
          }
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const clientInstanceId = asClientInstanceId("client-test");
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      model: "gpt-test",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });

    const events: ModelCompletionStreamEvent[] = [];
    for await (const event of provider.stream?.(
      {
        providerId: "openai",
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
        tools: []
      },
      {
        clientInstanceId,
        correlationId: "corr-test",
        user: {
          id: "user-test",
          externalUserId: "user-test",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      }
    ) ?? []) {
      events.push(event);
    }

    expect(requestBody).toMatchObject({
      stream: true,
      stream_options: {
        include_usage: true
      }
    });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      "Hello",
      " world"
    ]);
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.completion).toMatchObject({
      text: "Hello world",
      usage: {
        totalTokens: 5,
        source: "provider_reported"
      }
    });
  });

  it("delegates streaming through the provider registry", async () => {
    const clientInstanceId = asClientInstanceId("client-test");
    const registry = new ModelProviderRegistry([new DeterministicModelProvider("local")]);

    const events: ModelCompletionStreamEvent[] = [];
    for await (const event of registry.stream(
      {
        providerId: "local",
        model: "deterministic-local",
        messages: [{ role: "user", content: "hello" }],
        tools: []
      },
      {
        clientInstanceId,
        correlationId: "corr-test",
        user: {
          id: "user-test",
          externalUserId: "user-test",
          displayLabel: "User",
          roles: ["user"],
          permissionRefs: [],
          clientInstanceId,
          authSource: "test"
        }
      }
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });
});

function createSseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
