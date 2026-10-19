import { describe, expect, it, vi } from "vitest";
import {
  createPlatformTools,
  platformModules,
  PLATFORM_TOOL_NAMES
} from "@work-shape/catalyst-client-assembly";
import {
  createModuleRegistry,
  createPlatformId,
  asConversationId,
  type ConversationId,
  type DataToolDescriptor
} from "@work-shape/catalyst-core";
import { createToolOperationRunner, ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { required } from "./support/assertions";

const verbs = ["describe", "query", "preview_rows", "insert", "update", "delete_rows"];
const names = verbs.map((verb) => `data_store.findings.${verb}`);

describe("a conversation about a Data Store offers its own tools", () => {
  const { start, publishStore, put, person } = useDataStoreInstance();
  async function setup(ready = true) {
    const world = await start(true, "allow");
    if (ready) await publishStore(world);
    else expect((await put(world)).statusCode).toBe(200);
    const source = required(world.execution.modulesStarted.dataToolSources[0]);
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => source
    });
    platform.registry(platform.tools, new Set());
    const created = await world.api.call("conversations.create", {
      payload: { title: "Holiday requests", subject: { kind: "data_store", name: "findings" } }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = asConversationId(created.json<{ id: string }>().id);
    const offer = (
      conversationId: ConversationId,
      agentToolNames: readonly string[] = PLATFORM_TOOL_NAMES
    ) => platform.conversationOffer.offerOf({ clientInstanceId, conversationId, agentToolNames });
    return { world, source, platform, conversationId, offer };
  }

  it("offers the six published-store tools, and insert dispatch reads this conversation's offer", async () => {
    const { world, source, conversationId, offer } = await setup();
    const listing = vi.spyOn(world.execution.store.dataStores, "listDataStores");
    expect(
      (await offer(conversationId))?.toolNames.filter((name) => name.startsWith("data_store."))
    ).toEqual(names);
    expect(listing).not.toHaveBeenCalled();
    listing.mockRestore();
    const actor = await person(world, "subject-admin", ["user", "admin", "superadmin"]);
    const deps = {
      ...world.execution.operationCalls.deps,
      agentToolNames: async (_name: string, id?: ConversationId) =>
        id
          ? [...PLATFORM_TOOL_NAMES, ...((await offer(id))?.toolNames ?? [])]
          : [...PLATFORM_TOOL_NAMES]
    };
    const runTool = createToolOperationRunner(deps, new ToolRegistry({ tools: [] }), { source });
    const answer = await runTool(
      {
        toolName: "data_store.findings.insert",
        toolCallId: createPlatformId("tc"),
        agentRunId: createPlatformId("agr"),
        conversationId,
        agentName: "platform",
        input: {
          table: "findings",
          rows: [
            {
              run_id: "holiday",
              client_id: "Alex",
              rule_id: "holiday",
              revision: 1,
              severity: "info"
            }
          ]
        }
      },
      { clientInstanceId, correlationId: "subject-store", user: actor }
    );
    expect(answer, JSON.stringify(answer)).toMatchObject({
      status: "success",
      output: { table: "findings", inserted: 1, skipped: 0 }
    });
    const stored = await world.api.call("data_stores.query", {
      params: { store: "findings" },
      payload: { sql: "select client_id from findings" }
    });
    expect(stored.json()).toMatchObject({ rows: [{ client_id: "Alex" }] });
  });

  it("offers none for a draft subject", async () => {
    const draft = await setup(false);
    expect(
      (await draft.offer(draft.conversationId))?.toolNames.filter((name) =>
        name.startsWith("data_store.")
      )
    ).toEqual([]);
  });

  it("offers none for an agent without platform tools or an App subject", async () => {
    const ready = await setup();
    expect(
      (await ready.offer(ready.conversationId, []))?.toolNames.filter((name) =>
        name.startsWith("data_store.")
      )
    ).toEqual([]);
    // Changing just the conversation's subject must drop every store tool.
    const other = createPlatformTools({
      stores: {
        conversations: {
          getConversation: async () => ({
            ...required(
              await ready.world.stores.conversations.getConversation(
                clientInstanceId,
                ready.conversationId
              )
            ),
            subject: { kind: "app", name: "holidays" }
          })
        }
      },
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ready.source
    });
    other.registry(other.tools, new Set());
    const offered = await other.conversationOffer.offerOf({
      clientInstanceId,
      conversationId: ready.conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offered?.toolNames.filter((name) => name.startsWith("data_store."))).toEqual([]);
  });

  it("omits a subject-store tool whose policy denies it", async () => {
    const { world, source, conversationId } = await setup();
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ({
        describe: async (names, scope) =>
          (await source.describe(names, scope)).map((tool): DataToolDescriptor =>
            tool.name.endsWith(".insert") ? { ...tool, permission: { mode: "deny" } } : tool
          )
      })
    });
    platform.registry(platform.tools, new Set());
    const offer = await platform.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer?.toolNames).not.toContain("data_store.findings.insert");
    expect(offer?.toolNames).toContain("data_store.findings.update");
  });
  it("uses the ordinary policy resolution when a central setting denies a subject tool", async () => {
    const { world, source, conversationId } = await setup();
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => source,
      policy: {
        instanceDefaults: { reading: "allow", changing: "confirm" },
        centralSettings: () => [{ operation: "data_store.findings.update", value: "deny" }]
      }
    });
    platform.registry(platform.tools, new Set());
    const offer = await platform.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer?.toolNames).not.toContain("data_store.findings.update");
    expect(offer?.toolNames).toContain("data_store.findings.insert");
    expect(offer?.toolNames).toContain("data_store.findings.delete_rows");
  });

  it("offers no row tools when their source cannot be described", async () => {
    const { world, conversationId } = await setup();
    const platform = createPlatformTools({
      stores: world.stores,
      modules: createModuleRegistry(platformModules).snapshot({ dataStores: { enabled: true } }),
      dataTools: () => ({
        describe: async () => {
          throw new Error("Unavailable synthetic source");
        }
      })
    });
    platform.registry(platform.tools, new Set());
    const offer = await platform.conversationOffer.offerOf({
      clientInstanceId,
      conversationId,
      agentToolNames: PLATFORM_TOOL_NAMES
    });
    expect(offer?.toolNames.filter((name) => name.startsWith("data_store."))).toEqual([]);
  });
});
