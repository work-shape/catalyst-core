import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelProviderError,
  type ModelMessage,
  type ModelTool
} from "@vivd-catalyst/model-provider";
import { answerWith, bedrock, collect, message } from "./support/bedrock-adapter";
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

describe("Bedrock adapter: documents", () => {
  const pdf = (data: Uint8Array) => ({
    type: "document" as const,
    mimeType: "application/pdf" as const,
    data
  });
  const ask = (documents: Uint8Array[]) => ({
    model: RECORDED_BEDROCK_PROFILE,
    messages: [user([...documents.map(pdf), { type: "text" as const, text: "Summarize." }])],
    tools: []
  });

  it("sends a PDF as a document block where it stands, also in the result of a tool", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));
    const data = syntheticPdf(100);
    const block = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(data).toString("base64")
      }
    };

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user("Load the report."),
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_1", toolName: "get_weather", input: {} }]
        },
        { role: "tool", toolCallId: "toolu_1", content: [pdf(data)] }
      ],
      tools: [weatherTool]
    });

    const [, , result] = records(sent[0]?.body, "messages");
    expect(records(result, "content")).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: [block] }
    ]);
  });

  it.each([
    [
      "a document above 4.5 MB",
      [new Uint8Array(4_500_001)],
      "document_too_large",
      "BEDROCK_DOCUMENT_MAX_BYTES",
      "A document is too large for the model. Split it and send the parts."
    ],
    [
      "documents of more than 100 pages together",
      [syntheticPdf(60), syntheticPdf(41)],
      "document_too_many_pages",
      "BEDROCK_DOCUMENT_MAX_PAGES",
      "The documents have too many pages for the model. Split them and send the parts."
    ]
  ])("refuses %s by name and sends nothing", async (_name, documents, reason, limit, sentence) => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));
    const adapter = await bedrock();
    const request = ask(documents);

    for (const failure of [
      await adapter.complete(request).catch((error: unknown) => error),
      await collect(adapter.stream(request)).catch((error: unknown) => error)
    ]) {
      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(failure).toMatchObject({
        kind: "invalid_request",
        retryable: false,
        message: sentence,
        details: { providerId: "bedrock", reason, limit }
      });
    }
    // Refused whole: the document is not left out of a request that is sent without it.
    expect(sent).toHaveLength(0);
  });

  it("sends documents at the limits", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));

    await (await bedrock()).complete(ask([syntheticPdf(100), new Uint8Array(4_500_000)]));

    expect(sent).toHaveLength(1);
    expect(records(records(sent[0]?.body, "messages")[0], "content")).toHaveLength(3);
  });
});

describe("Bedrock adapter: answer formats", () => {
  it("sends the format as the Messages format's own structured output, beside the effort", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "{}" }])));

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [user("Extract.")],
      tools: [weatherTool],
      reasoningEffort: "low",
      output: {
        jsonSchema: {
          type: "object",
          required: ["findings"],
          additionalProperties: true,
          properties: {
            // A property may carry the name of a keyword. It is a name here and stays.
            maximum: { type: "integer", minimum: 0, maximum: 9, multipleOf: 3 },
            label: { type: "string", minLength: 1, maxLength: 80, enum: ["a", "b"] },
            findings: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: {
                type: ["object", "null"],
                properties: {
                  pages: { type: "array", minItems: 2, items: { $ref: "#/$defs/page" } }
                }
              }
            },
            either: { anyOf: [{ type: "object", properties: {} }, { type: "null" }] }
          },
          $defs: { page: { type: "integer", exclusiveMinimum: 0 } }
        }
      }
    });

    const body = sent[0]?.body;
    expect(body).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            required: ["findings"],
            // The one value Bedrock takes, on every object of the schema.
            additionalProperties: false,
            properties: {
              maximum: { type: "integer" },
              label: { type: "string", enum: ["a", "b"] },
              findings: {
                type: "array",
                minItems: 1,
                items: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { pages: { type: "array", items: { $ref: "#/$defs/page" } } }
                }
              },
              either: {
                anyOf: [
                  { type: "object", properties: {}, additionalProperties: false },
                  { type: "null" }
                ]
              }
            },
            $defs: { page: { type: "integer" } }
          }
        }
      }
    });
    // Nothing Bedrock refuses to compile is left, and no tool is forced for the format.
    expect(JSON.stringify(body)).not.toMatch(
      /"(minimum|multipleOf|minLength|maxLength|maxItems|uniqueItems|exclusiveMinimum)":/u
    );
    expect(body).not.toHaveProperty("tool_choice");
    expect(records(body, "tools")).toHaveLength(1);
  });

  it("sends no output setting for a call without a format and without an effort", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

    await (
      await bedrock()
    ).complete({ model: RECORDED_BEDROCK_PROFILE, messages: [user("Say hello.")], tools: [] });

    expect(sent[0]?.body).not.toHaveProperty("output_config");
  });
});

/** A PDF in outline only: a page tree and that many page objects. No reader opens it. */
function syntheticPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_unused, index) => `${index + 3} 0 R`).join(" ");
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      `2 0 obj << /Type /Pages /Count ${pages} /Kids [${kids}] >> endobj`,
      ...Array.from(
        { length: pages },
        (_unused, index) => `${index + 3} 0 obj << /Type/Page /Parent 2 0 R >> endobj`
      ),
      "%%EOF"
    ].join("\n")
  );
}

/** The objects in the list `key` of a request body or of one of its parts. */
function records(value: unknown, key: string): Record<string, unknown>[] {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const items: unknown = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(items)) throw new Error(`Expected a list '${key}'`);
  return items.filter(isRecord);
}
