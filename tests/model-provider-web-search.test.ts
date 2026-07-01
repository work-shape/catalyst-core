import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientInstanceId, type RuntimeCallContext } from "@vivd-catalyst/core";
import { OpenAiCompatibleChatProvider, type ModelCompletionStreamEvent } from "@vivd-catalyst/model-provider";

const OPENAI_WEB_SEARCH_TOOL = {
  kind: "provider",
  id: "openai.web_search",
  name: "web_search"
} as const;

describe("OpenAI provider-native web search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes provider-native web_search for OpenAI Responses requests", async () => {
    let requestBody:
      | {
          include?: string[];
          tools?: Array<{ type: string; name?: string }>;
        }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));

      return new Response(
        JSON.stringify({
          output_text: "Search completed.",
          usage: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createResponsesProvider();
    const completion = await provider.complete(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "search the web" }],
        tools: [OPENAI_WEB_SEARCH_TOOL]
      },
      createRuntimeContext()
    );

    expect(requestBody).toMatchObject({
      include: ["web_search_call.action.sources"],
      tools: [{ type: "web_search" }]
    });
    expect(requestBody?.tools?.[0]).not.toHaveProperty("name");
    expect(completion).toMatchObject({
      text: "Search completed.",
      toolCalls: [],
      sources: [],
      citations: [],
      usage: {
        totalTokens: 7,
        webSearchCallCount: 0,
        source: "provider_reported"
      }
    });
  });

  it("normalizes OpenAI Responses web search sources and citations", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "web_search_call",
              action: {
                type: "search",
                query: "example query",
                sources: [
                  {
                    url: "https://example.com/a",
                    title: "Example A",
                    snippet: "Example snippet"
                  }
                ]
              }
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "See Example A.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.com/a",
                      title: "Example A",
                      start_index: 4,
                      end_index: 13
                    }
                  ]
                }
              ]
            }
          ],
          usage: {
            input_tokens: 5,
            output_tokens: 6,
            total_tokens: 11
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createResponsesProvider();
    const completion = await provider.complete(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "search the web" }],
        tools: [OPENAI_WEB_SEARCH_TOOL]
      },
      createRuntimeContext()
    );

    expect(completion.text).toBe("See Example A.");
    expect(completion.sources).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^web_[a-f0-9]{16}$/u),
        url: "https://example.com/a",
        title: "Example A",
        provider: "openai-native",
        query: "example query",
        snippet: "Example snippet",
        resultPosition: 1
      })
    ]);
    expect(completion.citations).toEqual([
      {
        sourceId: completion.sources?.[0]?.id,
        label: "Example A",
        characterRange: {
          start: 4,
          end: 13
        }
      }
    ]);
    expect(completion.usage).toMatchObject({
      totalTokens: 11,
      webSearchCallCount: 1
    });
  });

  it("streams provider-native web_search responses while preserving completed source metadata", async () => {
    let requestBody:
      | {
          include?: string[];
          stream?: boolean;
          tools?: Array<{ type: string; name?: string }>;
        }
      | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));

      return new Response(
        createSseStream([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "in_progress"
            }
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "example query",
                sources: [
                  {
                    url: "https://example.com/a",
                    title: "Example A",
                    snippet: "Example snippet"
                  }
                ]
              }
            }
          },
          {
            type: "response.output_text.delta",
            delta: "See "
          },
          {
            type: "response.output_text.delta",
            delta: "Example A."
          },
          {
            type: "response.completed",
            response: {
              output: [
                {
                  type: "web_search_call",
                  action: {
                    type: "search",
                    query: "example query",
                    sources: [
                      {
                        url: "https://example.com/a",
                        title: "Example A",
                        snippet: "Example snippet"
                      }
                    ]
                  }
                },
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: "See Example A.",
                      annotations: [
                        {
                          type: "url_citation",
                          url: "https://example.com/a",
                          title: "Example A",
                          start_index: 4,
                          end_index: 13
                        }
                      ]
                    }
                  ]
                }
              ],
              usage: {
                input_tokens: 5,
                output_tokens: 6,
                total_tokens: 11
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

    const provider = createResponsesProvider();
    const events: ModelCompletionStreamEvent[] = [];
    for await (const event of provider.stream?.(
      {
        providerId: "openai",
        model: "gpt-5.5",
        messages: [{ role: "user", content: "search the web" }],
        tools: [OPENAI_WEB_SEARCH_TOOL]
      },
      createRuntimeContext()
    ) ?? []) {
      events.push(event);
    }

    expect(requestBody).toMatchObject({
      include: ["web_search_call.action.sources"],
      stream: true,
      tools: [{ type: "web_search" }]
    });
    expect(events.slice(0, 2)).toEqual([
      {
        type: "provider_tool_started",
        toolCallId: "ws_1",
        toolName: "web_search",
        input: {}
      },
      {
        type: "provider_tool_completed",
        toolCallId: "ws_1",
        toolName: "web_search",
        output: {
          status: "completed",
          actionType: "search",
          query: "example query",
          sourceCount: 1
        }
      }
    ]);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("")).toBe("See Example A.");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      completion: {
        text: "See Example A.",
        sources: [
          expect.objectContaining({
            url: "https://example.com/a",
            title: "Example A",
            provider: "openai-native",
            query: "example query",
            snippet: "Example snippet"
          })
        ],
        citations: [
          {
            sourceId: expect.stringMatching(/^web_[a-f0-9]{16}$/u),
            label: "Example A",
            characterRange: {
              start: 4,
              end: 13
            }
          }
        ],
        usage: {
          totalTokens: 11,
          webSearchCallCount: 1,
          source: "provider_reported"
        }
      }
    });
  });

  it("rejects provider-native web_search on Chat Completions providers", async () => {
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      model: "gpt-test",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });

    await expect(
      provider.complete(
        {
          providerId: "openai",
          model: "gpt-test",
          messages: [{ role: "user", content: "search the web" }],
          tools: [OPENAI_WEB_SEARCH_TOOL]
        },
        createRuntimeContext()
      )
    ).rejects.toThrow(/Provider-native model tools are only supported/u);
  });
});

function createResponsesProvider(): OpenAiCompatibleChatProvider {
  return new OpenAiCompatibleChatProvider({
    id: "openai",
    api: "responses",
    model: "gpt-5.5",
    baseUrl: "https://example.test/v1",
    apiKey: "test"
  });
}

function createRuntimeContext(): RuntimeCallContext {
  const clientInstanceId = asClientInstanceId("client-test");
  return {
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
  };
}

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
