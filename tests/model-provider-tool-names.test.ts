import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAiCompatibleChatProvider,
  type ModelAdapterStreamEvent,
  type ModelCompletion,
  type ModelMessage
} from "@vivd-catalyst/model-provider";

type Api = "chat_completions" | "responses";

interface CapturedBody {
  tools: Array<{ type: string; name?: string; function?: { name: string } }>;
  messages?: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
  input?: Array<{ type?: string; name?: string }>;
}

const validWireName = /^[a-zA-Z0-9_-]{1,64}$/u;
const longName = `connection.${"x".repeat(64)}.${"y".repeat(64)}.${"z".repeat(59)}`;

function hash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex");
}

function offeredNames(body: CapturedBody): string[] {
  return body.tools
    .filter((tool) => tool.type === "function")
    .map((tool) => {
      const name = tool.function?.name ?? tool.name;
      if (name === undefined) throw new Error("Request has no function name");
      return name;
    });
}

function historyNames(body: CapturedBody): string[] {
  return body.messages
    ? body.messages.flatMap(
        (message) => message.tool_calls?.map((call) => call.function.name) ?? []
      )
    : (body.input?.filter((item) => item.type === "function_call").map((item) => item.name ?? "") ??
        []);
}

function setup(
  api: Api,
  replyNames: (body: CapturedBody) => string[] = offeredNames
): { provider: OpenAiCompatibleChatProvider; bodies: CapturedBody[] } {
  const bodies: CapturedBody[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body: CapturedBody & { stream?: boolean } = JSON.parse(String(init?.body));
      bodies.push(body);
      const names = replyNames(body);
      const calls = names.map((name, index) => ({
        type: "function_call",
        call_id: `call_${index}`,
        name,
        arguments: '{"ok":true}'
      }));
      const chatCalls = calls.map((call) => ({
        id: call.call_id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      }));
      const payload =
        api === "responses"
          ? { output: calls }
          : { choices: [{ message: { content: null, tool_calls: chatCalls } }] };
      if (!body.stream) {
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" }
        });
      }
      const chunks =
        api === "responses"
          ? calls.flatMap((call, index) => [
              {
                type: "response.output_item.added",
                output_index: index,
                item: { ...call, arguments: "" }
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: index,
                delta: call.arguments
              },
              { type: "response.output_item.done", output_index: index, item: call }
            ])
          : chatCalls.flatMap((call, index) => [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          ...call,
                          index,
                          function: { name: call.function.name, arguments: "{" }
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
                      tool_calls: [
                        {
                          index,
                          function: { arguments: '"ok":true}' }
                        }
                      ]
                    }
                  }
                ]
              }
            ]);
      const ending =
        api === "responses"
          ? `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n`
          : "data: [DONE]\n\n";
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + ending,
        {
          headers: { "content-type": "text/event-stream" }
        }
      );
    })
  );
  return {
    provider: new OpenAiCompatibleChatProvider({
      id: "openai",
      api,
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    }),
    bodies
  };
}

async function request(
  provider: OpenAiCompatibleChatProvider,
  names: string[],
  messages: ModelMessage[] = [{ role: "user", content: "Run tools" }],
  stream = false
): Promise<{ completion: ModelCompletion; events: ModelAdapterStreamEvent[] }> {
  const input = {
    providerId: "openai",
    model: "test-model",
    tools: names.map((name) => ({ name, description: name })),
    messages
  };
  if (!stream) return { completion: await provider.complete(input, {}), events: [] };
  const events: ModelAdapterStreamEvent[] = [];
  for await (const event of provider.stream(input, {})) events.push(event);
  const completed = events.find((event) => event.type === "completed");
  if (!completed || completed.type !== "completed") throw new Error("Stream did not complete");
  return { completion: completed.completion, events };
}

function captured(bodies: CapturedBody[], index = 0): CapturedBody {
  const body = bodies[index];
  if (!body) throw new Error("No request captured");
  return body;
}

function history(names: string[]): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: names.map((toolName, index) => ({
        toolCallId: `old_${index}`,
        toolName,
        input: {}
      }))
    },
    ...names.map((_, index): ModelMessage => ({
      role: "tool",
      toolCallId: `old_${index}`,
      content: "done"
    })),
    { role: "user", content: "Continue" }
  ];
}

afterEach(() => vi.unstubAllGlobals());

describe.each<Api>(["chat_completions", "responses"])("Readable tool names: %s", (api) => {
  it("sends workspace.exec as workspace_exec", async () => {
    const { provider, bodies } = setup(api);
    await request(provider, ["workspace.exec"]);
    expect(offeredNames(captured(bodies))).toEqual(["workspace_exec"]);
  });

  it("promotes every collision member and maps both back regardless of order", async () => {
    const names = ["a.b_c", "a_b.c"];
    const expected = names.map((name) => `a_b_c_${hash(name).slice(0, 8)}`);
    const { provider, bodies } = setup(api);
    const first = await request(provider, names);
    const second = await request(provider, [...names].reverse());
    expect(offeredNames(captured(bodies))).toEqual(expected);
    expect(offeredNames(captured(bodies, 1))).toEqual([...expected].reverse());
    expect(new Set(expected).size).toBe(2);
    for (const name of expected) expect(name).toMatch(validWireName);
    expect(first.completion.toolCalls.map((call) => call.toolName)).toEqual(names);
    expect(second.completion.toolCalls.map((call) => call.toolName)).toEqual([...names].reverse());
  });

  it("does not promote duplicate offers of the same product name", async () => {
    const { provider, bodies } = setup(api);
    await request(provider, ["workspace.exec", "workspace.exec"]);
    expect(new Set(offeredNames(captured(bodies)))).toEqual(new Set(["workspace_exec"]));
  });

  it("shortens 200 character names and distinguishes a shared long prefix", async () => {
    const names = [longName, `${longName.slice(0, -1)}q`];
    expect(longName).toHaveLength(200);
    const { provider, bodies } = setup(api);
    const { completion } = await request(provider, names);
    const wires = offeredNames(captured(bodies));
    expect(wires).toEqual(
      names.map((name) => `${name.replaceAll(".", "_").slice(0, 55)}_${hash(name).slice(0, 8)}`)
    );
    expect(new Set(wires).size).toBe(2);
    for (const wire of wires) {
      expect(wire).toHaveLength(64);
      expect(wire).toMatch(validWireName);
    }
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual(names);
  });

  it.each([false, true])("round trips product names with stream=%s", async (stream) => {
    const names = ["workspace.exec", "a.b_c", "a_b.c", longName];
    const { provider, bodies } = setup(api);
    const { completion, events } = await request(provider, names, undefined, stream);
    expect(offeredNames(captured(bodies))[0]).toBe("workspace_exec");
    expect(completion.toolCalls).toEqual(
      names.map((toolName, index) => ({
        toolCallId: `call_${index}`,
        toolName,
        input: { ok: true }
      }))
    );
    if (stream) {
      expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual(
        names.map((toolName, index) => ({
          type: "tool_call_preparing",
          toolCallId: `call_${index}`,
          toolName
        }))
      );
    }
  });

  it.each([false, true])("passes unknown wire names through with stream=%s", async (stream) => {
    const unknown = "tool_d29ya3NwYWNlLmV4ZWM";
    const { provider, bodies } = setup(api, () => [unknown, "workspace.exec"]);
    const { completion, events } = await request(provider, ["workspace.exec"], undefined, stream);
    expect(offeredNames(captured(bodies))).toEqual(["workspace_exec"]);
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual([unknown, "workspace.exec"]);
    if (stream) {
      expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual(
        api === "chat_completions"
          ? []
          : [
              { type: "tool_call_preparing", toolCallId: "call_0", toolName: unknown },
              { type: "tool_call_preparing", toolCallId: "call_1", toolName: "workspace.exec" }
            ]
      );
    }
  });

  it("keeps names stable across repeated requests, unrelated additions and order changes", async () => {
    const { provider, bodies } = setup(api);
    for (const names of [
      ["workspace.exec"],
      ["workspace.exec"],
      ["workspace.exec", "storage.read"],
      ["storage.read", "workspace.exec"]
    ]) {
      await request(provider, names);
    }
    expect(bodies.map(offeredNames)).toEqual([
      ["workspace_exec"],
      ["workspace_exec"],
      ["workspace_exec", "storage_read"],
      ["storage_read", "workspace_exec"]
    ]);
  });

  it("uses offered collision names in history from the same table", async () => {
    const names = ["a.b_c", "a_b.c", longName];
    const { provider, bodies } = setup(api);
    await request(provider, names, history(names));
    const body = captured(bodies);
    expect(historyNames(body)).toEqual(offeredNames(body));
    expect(historyNames(body)[0]).toBe(`a_b_c_${hash(names[0] ?? "").slice(0, 8)}`);
  });

  it("maps removed history tools without offering them or changing offered names", async () => {
    const removed = ["workspace.exec", "a.b_c", longName];
    const { provider, bodies } = setup(api, historyNames);
    const { completion } = await request(provider, ["a_b_c"], history(removed));
    const body = captured(bodies);
    expect(offeredNames(body)).toEqual(["a_b_c"]);
    const wires = historyNames(body);
    expect(wires).toEqual([
      "workspace_exec",
      `a_b_c_${hash("a.b_c").slice(0, 8)}`,
      `${longName.replaceAll(".", "_").slice(0, 55)}_${hash(longName).slice(0, 8)}`
    ]);
    for (const wire of wires) expect(wire).toMatch(validWireName);
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual(wires);
  });

  it("replaces non ASCII and odd characters and hashes an empty name", async () => {
    const { provider, bodies } = setup(api);
    await request(provider, ["daten.prüfen", "x y/z", "", "😀.read"]);
    const wires = offeredNames(captured(bodies));
    expect(wires).toEqual(["daten_pr_fen", "x_y_z", hash("").slice(0, 8), "__read"]);
    for (const wire of wires) expect(wire).toMatch(validWireName);
  });

  it("promotes a plain name that collides with another group's level 1 name", async () => {
    const collisionName = `a_b_c_${hash("a.b_c").slice(0, 8)}`;
    const names = ["a.b_c", "a_b.c", collisionName];
    const { provider, bodies } = setup(api);
    await request(provider, names);
    await request(provider, [...names].reverse());
    const expected = [
      `t_${hash("a.b_c").slice(0, 62)}`,
      `a_b_c_${hash("a_b.c").slice(0, 8)}`,
      `${collisionName}_${hash(collisionName).slice(0, 8)}`
    ];
    expect(offeredNames(captured(bodies))).toEqual(expected);
    expect(offeredNames(captured(bodies, 1))).toEqual([...expected].reverse());
  });

  it("uses level 2 when distinct names share a base and a short hash", async () => {
    // These two punctuation variants have the same base and the same first eight hash digits.
    const names = [
      "a/b/b.b.b/b.b.b/b.b.b.b.b/b/b/b/b/b.b/b",
      "a.b.b.b.b/b.b/b/b/b/b.b/b.b/b/b/b/b.b/b"
    ];
    expect(hash(names[0] ?? "").slice(0, 8)).toBe(hash(names[1] ?? "").slice(0, 8));
    const { provider, bodies } = setup(api);
    const { completion } = await request(provider, names);
    await request(provider, [...names].reverse());
    const expected = names.map((name) => `t_${hash(name).slice(0, 62)}`);
    expect(offeredNames(captured(bodies))).toEqual(expected);
    expect(offeredNames(captured(bodies, 1))).toEqual([...expected].reverse());
    for (const wire of expected) expect(wire).toMatch(validWireName);
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual(names);
  });
});
