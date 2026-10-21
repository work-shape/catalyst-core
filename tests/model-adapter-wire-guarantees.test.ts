import { afterEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "@work-shape/catalyst-core";
import {
  OpenAiCompatibleChatProvider,
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterFactory,
  type ModelMessage
} from "@work-shape/catalyst-model-provider";
import { replayServiceAccountKey } from "./support/model-adapter-recordings";
import { silentTestLogger } from "./support/model-gateway";

/**
 * What the adapters guarantee on the wire, whatever builds the request and reads the answer.
 * No request leaves the process.
 */

type Api = "responses" | "chat_completions";

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const userMessage: ModelMessage[] = [{ role: "user", content: "Say hello." }];

/**
 * The model input of a run that paused on a call for its person's decision and went on in
 * another worker: rebuilt from the stored messages, two calls of one step and their results,
 * one executed after the confirmation and one declined.
 */
const resumedTurn: ModelMessage[] = [
  ...userMessage,
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { toolCallId: "call_one", toolName: "save_data", input: { text: "one" } },
      { toolCallId: "call_two", toolName: "save_data", input: { text: "two" } }
    ]
  },
  { role: "tool", toolCallId: "call_one", content: '{"saved":"one"}' },
  { role: "tool", toolCallId: "call_two", content: "The user declined this call. Nothing ran." }
];
const saveData = { name: "save_data", description: "Saves data." };
/**
 * A message steered into the running turn (FU-2): it follows every result of the step it came
 * in on (events-workflows-and-guardrails check 85).
 */
const steeredTurn: ModelMessage[] = [...resumedTurn, { role: "user", content: "Also save three." }];

function openAiAnswer(api: Api): unknown {
  return api === "responses"
    ? { output_text: "Hello.", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
    : {
        choices: [{ message: { content: "Hello." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
      };
}

/** A fake OpenAI-compatible provider that keeps what it was sent. */
function openAiProvider(respond: (sent: Sent) => Response): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body))
    };
    sent.push(request);
    return respond(request);
  });
  return sent;
}

function events(chunks: unknown[], marker = true): Response {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      (marker ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

/** A stream the provider accepted and then sends nothing on. */
function silentStream(onCancel: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({ cancel: onCancel }), {
    headers: { "content-type": "text/event-stream" }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const read: unknown[] = [];
  for await (const event of stream) read.push(event);
  return read;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each<Api>(["responses", "chat_completions"])("OpenAI-compatible wire: %s", (api) => {
  function azureDeployment(): OpenAiCompatibleChatProvider {
    return new OpenAiCompatibleChatProvider({
      id: "azure",
      api,
      // A deployment is named freely: nothing in the name says which model it is.
      model: "dev-gpt-6.1-sol",
      baseUrl: "https://recorded.openai.azure.test/openai/v1",
      apiKey: "replay-api-key",
      authMode: "api-key"
    });
  }

  it.each(["none", "low", "high"] as const)(
    "sends a freely named deployment its key, the priority tier and the effort '%s'",
    async (reasoningEffort) => {
      const sent = openAiProvider(() => Response.json(openAiAnswer(api)));
      await azureDeployment().complete(
        {
          providerId: "azure",
          model: "dev-gpt-6.1-sol",
          messages: [{ role: "system", content: "Answer briefly." }, ...userMessage],
          tools: [],
          fastMode: true,
          reasoningEffort
        },
        {}
      );

      const [request] = sent;
      expect(request?.url).toBe(
        `https://recorded.openai.azure.test/openai/v1/${api === "responses" ? "responses" : "chat/completions"}`
      );
      expect(request?.headers.get("api-key")).toBe("replay-api-key");
      expect(request?.headers.has("authorization")).toBe(false);
      expect(request?.body.model).toBe("dev-gpt-6.1-sol");
      expect(request?.body.service_tier).toBe("priority");
      if (api === "responses") {
        expect(request?.body.reasoning).toMatchObject({ effort: reasoningEffort });
        // Nothing of a call is kept at the provider.
        expect(request?.body.store).toBe(false);
        expect(request?.body.include).toEqual(["reasoning.encrypted_content"]);
        expect(request?.body).not.toHaveProperty("previous_response_id");
        expect(request?.body.input).toMatchObject([{ role: "system" }, { role: "user" }]);
      } else {
        expect(request?.body.reasoning_effort).toBe(reasoningEffort);
        expect(request?.body.messages).toMatchObject([{ role: "system" }, { role: "user" }]);
      }
    }
  );

  it("sends no tier and no effort that the call did not ask for", async () => {
    const sent = openAiProvider(() => Response.json(openAiAnswer(api)));
    await azureDeployment().complete(
      { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
      {}
    );
    expect(sent[0]?.body).not.toHaveProperty("service_tier");
    expect(sent[0]?.body).not.toHaveProperty("reasoning_effort");
    expect(sent[0]?.body.reasoning).toBeUndefined();
  });

  it.each([500, 429])(
    "sends a call the provider refuses with %i once: the gateway retries, the adapter does not",
    async (status) => {
      const sent = openAiProvider(
        () =>
          new Response(JSON.stringify({ error: { message: "refused", code: "refused" } }), {
            status,
            headers: { "content-type": "application/json" }
          })
      );
      await expect(
        azureDeployment().complete(
          { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
          {}
        )
      ).rejects.toMatchObject({ details: { status } });
      await expect(
        drain(
          azureDeployment().stream(
            { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
            {}
          )
        )
      ).rejects.toMatchObject({ details: { status } });
      expect(sent).toHaveLength(2);
    }
  );

  it("reads an answer that holds items and fields it does not know, and keeps its usage", async () => {
    openAiProvider(() =>
      Response.json(
        api === "responses"
          ? {
              a_field_of_next_year: { any: "thing" },
              output: [
                { type: "an_item_of_next_year", id: "x_1", payload: { any: "thing" } },
                {
                  type: "message",
                  content: [
                    { type: "a_part_of_next_year", value: 1 },
                    { type: "output_text", text: "Hello." }
                  ]
                }
              ],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
            }
          : {
              a_field_of_next_year: { any: "thing" },
              choices: [
                { message: { content: "Hello.", a_field_of_next_year: [1] }, finish_reason: "new" }
              ],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
            }
      )
    );
    const completion = await azureDeployment().complete(
      { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
      {}
    );
    expect(completion.text).toBe("Hello.");
    expect(completion.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
      source: "provider_reported"
    });
  });

  it("reads a stream that holds events it does not know, and keeps its usage", async () => {
    openAiProvider(() =>
      events(
        api === "responses"
          ? [
              { type: "response.an_event_of_next_year", payload: { any: "thing" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "an_item_of_next_year", id: "x_1" }
              },
              { type: "response.output_text.delta", delta: "Hello." },
              {
                type: "response.completed",
                response: {
                  output: [
                    { type: "an_item_of_next_year", id: "x_1" },
                    { type: "message", content: [{ type: "output_text", text: "Hello." }] }
                  ],
                  usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
                }
              }
            ]
          : [
              { an_object_of_next_year: true },
              { choices: [{ delta: { content: "Hello.", a_field_of_next_year: 1 } }] },
              { choices: [{ delta: {}, finish_reason: "new" }] },
              { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
            ]
      )
    );
    const read = await drain(
      azureDeployment().stream(
        { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
        {}
      )
    );
    expect(read.at(-1)).toMatchObject({
      type: "completed",
      completion: {
        text: "Hello.",
        usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, source: "provider_reported" }
      }
    });
  });

  it("sends a tool under a name the provider accepts and answers with the product's name", async () => {
    const sent = openAiProvider(() =>
      Response.json(
        api === "responses"
          ? {
              output: [
                {
                  type: "function_call",
                  call_id: "call_1",
                  name: "workspace_exec",
                  arguments: '{"command":"pwd"}'
                }
              ]
            }
          : {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "workspace_exec", arguments: '{"command":"pwd"}' }
                      }
                    ]
                  }
                }
              ]
            }
      )
    );
    const completion = await azureDeployment().complete(
      {
        providerId: "azure",
        model: "dev-gpt-6.1-sol",
        messages: userMessage,
        tools: [{ name: "workspace.exec", description: "Runs a command." }]
      },
      {}
    );
    expect(JSON.stringify(sent[0]?.body.tools)).toContain('"workspace_exec"');
    expect(JSON.stringify(sent[0]?.body.tools)).not.toContain("workspace.exec");
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_1", toolName: "workspace.exec", input: { command: "pwd" } }
    ]);
  });

  it("gives up a stream that stays silent from its first byte, and ends the request", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    openAiProvider(() =>
      silentStream(() => {
        cancelled = true;
      })
    );
    const next = azureDeployment()
      .stream(
        { providerId: "azure", model: "dev-gpt-6.1-sol", messages: userMessage, tools: [] },
        {}
      )
      [Symbol.asyncIterator]()
      .next();
    const outcome = expect(next).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await outcome;
    expect(cancelled).toBe(true);
  });

  it("sends the malformed input of an earlier tool call back as the text it was", async () => {
    const sent = openAiProvider(() => Response.json(openAiAnswer(api)));
    await azureDeployment().complete(
      {
        providerId: "azure",
        model: "dev-gpt-6.1-sol",
        tools: [{ name: "save_data", description: "Saves data." }],
        messages: [
          ...userMessage,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                toolCallId: "call_bad",
                toolName: "save_data",
                input: {},
                inputParseError: {
                  code: "invalid_json",
                  message: "Unexpected end of JSON input",
                  rawInput: '{"a":'
                }
              }
            ]
          },
          { role: "tool", toolCallId: "call_bad", content: "The input was no JSON." }
        ]
      },
      {}
    );
    const call =
      api === "responses"
        ? records(sent[0]?.body.input).find((item) => item.type === "function_call")
        : records(sent[0]?.body.messages)
            .flatMap((message) => records(message.tool_calls))
            .map((toolCall) => (isRecord(toolCall.function) ? toolCall.function : {}))[0];
    expect(call?.arguments).toBe('{"a":');
  });

  it("sends the tool-result turn of a resumed run as its calls and their results, in order", async () => {
    const sent = openAiProvider(() => Response.json(openAiAnswer(api)));
    await azureDeployment().complete(
      {
        providerId: "azure",
        model: "dev-gpt-6.1-sol",
        tools: [saveData],
        messages: resumedTurn
      },
      {}
    );

    if (api === "responses") {
      const items = records(sent[0]?.body.input).filter((item) => item.role !== "user");
      expect(items).toMatchObject([
        { type: "function_call", call_id: "call_one", name: "save_data" },
        { type: "function_call", call_id: "call_two", name: "save_data" },
        { type: "function_call_output", call_id: "call_one", output: '{"saved":"one"}' },
        { type: "function_call_output", call_id: "call_two" }
      ]);
    } else {
      expect(sent[0]?.body.messages).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_one", function: { name: "save_data" } },
            { id: "call_two", function: { name: "save_data" } }
          ]
        },
        { role: "tool", tool_call_id: "call_one", content: '{"saved":"one"}' },
        { role: "tool", tool_call_id: "call_two" }
      ]);
    }
  });

  it("sends a steered message after every result of the step it came in on", async () => {
    const sent = openAiProvider(() => Response.json(openAiAnswer(api)));
    await azureDeployment().complete(
      {
        providerId: "azure",
        model: "dev-gpt-6.1-sol",
        tools: [saveData],
        messages: steeredTurn
      },
      {}
    );

    if (api === "responses") {
      const items = records(sent[0]?.body.input);
      expect(items.slice(-3, -1).map((item) => item.type)).toEqual([
        "function_call_output",
        "function_call_output"
      ]);
      expect(items.at(-1)).toMatchObject({ role: "user" });
      expect(JSON.stringify(items.at(-1))).toContain("Also save three.");
    } else {
      const messages = records(sent[0]?.body.messages);
      expect(messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "tool",
        "user"
      ]);
      expect(JSON.stringify(messages.at(-1))).toContain("Also save three.");
    }
  });
});

describe("OpenAI Responses stream failures", () => {
  const provider = (): OpenAiCompatibleChatProvider =>
    new OpenAiCompatibleChatProvider({
      id: "openai",
      api: "responses",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });
  const response = (status: string, error: unknown = null): unknown => ({
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "test-model",
    status,
    error,
    output: []
  });
  const request = { providerId: "openai", model: "test-model", messages: userMessage, tools: [] };

  it.each([
    {
      name: "a failed response",
      failure: {
        type: "response.failed",
        sequence_number: 2,
        response: response("failed", { code: "server_error", message: "PLANTED-PROVIDER-TEXT" })
      },
      expected: {
        kind: "server_error",
        details: { status: 500, providerErrorCode: "server_error" }
      }
    },
    {
      name: "an error event",
      failure: {
        type: "error",
        sequence_number: 2,
        code: "rate_limit_exceeded",
        message: "PLANTED-PROVIDER-TEXT",
        param: null
      },
      expected: {
        kind: "rate_limit",
        details: { status: 429, providerErrorCode: "rate_limit_exceeded" }
      }
    }
  ])(
    "types $name the same before and after the first output, with none of the provider's text",
    async ({ failure, expected }) => {
      const opening = [
        { type: "response.created", sequence_number: 0, response: response("in_progress") },
        { type: "response.in_progress", sequence_number: 1, response: response("in_progress") }
      ];
      const output = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { id: "msg_1", type: "message", role: "assistant", content: [] }
        },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hel" }
      ];
      for (const chunks of [
        [...opening, failure],
        [...opening, ...output, failure]
      ]) {
        openAiProvider(() => events(chunks, false));
        const error: unknown = await drain(provider().stream(request, {})).catch(
          (thrown: unknown) => thrown
        );
        expect(error).toMatchObject({ message: "Model provider stream failed", ...expected });
        expect(JSON.stringify(error)).not.toContain("PLANTED-PROVIDER-TEXT");
      }
    }
  );
});

describe("OpenAI chat completions stream endings", () => {
  it("fails a stream that ends after its finish reason but before the completion marker", async () => {
    openAiProvider(() =>
      events(
        [
          { choices: [{ delta: { content: "Hello." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] }
        ],
        false
      )
    );
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      api: "chat_completions",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });
    await expect(
      drain(
        provider.stream(
          { providerId: "openai", model: "test-model", messages: userMessage, tools: [] },
          {}
        )
      )
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Model provider stream ended before the completion marker"
    });
  });
});

describe("Google Vertex wire", () => {
  const vertexAnswer = {
    candidates: [{ content: { role: "model", parts: [{ text: "Hello." }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 }
  };

  /** A fake Google: the token endpoint and Vertex. It keeps what each was sent. */
  function google(
    respond: () => Response = () => Response.json(vertexAnswer),
    tokenStatus = 200
  ): { tokenRequests: () => number; sent: Sent[] } {
    const sent: Sent[] = [];
    let tokenRequests = 0;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === GOOGLE_TOKEN_URL) {
        tokenRequests += 1;
        return tokenStatus === 200
          ? Response.json({
              access_token: "replay-access-token",
              expires_in: 3600,
              token_type: "Bearer"
            })
          : Response.json(
              { error: "PLANTED-PROVIDER-TEXT", error_description: "PLANTED-PROVIDER-TEXT" },
              { status: tokenStatus }
            );
      }
      sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return respond();
    });
    return { tokenRequests: () => tokenRequests, sent };
  }

  async function vertex(region: "eu" | "global" = "eu"): Promise<ModelAdapter> {
    const factory = await createProvider<"models", ModelAdapterFactory>(
      modelProviderDefinitions,
      "models",
      {
        path: "infrastructure.models.vertex",
        entry: {
          provider: "google-vertex",
          region,
          model: "recorded-gemini-model",
          projectId: "recorded-project",
          credentialSecret: "VERTEX_KEY"
        }
      },
      { secrets: { resolve: async () => replayServiceAccountKey() }, logger: silentTestLogger }
    );
    return factory({ id: "vertex", type: "google-vertex", region, model: "recorded-gemini-model" });
  }

  const request = { model: "recorded-gemini-model", messages: userMessage, tools: [] };

  it.each([
    ["eu", "https://aiplatform.eu.rep.googleapis.com/v1/projects/recorded-project/locations/eu"],
    ["global", "https://aiplatform.googleapis.com/v1/projects/recorded-project/locations/global"]
  ] as const)(
    "keeps a call of a '%s' entry on that region's host and location",
    async (region, base) => {
      const { sent } = google();
      const adapter = await vertex(region);
      await adapter.complete(request);
      expect(sent[0]?.url).toBe(
        `${base}/publishers/google/models/recorded-gemini-model:generateContent`
      );
    }
  );

  it("sends the tool-result turn of a resumed run with the names of its calls", async () => {
    const { sent } = google();
    const adapter = await vertex();
    await adapter.complete({ ...request, tools: [saveData], messages: resumedTurn });

    // The results of calls made together are one turn, each named by its call's function.
    expect(sent[0]?.body.contents).toEqual([
      { role: "user", parts: [{ text: "Say hello." }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "save_data", args: { text: "one" } } },
          { functionCall: { name: "save_data", args: { text: "two" } } }
        ]
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "save_data", response: { output: expect.anything() } } },
          { functionResponse: { name: "save_data", response: { output: expect.anything() } } }
        ]
      }
    ]);
  });

  it("sends a steered message after the function responses, in the same user turn", async () => {
    const { sent } = google();
    const adapter = await vertex();
    await adapter.complete({ ...request, tools: [saveData], messages: steeredTurn });

    const contents = records(sent[0]?.body.contents);
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    const parts = records(contents.at(-1)?.parts);
    expect(parts.map((part) => Object.keys(part)[0])).toEqual([
      "functionResponse",
      "functionResponse",
      "text"
    ]);
    expect(parts.at(-1)).toEqual({ text: "Also save three." });
  });

  it("asks for no grounding, no cached content and no settings beyond the call", async () => {
    const { sent } = google();
    const adapter = await vertex();
    await adapter.complete({
      ...request,
      messages: [...userMessage, { role: "system", content: "Answer briefly." }]
    });
    expect(Object.keys(sent[0]?.body ?? {}).sort()).toEqual(["contents", "systemInstruction"]);
    // A system message is sent as the instruction wherever the call has it.
    expect(sent[0]?.body.systemInstruction).toEqual({ parts: [{ text: "Answer briefly." }] });
  });

  it("calls with the service account although the environment holds a key and a place", async () => {
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "environment-api-key");
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "us-central1");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "another-project");
    const { sent } = google();
    const adapter = await vertex();
    await adapter.complete(request);
    expect(sent[0]?.url).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/recorded-project/locations/eu/publishers/google/models/recorded-gemini-model:generateContent"
    );
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer replay-access-token");
    expect(sent[0]?.headers.has("x-goog-api-key")).toBe(false);
    expect(sent[0]?.url).not.toContain("environment-api-key");
  });

  it("asks for one token for calls that follow each other", async () => {
    const { sent, tokenRequests } = google();
    const adapter = await vertex();
    await adapter.complete(request);
    await adapter.complete(request);
    expect(sent).toHaveLength(2);
    expect(tokenRequests()).toBe(1);
  });

  it.each([500, 401])(
    "asks for a token once when Google refuses with %i, and sends no call",
    async (status) => {
      const { sent, tokenRequests } = google(undefined, status);
      const adapter = await vertex();
      const error: unknown = await adapter.complete(request).catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({
        message: "Model provider authentication failed",
        details: { status, stage: "authentication" }
      });
      expect(JSON.stringify(error)).not.toContain("PLANTED-PROVIDER-TEXT");
      expect(tokenRequests()).toBe(1);
      expect(sent).toHaveLength(0);
    }
  );

  it("sends a call Vertex refuses once: the gateway retries, the adapter does not", async () => {
    const { sent } = google(() =>
      Response.json({ error: { code: 503, status: "UNAVAILABLE", message: "x" } }, { status: 503 })
    );
    const adapter = await vertex();
    await expect(adapter.complete(request)).rejects.toMatchObject({ details: { status: 503 } });
    await expect(drain(adapter.stream(request))).rejects.toMatchObject({
      details: { status: 503 }
    });
    expect(sent).toHaveLength(2);
  });

  it("gives up a stream that stays silent from its first byte, and ends the request", async () => {
    let cancelled = false;
    let silent = false;
    google(() =>
      silent
        ? silentStream(() => {
            cancelled = true;
          })
        : Response.json(vertexAnswer)
    );
    const adapter = await vertex();
    // The token is at hand before the clock is replaced: its request is no part of the limit.
    await adapter.complete(request);
    silent = true;
    vi.useFakeTimers();
    const next = adapter.stream(request)[Symbol.asyncIterator]().next();
    let outcome: unknown = "pending";
    void next.then(
      () => (outcome = "answered"),
      (error: unknown) => (outcome = error)
    );
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(outcome).toMatchObject({ code: "TIMEOUT" });
    expect(cancelled).toBe(true);
  });

  it("reads an answer that holds parts and fields it does not know, and keeps its usage", async () => {
    google(() =>
      Response.json({
        aFieldOfNextYear: { any: "thing" },
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ aPartOfNextYear: { any: "thing" } }, { text: "Hello." }]
            },
            finishReason: "STOP",
            aFieldOfNextYear: 1
          }
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 1,
          totalTokenCount: 4,
          aCountOfNextYear: 9
        }
      })
    );
    const adapter = await vertex();
    const completion = await adapter.complete(request);
    expect(completion.text).toBe("Hello.");
    expect(completion.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 1,
      source: "provider_reported"
    });
  });
});
