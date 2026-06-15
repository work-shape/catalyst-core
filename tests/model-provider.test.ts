import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, asClientInstanceId } from "@vivd-catalyst/core";
import {
  DeterministicModelProvider,
  ModelProviderRegistry,
  OpenAiCompatibleChatProvider,
  type ModelCompletionStreamEvent
} from "@vivd-catalyst/model-provider";

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

  it("passes configured reasoning effort to OpenAI-compatible requests", async () => {
    let requestBody: { reasoning_effort?: string } | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "done"
              }
            }
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6
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
      model: "gpt-5.5",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      reasoningEffort: "high"
    });
    await provider.complete(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "solve this" }],
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
    );

    expect(requestBody).toMatchObject({
      reasoning_effort: "high"
    });
  });

  it("maps provider-neutral requests to the OpenAI Responses API", async () => {
    let requestUrl: string | undefined;
    let requestBody:
      | {
          input?: Array<Record<string, unknown>>;
          reasoning?: { effort?: string };
          store?: boolean;
          tools?: Array<{ name: string; type: string; strict?: boolean }>;
        }
      | undefined;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      const toolName = requestBody?.tools?.[0]?.name;

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "I'll render that."
                }
              ]
            },
            {
              type: "function_call",
              call_id: "call_render",
              name: toolName,
              arguments: "{\"html\":\"<p>Hello</p>\"}"
            }
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16
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
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      reasoningEffort: "high"
    });
    const completion = await provider.complete(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "visualize this" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "call_previous", toolName: "show_view", input: { html: "" } }]
          },
          { role: "tool", toolCallId: "call_previous", content: "{\"status\":\"displayed\"}" }
        ],
        tools: [{ name: "show_view", description: "Show view" }]
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

    expect(requestUrl).toBe("https://example.test/v1/responses");
    expect(requestBody).toMatchObject({
      reasoning: { effort: "high" },
      store: false,
      tools: [{ type: "function", strict: false }]
    });
    expect(requestBody?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "visualize this" }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_previous",
          arguments: "{\"html\":\"\"}"
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_previous",
          output: "{\"status\":\"displayed\"}"
        })
      ])
    );
    expect(completion).toMatchObject({
      text: "I'll render that.",
      toolCalls: [
        {
          toolCallId: "call_render",
          toolName: "show_view",
          input: { html: "<p>Hello</p>" }
        }
      ],
      usage: {
        totalTokens: 16,
        source: "provider_reported"
      }
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

  it("streams OpenAI Responses text deltas, tool calls, and final usage", async () => {
    let requestBody:
      | { stream?: boolean; reasoning?: { effort?: string }; tools?: Array<{ name: string }> }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const toolName = requestBody?.tools?.[0]?.name;
      return new Response(
        createSseStream([
          {
            type: "response.output_text.delta",
            delta: "Hello"
          },
          {
            type: "response.output_text.delta",
            delta: " world"
          },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: toolName,
              arguments: "{\"html\":\"<p>Hello</p>\"}"
            }
          },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 7,
                output_tokens: 3,
                total_tokens: 10
              }
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
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://example.test/v1",
      apiKey: "test",
      reasoningEffort: "high"
    });

    const events: ModelCompletionStreamEvent[] = [];
    for await (const event of provider.stream?.(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ name: "show_view", description: "Show view" }]
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
      reasoning: {
        effort: "high"
      }
    });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      "Hello",
      " world"
    ]);
    const completed = events.find((event) => event.type === "completed");
    expect(completed?.completion).toMatchObject({
      text: "Hello world",
      toolCalls: [
        {
          toolCallId: "call_1",
          toolName: "show_view",
          input: { html: "<p>Hello</p>" }
        }
      ],
      usage: {
        totalTokens: 10,
        source: "provider_reported"
      }
    });
  });

  it("surfaces provider error bodies from stream requests", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: reasoning_effort",
            type: "invalid_request_error"
          }
        }),
        {
          status: 400,
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

    let thrown: unknown;
    try {
      for await (const _event of provider.stream(
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
      )) {
        // Consume the stream until the provider surfaces the non-OK response.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining("Unsupported parameter: reasoning_effort"),
      details: {
        providerId: "openai",
        status: 400,
        providerError: expect.stringContaining("Unsupported parameter: reasoning_effort")
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
