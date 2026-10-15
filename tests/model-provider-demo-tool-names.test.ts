import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isDataToolName } from "@work-shape/catalyst-core";
import { OpenAiCompatibleChatProvider } from "@work-shape/catalyst-model-provider";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** What an OpenAI-compatible provider accepts as the name of a function. */
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;

const requestSchema = z.object({
  tools: z.array(z.object({ type: z.string(), name: z.string().optional() }))
});

/** The tool names of the demo's agent, as its working copy lists them. */
function agentToolNames(): string[] {
  const text = readFileSync(
    resolve(root, "clients/demo/agents/workflow-assistant.agent.yaml"),
    "utf8"
  );
  const list = /^toolNames:\n((?: {2}- \S+\n)+)/mu.exec(text)?.[1] ?? "";
  return Array.from(list.matchAll(/^ {2}- (\S+)$/gmu), (match) => match[1] ?? "");
}

afterEach(() => vi.unstubAllGlobals());

describe("the tools of the demo's agent on the way to the model", () => {
  it("sends every tool of the agent to the model under a name the provider accepts", async () => {
    const names = agentToolNames();
    // The six tools of the Connection are among them, with the longest names the agent has.
    expect(names.filter(isDataToolName)).toHaveLength(6);
    const bodies: z.infer<typeof requestSchema>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = requestSchema.parse(JSON.parse(String(init?.body)));
        bodies.push(body);
        // The model answers with one call of every tool it was offered.
        const output = body.tools
          .filter((tool) => tool.type === "function")
          .map((tool, index) => ({
            type: "function_call",
            call_id: `call_${index}`,
            name: tool.name,
            arguments: "{}"
          }));
        return new Response(JSON.stringify({ output }), {
          headers: { "content-type": "application/json" }
        });
      })
    );
    // The demo's own provider entry speaks the responses format.
    const provider = new OpenAiCompatibleChatProvider({
      id: "openai",
      api: "responses",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test"
    });
    const completion = await provider.complete(
      {
        providerId: "openai",
        model: "test-model",
        tools: names.map((name) => ({ name, description: name })),
        messages: [{ role: "user", content: "Run tools" }]
      },
      {}
    );
    const offered = (bodies[0]?.tools ?? [])
      .filter((tool) => tool.type === "function")
      .map((tool) => tool.name ?? "");
    expect(offered).toHaveLength(names.length);
    expect(new Set(offered).size).toBe(names.length);
    for (const name of offered) expect(name).toMatch(WIRE_NAME);
    // Readable: the product name with every other character as an underscore, and no hash
    // tail, because none of the agent's names is longer than the provider allows.
    expect(offered).toEqual(names.map((name) => name.replace(/[^a-zA-Z0-9_-]/gu, "_")));
    expect(offered).toContain("connection_sample-business_revenue_by_month");
    expect(offered).toContain("workspace_exec");
    // Each name comes back as the product name it was sent for.
    expect(completion.toolCalls?.map((call) => call.toolName)).toEqual(names);
  });
});
