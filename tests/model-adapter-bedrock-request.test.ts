import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, ModelTool } from "@vivd-catalyst/model-provider";
import { answerWith, bedrock, message } from "./support/bedrock-adapter";
import { RECORDED_BEDROCK_PROFILE } from "./support/model-adapter-recordings";

/** What the Bedrock adapter sends: the host, the key, and a request in the Messages format. */

const HOST = "https://bedrock-runtime.eu-central-1.amazonaws.com";
const user = (content: ModelMessage["content"]): ModelMessage => ({ role: "user", content });
const weatherTool: ModelTool = {
  name: "get_weather",
  description: "Reads the weather of a city.",
  inputJsonSchema: { type: "object", properties: { city: { type: "string" } } }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bedrock adapter: what it sends", () => {
  it("calls the Frankfurt runtime with the profile ARN, the key as a bearer token and no cache", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));
    const adapter = await bedrock();

    await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        { role: "system", content: "Answer briefly." },
        user("Say hello."),
        { role: "assistant", content: "  " },
        user("Again.")
      ],
      tools: [weatherTool]
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      `${HOST}/model/${encodeURIComponent(RECORDED_BEDROCK_PROFILE)}/invoke`
    );
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer test-bedrock-key");
    expect(sent[0]?.body).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 16_000,
      system: [{ type: "text", text: "Answer briefly." }],
      // An assistant turn of white space alone is no turn, so the two user turns are one.
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Say hello." },
            { type: "text", text: "Again." }
          ]
        }
      ],
      tools: [
        {
          name: "get_weather",
          description: "Reads the weather of a city.",
          input_schema: { type: "object", properties: { city: { type: "string" } } }
        }
      ]
    });
    // The route forbids explicit caches: nothing in a request asks for one.
    expect(JSON.stringify(sent[0]?.body)).not.toMatch(/cache_control|cachePoint/u);
  });

  it("sends tool names through the name table and reads them back", async () => {
    const tools: ModelTool[] = [
      { name: "data.query", description: "Runs a query." },
      { name: "data_query", description: "Runs another query." }
    ];
    let wireName = "";
    const sent = answerWith((request) => {
      wireName = String(records(request.body, "tools")[0]?.name);
      return Response.json(
        message([{ type: "tool_use", id: "toolu_1", name: wireName, input: { sql: "select 1" } }])
      );
    });
    const adapter = await bedrock();

    const completion = await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user("Query."),
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "call:1/a", toolName: "data.query", input: "not an object" }]
        },
        { role: "tool", toolCallId: "call:1/a", content: "" }
      ],
      tools
    });

    const offered = records(sent[0]?.body, "tools").map((tool) => String(tool.name));
    for (const name of offered) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(new Set(offered).size).toBe(2);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "toolu_1", toolName: "data.query", input: { sql: "select 1" } }
    ]);
    const [, assistant, result] = records(sent[0]?.body, "messages");
    const call = records(assistant, "content")[0];
    // An id another provider gave is sent in the format's characters, the same in both places.
    expect(call).toMatchObject({ type: "tool_use", name: wireName, input: {} });
    expect(call?.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(records(result, "content")[0]).toEqual({ type: "tool_result", tool_use_id: call?.id });
  });

  it("leaves out an image above Bedrock's limit and says so in its place", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Seen." }])));
    const adapter = await bedrock();

    await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user([
          { type: "text", text: "Look." },
          { type: "image", mimeType: "image/png" as const, data: new Uint8Array(3_750_001) }
        ])
      ],
      tools: []
    });

    expect(records(sent[0]?.body, "messages")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look." },
          {
            type: "text",
            text: "[1 image could not be included in the model input and was left out.]"
          }
        ]
      }
    ]);
  });

  it("keeps the newest twenty images and says that the older ones were left out", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Seen." }])));
    const image = (index: number) => ({
      type: "image" as const,
      mimeType: "image/png" as const,
      data: Uint8Array.from([index])
    });

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user([image(0), image(1), { type: "text", text: "First." }]),
        { role: "assistant", content: "Seen." },
        user(Array.from({ length: 20 }, (_unused, index) => image(index + 2)))
      ],
      tools: []
    });

    const [first, , last] = records(sent[0]?.body, "messages");
    expect(records(first, "content")).toEqual([
      { type: "text", text: "First." },
      {
        type: "text",
        text: "[2 images could not be included in the model input and were left out.]"
      }
    ]);
    const kept = records(last, "content");
    expect(kept).toHaveLength(20);
    expect(kept[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from([2]).toString("base64") }
    });
  });
});

/** The objects in the list `key` of a request body or of one of its parts. */
function records(value: unknown, key: string): Record<string, unknown>[] {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const items: unknown = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(items)) throw new Error(`Expected a list '${key}'`);
  return items.filter(isRecord);
}
