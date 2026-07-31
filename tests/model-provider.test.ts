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
            prompt_tokens_details: {
              cached_tokens: 8
            },
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
      cachedInputTokens: 8,
      totalTokens: 12,
      source: "provider_reported"
    });
  });

  it("returns malformed tool arguments as a recoverable parse error", async () => {
    let requestBody: {
      tools: Array<{ function: { name: string; description: string } }>;
    } | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const toolName = requestBody?.tools[0]?.function.name;

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_bad_json",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: "{\"city\":"
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
          {
            name: "weather.lookup",
            description: "Lookup weather"
          }
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

    expect(completion.toolCalls).toEqual([
      {
        toolCallId: "call_bad_json",
        toolName: "weather.lookup",
        input: {},
        inputParseError: {
          code: "invalid_json",
          message: "Tool input must be valid JSON",
          rawInput: "{\"city\":"
        }
      }
    ]);
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

  it("preserves explicit none reasoning effort for both OpenAI-compatible APIs", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return String(url).endsWith("/responses")
        ? new Response(JSON.stringify({ output_text: "done" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        : new Response(
            JSON.stringify({
              choices: [{ message: { content: "done" } }]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = createModelProviderTestContext();
    for (const api of [undefined, "responses"] as const) {
      const provider = new OpenAiCompatibleChatProvider({
        id: "openai",
        api,
        model: "gpt-5.6-sol",
        baseUrl: "https://example.test/v1",
        apiKey: "test",
        reasoningEffort: "high"
      });
      await provider.complete(
        {
          providerId: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "none",
          messages: [{ role: "user", content: "answer directly" }],
          tools: []
        },
        context
      );
    }

    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "none" });
    expect(requestBodies[1]).toMatchObject({
      reasoning: { effort: "none" }
    });
    expect(requestBodies[1]?.reasoning).not.toHaveProperty("summary");
  });

  it("maps provider-neutral requests to the OpenAI Responses API", async () => {
    let requestUrl: string | undefined;
    let requestBody:
      | {
          input?: Array<Record<string, unknown>>;
          reasoning?: { effort?: string; summary?: string };
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
            input_tokens_details: {
              cached_tokens: 8
            },
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
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
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
        cachedInputTokens: 8,
        totalTokens: 16,
        source: "provider_reported"
      }
    });
  });

  it("round-trips encrypted Responses reasoning through a stateless tool loop", async () => {
    const requestBodies: Array<{
      input?: Array<Record<string, unknown>>;
      include?: string[];
    }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "reasoning",
                id: "rs_1",
                summary: [],
                encrypted_content: "encrypted-reasoning"
              },
              {
                type: "function_call",
                call_id: "call_lookup",
                name: "lookup",
                arguments: "{\"id\":42}"
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new Response(JSON.stringify({ output_text: "The result is ready." }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleChatProvider({
      id: "azure-eu",
      api: "responses",
      model: "gpt-5.6-sol",
      baseUrl: "https://example.test/openai/v1",
      apiKey: "test",
      reasoningEffort: "high"
    });
    const context = createModelProviderTestContext();
    const first = await provider.complete(
      {
        providerId: "azure-eu",
        model: "gpt-5.6-sol",
        messages: [{ role: "user", content: "look this up" }],
        tools: [{ name: "lookup", description: "Look up a record" }]
      },
      context
    );
    await provider.complete(
      {
        providerId: "azure-eu",
        model: "gpt-5.6-sol",
        continuation: first.continuation,
        messages: [
          { role: "user", content: "look this up" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                toolCallId: "call_lookup",
                toolName: "lookup",
                input: { id: 42 }
              }
            ]
          },
          {
            role: "tool",
            toolCallId: "call_lookup",
            content: "{\"name\":\"Record\"}"
          }
        ],
        tools: [{ name: "lookup", description: "Look up a record" }]
      },
      context
    );

    expect(requestBodies[0]?.include).toContain("reasoning.encrypted_content");
    expect(requestBodies[1]?.input?.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "reasoning",
      "function_call",
      "function_call_output"
    ]);
    expect(requestBodies[1]?.input?.[1]).toMatchObject({
      type: "reasoning",
      encrypted_content: "encrypted-reasoning"
    });
  });

  it("enables Responses compaction and replays the encrypted checkpoint", async () => {
    const requestBodies: Array<{
      context_management?: Array<Record<string, unknown>>;
      input?: Array<Record<string, unknown>>;
    }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      if (requestBodies.length === 1) {
        return new Response(
          JSON.stringify({
            output: [
              {
                id: "cmp_1",
                type: "compaction",
                encrypted_content: "encrypted-checkpoint"
              },
              {
                type: "function_call",
                call_id: "call_lookup",
                name: "lookup",
                arguments: "{}"
              }
            ],
            usage: {
              input_tokens: 270_001,
              output_tokens: 10,
              total_tokens: 270_011
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      return new Response(JSON.stringify({ output_text: "done" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleChatProvider({
      id: "azure-eu",
      api: "responses",
      model: "gpt-5.5",
      baseUrl: "https://example.test/openai/v1",
      apiKey: "test",
      contextManagement: {
        compaction: {
          compactThresholdTokens: 270_000
        }
      }
    });
    const context = createModelProviderTestContext();
    const first = await provider.complete(
      {
        providerId: "azure-eu",
        model: "gpt-5.5",
        continuation: {
          providerId: "azure-eu",
          state: {
            kind: "openai_responses",
            encryptedReasoningItems: [
              {
                beforeToolCallId: "call_lookup",
                item: {
                  id: "rs_obsolete",
                  type: "reasoning",
                  encrypted_content: "obsolete-reasoning"
                }
              }
            ]
          }
        },
        messages: [{ role: "user", content: "continue" }],
        tools: [{ name: "lookup", description: "Look up a record" }]
      },
      context
    );
    await provider.complete(
      {
        providerId: "azure-eu",
        model: "gpt-5.5",
        continuation: first.continuation,
        messages: [
          { role: "system", content: "Current policy" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "call_lookup", toolName: "lookup", input: {} }]
          },
          { role: "tool", toolCallId: "call_lookup", content: "{\"ok\":true}" }
        ],
        tools: [{ name: "lookup", description: "Look up a record" }]
      },
      context
    );

    expect(requestBodies[0]?.context_management).toEqual([
      { type: "compaction", compact_threshold: 270_000 }
    ]);
    expect(first.contextManagement).toEqual({ compacted: true });
    expect(requestBodies[1]?.input?.map((item) => item.type ?? item.role)).toEqual([
      "system",
      "compaction",
      "function_call",
      "function_call_output"
    ]);
    expect(requestBodies[1]?.input?.[1]).toEqual({
      id: "cmp_1",
      type: "compaction",
      encrypted_content: "encrypted-checkpoint"
    });
  });

  it("keeps visual tool context after sibling tool outputs in Responses input", async () => {
    let requestBody:
      | {
          input?: Array<Record<string, unknown>>;
        }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output_text: "done",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2
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
      apiKey: "test"
    });
    await provider.complete(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { toolCallId: "call_image", toolName: "view_document_page", input: { pageNumber: 1 } },
              { toolCallId: "call_text", toolName: "read_document", input: { mode: "pages" } }
            ]
          },
          {
            role: "tool",
            toolCallId: "call_image",
            content: [
              { type: "text", text: "{\"pageNumber\":1}" },
              {
                type: "image",
                mimeType: "image/png",
                data: new Uint8Array([137, 80, 78, 71])
              }
            ]
          },
          { role: "tool", toolCallId: "call_text", content: "{\"text\":\"page text\"}" }
        ],
        tools: [
          { name: "view_document_page", description: "View PDF page" },
          { name: "read_document", description: "Read document" }
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

    expect(requestBody?.input?.map((item) => item.type ?? item.role)).toEqual([
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "user"
    ]);
    expect(requestBody?.input?.[4]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "input_image" })
      ])
    });
  });

  it("announces OpenAI-compatible tool calls before their streamed input is complete", async () => {
    let requestBody:
      | {
          stream?: boolean;
          stream_options?: { include_usage?: boolean };
          tools?: Array<{ function?: { name?: string } }>;
        }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const toolName = requestBody?.tools?.[0]?.function?.name;
      return new Response(
        createSseStream([
          {
            choices: [
              {
                delta: {
                  content: "Hello",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: toolName,
                        arguments: "{"
                      }
                    }
                  ]
                }
              }
            ]
          },
          {
            choices: [
              {
                delta: {
                  content: " world",
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: "\"ok\":true}"
                      }
                    }
                  ]
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
        tools: [{ name: "save_data", description: "Save data" }]
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
    expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual([
      {
        type: "tool_call_preparing",
        toolCallId: "call_1",
        toolName: "save_data"
      }
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
      | {
          stream?: boolean;
          reasoning?: { effort?: string; summary?: string };
          tools?: Array<{ name: string }>;
          context_management?: Array<Record<string, unknown>>;
        }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      const toolName = requestBody?.tools?.[0]?.name;
      return new Response(
        createSseStream([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs_1"
            }
          },
          {
            type: "response.reasoning_summary_part.added",
            output_index: 0,
            item_id: "rs_1",
            summary_index: 0
          },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            item_id: "rs_1",
            summary_index: 0,
            delta: "I will inspect the document."
          },
          {
            type: "response.output_text.delta",
            delta: "Hello"
          },
          {
            type: "response.output_text.delta",
            delta: " world"
          },
          {
            type: "response.output_item.added",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: toolName
            }
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
              output: [
                {
                  id: "cmp_stream_1",
                  type: "compaction",
                  encrypted_content: "encrypted-stream-checkpoint"
                },
                {
                  type: "reasoning",
                  id: "rs_1",
                  encrypted_content: "encrypted-stream-reasoning"
                },
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: toolName,
                  arguments: "{\"html\":\"<p>Hello</p>\"}"
                }
              ],
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
      reasoningEffort: "high",
      contextManagement: {
        compaction: {
          compactThresholdTokens: 270_000
        }
      }
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
        effort: "high",
        summary: "auto"
      },
      context_management: [{ type: "compaction", compact_threshold: 270_000 }]
    });
    expect(events.filter((event) => event.type === "reasoning_delta").map((event) => event.delta)).toEqual([
      "I will inspect the document."
    ]);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta)).toEqual([
      "Hello",
      " world"
    ]);
    expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual([
      {
        type: "tool_call_preparing",
        toolCallId: "call_1",
        toolName: "show_view"
      }
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
      },
      contextManagement: {
        compacted: true
      },
      continuation: {
        providerId: "openai"
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

function createModelProviderTestContext() {
  const clientInstanceId = asClientInstanceId("client-test");
  return {
    clientInstanceId,
    correlationId: "corr-test",
    user: {
      id: "user-test",
      externalUserId: "user-test",
      displayLabel: "User",
      roles: ["user" as const],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}
