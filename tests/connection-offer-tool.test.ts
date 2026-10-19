import { describe, expect, it } from "vitest";
import { PLATFORM_TOOL_NAMES, platformModules } from "@work-shape/catalyst-client-assembly";
import {
  asClientInstanceId,
  createModuleRegistry,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import {
  CONNECTION_OFFER_TOOL_NAME,
  createConnectionOfferTool,
  ToolRegistry
} from "@work-shape/catalyst-tool-execution";

// The agent's offer of a Connection's approved tools to an agent (CS-5d): the tool answers the
// card and nothing else. It reads nothing of the instance and gives no tool: the person's
// confirmation on the card publishes the agent.

const tool = createConnectionOfferTool();

function context(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("connection-offer-client");
  return {
    clientInstanceId,
    correlationId: "corr_connection_offer",
    user: {
      id: "user-connection-offer",
      externalUserId: "user-connection-offer",
      displayLabel: "Offer User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

/** Runs the tool as the runtime does: the input through its schema. */
async function run(input: Record<string, unknown>) {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid" as const };
  return tool.execute(parsed.data, context());
}

describe("the offer of a Connection's tools to an agent", () => {
  it("answers the Connection and the agent the person named, for the card", async () => {
    const result = await run({ connection: " crm ", agent: "assistant" });
    expect(result).toMatchObject({
      status: "success",
      output: { connection: "crm", agent: "assistant" }
    });
    const without = await run({ connection: "crm" });
    expect(without).toMatchObject({ status: "success", output: { connection: "crm" } });
    if (without.status !== "success") return;
    expect(without.output).toEqual({ connection: "crm" });
    expect((await run({ connection: "" })).status).toBe("invalid");
  });

  it("is a reading tool: the person's confirmation is the only write", () => {
    expect(tool.effect).toBe("reading");
    expect(tool.title?.de).toBe("Tools einem Agenten anbieten");
    expect(tool.description).toContain("You never give tools yourself.");
  });

  it("is a tool of the module connections, which an agent lists by name", () => {
    const registryWith = (connections: boolean) =>
      new ToolRegistry({
        tools: [tool],
        enabledToolNames: new Set([CONNECTION_OFFER_TOOL_NAME]),
        modules: createModuleRegistry(platformModules).snapshot(
          Object.fromEntries(
            platformModules.map((module) => [
              module.name,
              { enabled: module.name !== "connections" || connections }
            ])
          )
        )
      });
    expect(registryWith(false).has(CONNECTION_OFFER_TOOL_NAME)).toBe(false);
    expect(registryWith(true).has(CONNECTION_OFFER_TOOL_NAME)).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain(CONNECTION_OFFER_TOOL_NAME);
  });
});
