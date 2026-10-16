import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  OpenAiCompatibleChatProvider,
  type ModelAdapterStreamEvent,
  type ModelCompletion,
  type ModelMessage
} from "@work-shape/catalyst-model-provider";
import { createTestToolRunner } from "./support/tool-runner";

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

function setupChatStream(chunks: unknown[]): OpenAiCompatibleChatProvider {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } }
        )
    )
  );
  return new OpenAiCompatibleChatProvider({
    id: "openai",
    api: "chat_completions",
    model: "test-model",
    baseUrl: "https://example.test/v1",
    apiKey: "test"
  });
}

interface ChatToolFragment {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

function chatChunk(toolCalls: ChatToolFragment[], finishReason?: string): unknown {
  return { choices: [{ delta: { tool_calls: toolCalls }, finish_reason: finishReason }] };
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
    expect(offeredNames(captured(bodies))).toEqual(["workspace_exec", "workspace_exec"]);
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

  it.each([false, true])("marks unknown wire names with stream=%s", async (stream) => {
    const names = ["a.b", "a_b"];
    const { provider, bodies } = setup(api, () => ["a_b"]);
    const { completion, events } = await request(provider, names, undefined, stream);
    expect(offeredNames(captured(bodies))).toEqual(
      names.map((name) => `a_b_${hash(name).slice(0, 8)}`)
    );
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual(["unknown:a_b"]);
    if (stream) {
      expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual(
        api === "chat_completions"
          ? []
          : [{ type: "tool_call_preparing", toolCallId: "call_0", toolName: "unknown:a_b" }]
      );
    }
  });

  it("dispatches an unknown wire name as not registered while the plain name runs", async () => {
    const ran: string[] = [];
    const tool = defineTool({
      name: "a_b",
      description: "Records that it ran.",
      effect: "reading",
      inputSchema: z.object({ ok: z.boolean() }),
      execute() {
        ran.push("a_b");
        return toolSuccess({ ran: true });
      }
    });
    const registry = new ToolRegistry({ tools: [tool] });
    const runTool = createTestToolRunner({ registry, getAgentToolNames: () => ["a_b"] });
    const clientInstanceId = asClientInstanceId("tool-names-test");
    const context: ToolExecutionContext = {
      clientInstanceId,
      correlationId: "corr_tool_names",
      user: {
        id: "user-1",
        externalUserId: "user-1",
        displayLabel: "User",
        roles: ["user"],
        permissionRefs: [],
        clientInstanceId,
        authSource: "test"
      }
    };
    const { provider } = setup(api, () => ["a_b"]);
    const { completion } = await request(provider, ["a.b", "a_b"]);
    const call = completion.toolCalls[0];
    if (!call) throw new Error("Provider returned no tool call");
    const dispatch = (toolName: string) =>
      runTool(
        {
          toolName,
          input: call.input,
          toolCallId: asToolCallId(call.toolCallId),
          agentRunId: asAgentRunId("run_tool_names"),
          conversationId: asConversationId("conv_tool_names"),
          agentName: "test_agent"
        },
        context
      );
    expect(await dispatch(call.toolName)).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: "Tool 'unknown:a_b' is not registered" }
    });
    expect(ran).toEqual([]);
    expect(await dispatch("a_b")).toMatchObject({ status: "success", output: { ran: true } });
    expect(ran).toEqual(["a_b"]);
    expect(() => new ToolRegistry({ tools: [{ ...tool, name: "unknown:a_b" }] })).toThrow(
      "must start with a letter and contain only letters, numbers, dots, underscores, or hyphens"
    );
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

  // Check 54 of apps-and-pages: a stored conversation whose history calls a former tool name
  // continues, with only the new names offered. Fails where a call of a tool no longer offered
  // is sent under no name the provider accepts.
  it("continues a conversation whose history calls page.save while workspace.open is offered", async () => {
    const { provider, bodies } = setup(api);
    const { completion } = await request(
      provider,
      ["workspace.open", "app.save"],
      history(["page.save", "page.save_as_app"])
    );
    const body = captured(bodies);
    expect(offeredNames(body)).toEqual(["workspace_open", "app_save"]);
    expect(historyNames(body)).toEqual(["page_save", "page_save_as_app"]);
    for (const name of historyNames(body)) expect(name).toMatch(validWireName);
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual([
      "workspace.open",
      "app.save"
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
    expect(completion.toolCalls.map((call) => call.toolName)).toEqual(
      wires.map((wire) => `unknown:${wire}`)
    );
  });

  it.each([2, 3, 5])(
    "avoids %s occupied history name candidates deterministically",
    async (count) => {
      const removed = "a.b";
      const candidates = [
        "a_b",
        `a_b_${hash(removed).slice(0, 8)}`,
        `t_${hash(removed).slice(0, 62)}`,
        `t_${hash(`${removed}#1`).slice(0, 62)}`,
        `t_${hash(`${removed}#2`).slice(0, 62)}`
      ];
      const offered = candidates.slice(0, count);
      const { provider, bodies } = setup(api);
      await request(provider, offered, history([removed]));
      await request(provider, offered, history([removed]));
      const body = captured(bodies);
      const wires = historyNames(body);
      expect(offeredNames(body)).toEqual(offered);
      expect(wires).toEqual([
        count === 2
          ? `t_${hash(removed).slice(0, 62)}`
          : `t_${hash(`${removed}#${count - 2}`).slice(0, 62)}`
      ]);
      for (const wire of wires) {
        expect(wire).toMatch(validWireName);
        expect(offeredNames(body)).not.toContain(wire);
      }
      expect(historyNames(captured(bodies, 1))).toEqual(wires);
    }
  );

  it("serializes a marked unknown name in history as a free valid wire name", async () => {
    const marked = "unknown:a_b";
    const { provider, bodies } = setup(api);
    await request(provider, ["a.b", "a_b"], history([marked]));
    expect(historyNames(captured(bodies))).toEqual(["unknown_a_b"]);
    await request(provider, ["unknown_a_b"], history([marked]));
    expect(historyNames(captured(bodies, 1))).toEqual([`unknown_a_b_${hash(marked).slice(0, 8)}`]);
    const offered = [
      "unknown_a_b",
      `unknown_a_b_${hash(marked).slice(0, 8)}`,
      `t_${hash(marked).slice(0, 62)}`
    ];
    await request(provider, offered, history([marked]));
    const wires = historyNames(captured(bodies, 2));
    expect(wires).toEqual([`t_${hash(`${marked}#1`).slice(0, 62)}`]);
    for (const wire of wires) {
      expect(wire).toMatch(validWireName);
      expect(offered).not.toContain(wire);
    }
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

describe("Fragmented chat completion tool names", () => {
  it("announces a repeated whole name once and completes with its parsed input", async () => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, id: "call_0", function: { name: "workspace_exec", arguments: "" } }]),
      chatChunk([{ index: 0, function: { name: "workspace_exec", arguments: '{"command":' } }]),
      chatChunk([{ index: 0, function: { name: "workspace_exec", arguments: '"pwd"}' } }])
    ]);
    const { completion, events } = await request(provider, ["workspace.exec"], undefined, true);
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_preparing", toolCallId: "call_0", toolName: "workspace.exec" },
      { type: "tool_call_input_delta", delta: '{"command":' },
      { type: "tool_call_input_delta", delta: '"pwd"}' }
    ]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "workspace.exec", input: { command: "pwd" } }
    ]);
  });

  it("announces parallel repeated names once in index order before their input deltas", async () => {
    const provider = setupChatStream([
      chatChunk([
        { index: 0, id: "call_0", function: { name: "workspace_exec", arguments: "" } },
        { index: 1, id: "call_1", function: { name: "storage_read", arguments: "" } }
      ]),
      chatChunk([
        { index: 1, function: { name: "storage_read", arguments: '{"path":' } },
        { index: 0, function: { name: "workspace_exec", arguments: '{"command":' } }
      ]),
      chatChunk([
        { index: 0, function: { name: "workspace_exec", arguments: '"pwd"}' } },
        { index: 1, function: { name: "storage_read", arguments: '"file"}' } }
      ])
    ]);
    const { completion, events } = await request(
      provider,
      ["workspace.exec", "storage.read"],
      undefined,
      true
    );
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_preparing", toolCallId: "call_0", toolName: "workspace.exec" },
      { type: "tool_call_preparing", toolCallId: "call_1", toolName: "storage.read" },
      { type: "tool_call_input_delta", delta: '{"path":' },
      { type: "tool_call_input_delta", delta: '{"command":' },
      { type: "tool_call_input_delta", delta: '"pwd"}' },
      { type: "tool_call_input_delta", delta: '"file"}' }
    ]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "workspace.exec", input: { command: "pwd" } },
      { toolCallId: "call_1", toolName: "storage.read", input: { path: "file" } }
    ]);
  });

  it.each([
    { names: ["aa"], expectedName: "aa" },
    { names: ["a"], expectedName: "a" },
    { names: ["a", "aa"], expectedName: "a" }
  ])("settles a, a as $expectedName with offers $names", async ({ names, expectedName }) => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, id: "call_0", function: { name: "a", arguments: "" } }]),
      chatChunk([{ index: 0, function: { name: "a" } }]),
      chatChunk([{ index: 0, function: { arguments: '{"ok":true}' } }])
    ]);
    const { completion, events } = await request(provider, names, undefined, true);
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_preparing", toolCallId: "call_0", toolName: expectedName },
      { type: "tool_call_input_delta", delta: '{"ok":true}' }
    ]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: expectedName, input: { ok: true } }
    ]);
  });

  it.each([
    { name: "abab", pieces: ["ab", "ab"] },
    { name: "ababc", pieces: ["ab", "ab", "c"] }
  ])(
    "keeps equal fragments when only the joined name $name is offered",
    async ({ name, pieces }) => {
      const provider = setupChatStream([
        ...pieces.map((piece, index) =>
          chatChunk([
            { index: 0, ...(index === 0 ? { id: "call_0" } : {}), function: { name: piece } }
          ])
        ),
        chatChunk([{ index: 0, function: { arguments: '{"ok":true}' } }])
      ]);
      const { completion, events } = await request(provider, [name], undefined, true);
      expect(events.slice(0, -1)).toEqual([
        { type: "tool_call_preparing", toolCallId: "call_0", toolName: name },
        { type: "tool_call_input_delta", delta: '{"ok":true}' }
      ]);
      expect(completion.toolCalls).toEqual([
        { toolCallId: "call_0", toolName: name, input: { ok: true } }
      ]);
    }
  );

  it("marks an unknown repeated name once without announcing it", async () => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, id: "call_0", function: { name: "zz", arguments: "" } }]),
      chatChunk([{ index: 0, function: { name: "zz", arguments: '{"ok":true}' } }])
    ]);
    const { completion, events } = await request(provider, ["workspace.exec"], undefined, true);
    expect(events.slice(0, -1)).toEqual([{ type: "tool_call_input_delta", delta: '{"ok":true}' }]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "unknown:zz", input: { ok: true } }
    ]);
  });

  it.each([["workspace.exec"], ["workspace", "workspace.exec"]])(
    "waits for the complete name with offers %j",
    async (...names) => {
      const first = names.length === 1 ? "workspace_" : "workspace";
      const second = names.length === 1 ? "exec" : "_exec";
      const provider = setupChatStream([
        chatChunk([{ index: 0, id: "call_0", function: { name: first, arguments: "" } }]),
        chatChunk([{ index: 0, function: { name: second } }]),
        { choices: [{ delta: { content: "waiting for arguments" } }] },
        chatChunk([{ index: 0, function: { arguments: '{"command":' } }]),
        chatChunk([{ index: 0, function: { arguments: '"pwd"}' } }])
      ]);
      const { completion, events } = await request(provider, names, undefined, true);
      expect(events.slice(0, -1)).toEqual([
        { type: "text_delta", delta: "waiting for arguments" },
        { type: "tool_call_preparing", toolCallId: "call_0", toolName: "workspace.exec" },
        { type: "tool_call_input_delta", delta: '{"command":' },
        { type: "tool_call_input_delta", delta: '"pwd"}' }
      ]);
      expect(events.at(-1)?.type).toBe("completed");
      expect(completion.toolCalls).toEqual([
        { toolCallId: "call_0", toolName: "workspace.exec", input: { command: "pwd" } }
      ]);
    }
  );

  it("announces parallel fragmented names once in index order before their input deltas", async () => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, function: { name: "workspace_" } }]),
      chatChunk([{ index: 0, function: { name: "exec" } }]),
      chatChunk([{ index: 1, function: { name: "storage_" } }]),
      chatChunk([{ index: 1, function: { name: "read" } }]),
      chatChunk([
        { index: 1, id: "call_1", function: { arguments: '{"path":' } },
        { index: 0, id: "call_0", function: { arguments: '{"command":' } }
      ]),
      chatChunk([
        { index: 0, function: { arguments: '"pwd"}' } },
        { index: 1, function: { arguments: '"file"}' } }
      ])
    ]);
    const { completion, events } = await request(
      provider,
      ["workspace.exec", "storage.read"],
      undefined,
      true
    );
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_preparing", toolCallId: "call_0", toolName: "workspace.exec" },
      { type: "tool_call_preparing", toolCallId: "call_1", toolName: "storage.read" },
      { type: "tool_call_input_delta", delta: '{"path":' },
      { type: "tool_call_input_delta", delta: '{"command":' },
      { type: "tool_call_input_delta", delta: '"pwd"}' },
      { type: "tool_call_input_delta", delta: '"file"}' }
    ]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "workspace.exec", input: { command: "pwd" } },
      { toolCallId: "call_1", toolName: "storage.read", input: { path: "file" } }
    ]);
  });

  it("marks a fragmented unknown name without announcing it", async () => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, id: "call_0", function: { name: "a_" } }]),
      chatChunk([{ index: 0, function: { name: "b" } }]),
      chatChunk([{ index: 0, function: { arguments: '{"ok":true}' } }])
    ]);
    const { completion, events } = await request(provider, ["a.b", "a_b"], undefined, true);
    expect(events.slice(0, -1)).toEqual([{ type: "tool_call_input_delta", delta: '{"ok":true}' }]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "unknown:a_b", input: { ok: true } }
    ]);
  });

  it.each(["later index", "finish reason", "completion marker"])(
    "announces names without arguments at the %s",
    async (boundary) => {
      const chunks = [
        chatChunk([{ index: 0, id: "call_0", function: { name: "workspace" } }]),
        chatChunk([{ index: 0, function: { name: "_exec" } }])
      ];
      if (boundary === "later index") {
        chunks.push(
          chatChunk([
            { index: 1, id: "call_1", function: { name: "storage_read", arguments: "{}" } }
          ])
        );
      } else if (boundary === "finish reason") {
        chunks.push({ choices: [{ finish_reason: "tool_calls" }] });
        chunks.push({ choices: [{ delta: { content: "after finish" } }] });
      }
      const provider = setupChatStream(chunks);
      const { completion, events } = await request(
        provider,
        ["workspace", "workspace.exec", "storage.read"],
        undefined,
        true
      );
      expect(events[0]).toEqual({
        type: "tool_call_preparing",
        toolCallId: "call_0",
        toolName: "workspace.exec"
      });
      expect(events.filter((event) => event.type === "tool_call_preparing")).toHaveLength(
        boundary === "later index" ? 2 : 1
      );
      expect(events.at(-1)?.type).toBe("completed");
      expect(completion.toolCalls[0]).toEqual({
        toolCallId: "call_0",
        toolName: "workspace.exec",
        input: {}
      });
    }
  );

  it("concatenates a late name fragment without announcing the index twice", async () => {
    const provider = setupChatStream([
      chatChunk([{ index: 0, id: "call_0", function: { name: "workspace", arguments: "{" } }]),
      chatChunk([{ index: 0, function: { name: "_exec", arguments: '"ok":true}' } }])
    ]);
    const { completion, events } = await request(
      provider,
      ["workspace", "workspace.exec"],
      undefined,
      true
    );
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_call_preparing", toolCallId: "call_0", toolName: "workspace" },
      { type: "tool_call_input_delta", delta: "{" },
      { type: "tool_call_input_delta", delta: '"ok":true}' }
    ]);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "call_0", toolName: "workspace.exec", input: { ok: true } }
    ]);
  });
});
