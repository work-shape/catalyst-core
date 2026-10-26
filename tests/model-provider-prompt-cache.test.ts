import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientInstanceId, type RuntimeCallContext } from "@work-shape/catalyst-core";
import {
  OpenAiCompatibleChatProvider,
  toPromptCacheKey,
  type ModelCompletionRequest
} from "@work-shape/catalyst-model-provider";

type SentBody = {
  prompt_cache_key?: string;
  input?: Array<Record<string, unknown>>;
};

function recordRequests(answer: () => Response = () => Response.json({ output_text: "done" })) {
  const bodies: SentBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body: SentBody = JSON.parse(String(init?.body));
      bodies.push(body);
      return answer();
    })
  );
  return bodies;
}

function responsesProvider() {
  return new OpenAiCompatibleChatProvider({
    id: "azure-eu",
    api: "responses",
    model: "gpt-5.5",
    baseUrl: "https://example.test/openai/v1",
    apiKey: "test"
  });
}

const clientInstanceId = asClientInstanceId("prompt-cache-client");
const testContext: RuntimeCallContext = {
  clientInstanceId,
  correlationId: "corr-prompt-cache",
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(input: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  return {
    providerId: "azure-eu",
    model: "gpt-5.5",
    messages: [{ role: "user", content: "continue" }],
    tools: [{ name: "lookup", description: "Look up a record" }],
    ...input
  };
}

const reasoning = (id: string, beforeToolCallId: string) => ({
  beforeToolCallId,
  item: { id, type: "reasoning", encrypted_content: `encrypted-${id}` }
});

describe("the key a model call shares its prompt cache under", () => {
  it("is sent as prompt_cache_key, hashed to the provider's length when longer", async () => {
    const bodies = recordRequests();
    const provider = responsesProvider();
    const long = `conv_${"x".repeat(80)}`;

    await provider.complete(request({ cacheKey: "conv_one" }), testContext);
    await provider.complete(request({ cacheKey: long }), testContext);
    await provider.complete(request({ cacheKey: long }), testContext);
    await provider.complete(request(), testContext);

    expect(bodies[0]?.prompt_cache_key).toBe("conv_one");
    expect(bodies[1]?.prompt_cache_key).toBe(toPromptCacheKey(long));
    expect(bodies[1]?.prompt_cache_key?.length).toBeLessThanOrEqual(64);
    expect(bodies[2]?.prompt_cache_key).toBe(bodies[1]?.prompt_cache_key);
    expect(bodies[3]).not.toHaveProperty("prompt_cache_key");
  });
});

describe("a request that starts as the last one did", () => {
  it("sends a tool call's input with its keys in order, however storage ordered them", async () => {
    const bodies = recordRequests();
    const provider = responsesProvider();
    const withInput = (input: unknown) =>
      request({
        messages: [
          { role: "user", content: "look" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "call_1", toolName: "lookup", input }]
          },
          { role: "tool", toolCallId: "call_1", content: "{}" }
        ]
      });

    await provider.complete(withInput({ query: "a", filter: { to: 2, from: 1 } }), testContext);
    await provider.complete(withInput({ filter: { from: 1, to: 2 }, query: "a" }), testContext);

    const argumentsOf = (body: SentBody | undefined) =>
      body?.input?.find((item) => item.type === "function_call")?.arguments;
    expect(argumentsOf(bodies[0])).toBe('{"filter":{"from":1,"to":2},"query":"a"}');
    expect(argumentsOf(bodies[1])).toBe(argumentsOf(bodies[0]));
  });

  it("sends the reasoning of the calls it holds and carries no other into the next continuation", async () => {
    const bodies = recordRequests(() =>
      Response.json({
        output: [
          { id: "rs_new", type: "reasoning", encrypted_content: "encrypted-rs_new" },
          { type: "function_call", call_id: "call_new", name: "lookup", arguments: "{}" }
        ]
      })
    );
    const completion = await responsesProvider().complete(
      request({
        messages: [
          { role: "user", content: "look" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ toolCallId: "call_kept", toolName: "lookup", input: {} }]
          },
          { role: "tool", toolCallId: "call_kept", content: "{}" }
        ],
        continuation: {
          providerId: "azure-eu",
          state: {
            kind: "openai_responses",
            encryptedReasoningItems: [
              reasoning("rs_gone", "call_gone"),
              reasoning("rs_kept", "call_kept")
            ]
          }
        }
      }),
      testContext
    );

    expect(bodies[0]?.input?.map((item) => item.id ?? item.type ?? item.role)).toEqual([
      "user",
      "rs_kept",
      "function_call",
      "function_call_output"
    ]);
    expect(completion.continuation?.state).toEqual({
      kind: "openai_responses",
      encryptedReasoningItems: [reasoning("rs_kept", "call_kept"), reasoning("rs_new", "call_new")]
    });
  });

  it("treats encrypted content the provider cannot decrypt as a refused continuation", async () => {
    recordRequests(() =>
      Response.json(
        {
          error: {
            message: "The encrypted content could not be verified.",
            type: "invalid_request_error",
            param: null,
            code: "invalid_encrypted_content"
          }
        },
        { status: 400 }
      )
    );
    const provider = responsesProvider();
    const withCall = {
      messages: [
        { role: "user" as const, content: "look" },
        {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ toolCallId: "call_1", toolName: "lookup", input: {} }]
        },
        { role: "tool" as const, toolCallId: "call_1", content: "{}" }
      ]
    };

    const refused = await provider
      .complete(
        request({
          ...withCall,
          continuation: {
            providerId: "azure-eu",
            state: {
              kind: "openai_responses",
              encryptedReasoningItems: [reasoning("rs_1", "call_1")]
            }
          }
        }),
        testContext
      )
      .catch((error: unknown) => error);
    const plain = await provider
      .complete(request(withCall), testContext)
      .catch((error: unknown) => error);

    expect(refused).toMatchObject({ kind: "continuation_rejected" });
    expect(plain).toMatchObject({ kind: "invalid_request" });
  });
});
