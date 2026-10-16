import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "@work-shape/catalyst-config-schema";
import { assetSchema } from "@work-shape/catalyst-api-contract";
import { createLogger } from "@work-shape/catalyst-client-assembly";
import {
  asClientInstanceId,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject
} from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance } from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";

const clientInstanceId = asClientInstanceId("demo-local");
const base: JsonObject = {
  name: "test_agent",
  displayName: "Stored agent",
  instructions: "Help.",
  modelProviderId: "local",
  toolNames: ["read_skill", "missing_tool"],
  skillNames: ["known_skill", "missing_skill"]
};

function config() {
  const value = createTestConfig({ tools: [{ name: "read_skill" }] });
  value.modules = { assetManagement: { enabled: true } };
  value.administration.agentConfiguration.allowAgentCreation = true;
  value.administration.agentConfiguration.allowSkillEditing = true;
  value.administration.agentConfiguration.editableAgentFields = [
    "displayName",
    "toolNames",
    "skillNames"
  ];
  return value;
}

const start = (seedAssets = false) =>
  createTestInstance({ config: config(), env: {}, tools: [], seedAssets });

function storedConfig(agent: JsonObject): JsonObject {
  const value = unknownToJsonValue(agentConfigSchema.parse(agent));
  if (!isJsonObject(value)) throw new Error("Expected agent config");
  return value;
}

async function storeAgents(agents: JsonObject[]) {
  const first = await start(true);
  await applyAtCurrentRevisions(first.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "skill",
        name: "known_skill",
        config: {
          name: "known_skill",
          title: "Known",
          description: "Known skill",
          content: "Help."
        }
      },
      ...agents.map((agent) => ({
        type: "upsert" as const,
        kind: "agent",
        name: String(agent.name),
        config: storedConfig(agent)
      }))
    ]
  });
  await first.close();
}

const read = async (instance: Awaited<ReturnType<typeof start>>, name = "test_agent") => {
  const response = await instance.call("assets.get", { params: { kind: "agent", name } });
  expect(response.statusCode, response.body).toBe(200);
  return assetSchema.parse(response.json());
};

afterEach(() => vi.restoreAllMocks());

describe("stored agents with unavailable references", () => {
  it("starts ready, runs the remaining tools and skills, reports reasons and warns once per start", async () => {
    await storeAgents([base]);
    const warn = vi.spyOn(createLogger(), "warn");
    let instance = await start();
    expect((await instance.call("ready.get")).statusCode).toBe(200);
    expect(await read(instance)).toMatchObject({
      config: base,
      chatAvailable: true,
      unavailableTools: [{ name: "missing_tool", reason: "unknown_tool" }],
      unavailableSkills: [{ name: "missing_skill", reason: "unknown_skill" }],
      unavailableModels: []
    });
    const created = await instance.call("conversations.create", {
      payload: { title: "Degraded agent" }
    });
    const conversationId = created.json<{ id: string }>().id;
    const started = await injectStartConversationRun(
      instance,
      conversationId,
      '/tool read_skill {"name":"known_skill"}'
    );
    const events = await drainRunEvents(instance, conversationId, started.run.id);
    expect(events).toContain("known_skill");
    expect(events).not.toContain("Tool 'read_skill' is not available");
    const unavailable = await injectStartConversationRun(
      instance,
      conversationId,
      "/tool missing_tool {}"
    );
    expect(await drainRunEvents(instance, conversationId, unavailable.run.id)).toContain(
      "Tool 'missing_tool' is not available"
    );
    await read(instance);
    const warnings = () =>
      warn.mock.calls.filter(
        ([, message]) => message === "Stored agent references unavailable items"
      );
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.[0]).toMatchObject({
      agentName: "test_agent",
      unavailableTools: [{ name: "missing_tool", reason: "unknown_tool" }]
    });
    await instance.close();
    instance = await start();
    expect((await instance.call("ready.get")).statusCode).toBe(200);
    expect(warnings()).toHaveLength(2);
  });

  // Check 54 of apps-and-pages: a release config and a stored agent that name a former tool name
  // start, with a warning that names the new name. Fails without the former names: the agent
  // reported 'page.save' as an unknown tool, and nothing named 'workspace.open'.
  it("starts ready with a former tool name in the release and a stored agent, and warns with the new name", async () => {
    const former = { ...base, toolNames: ["read_skill", "page.save"], skillNames: [] };
    await storeAgents([former]);
    const release = config();
    release.tools = [...release.tools, { name: "page.save", enabled: true, config: {} }];
    const warn = vi.spyOn(createLogger(), "warn");
    const instance = await createTestInstance({ config: release, env: {}, tools: [] });
    try {
      expect((await instance.call("ready.get")).statusCode).toBe(200);
      expect(await read(instance)).toMatchObject({ unavailableTools: [] });
      const messages = warn.mock.calls.map((call) => call.find((part) => typeof part === "string"));
      expect(messages).toEqual(
        expect.arrayContaining([
          "The release config names the tool 'page.save', which is now 'workspace.open'. Rename it: a later release refuses 'page.save'.",
          "Agent 'test_agent' names the tool 'page.save', which is now 'workspace.open'. Rename it: a later release refuses 'page.save'."
        ])
      );
    } finally {
      await instance.close();
    }
  });

  it.each(["web_off", "search_off", "pricing_removed", "unsupported_model"] as const)(
    "starts ready with stored web_search unavailable when %s, while writes remain strict",
    async (cause) => {
      const stored = { ...base, toolNames: ["web_search"], skillNames: [] };
      await storeAgents([stored]);
      const release = config();
      release.tools = [{ name: "web_search", enabled: true, config: {} }];
      release.webAccess.enabled = cause !== "web_off";
      release.webAccess.search.enabled = cause !== "search_off";
      if (cause !== "unsupported_model") {
        release.infrastructure.models.local = {
          provider: "openai-compatible",
          api: "responses",
          model: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          credentialSecret: "OPENAI_API_KEY",
          region: "global"
        };
      }
      release.usage.costs.customer = {
        id: "customer",
        version: "1",
        currency: "EUR",
        models: [],
        webSearch: cause === "pricing_removed" ? [] : [{ providerId: "local", pricePerCall: 0.01 }]
      };
      const warn = vi.spyOn(createLogger(), "warn");
      const instance = await createTestInstance({
        config: release,
        env: { OPENAI_API_KEY: "test-key" },
        tools: [],
        seedAssets: false
      });
      expect((await instance.call("ready.get")).statusCode).toBe(200);
      expect(await read(instance)).toMatchObject({
        config: stored,
        chatAvailable: true,
        unavailableTools: [{ name: "web_search", reason: "unknown_tool" }]
      });
      expect(
        warn.mock.calls.filter(
          ([, message]) => message === "Stored agent references unavailable items"
        )
      ).toHaveLength(1);
      const write = await instance.call("assets.put", {
        params: { kind: "agent", name: "test_agent" },
        payload: { config: { ...stored, displayName: "Changed" }, expectedRevision: 2 }
      });
      expect(write.statusCode, write.body).toBe(422);
      expect((await read(instance)).config).toEqual(storedConfig(stored));
    }
  );

  it.each(["modelProviderId", "modelBindingId"] as const)(
    "keeps a missing %s readable, excludes it from chat and uses the remaining default",
    async (field) => {
      const { modelProviderId: _provider, ...rest } = base;
      const missing = { ...rest, [field]: "removed_model" };
      await storeAgents([
        missing,
        { ...base, name: "working_agent", toolNames: [], skillNames: [] }
      ]);
      const warn = vi.spyOn(createLogger(), "warn");
      const instance = await start();
      expect((await instance.call("ready.get")).statusCode).toBe(200);
      expect(await read(instance)).toMatchObject({
        config: missing,
        chatAvailable: false,
        unavailableModels: [{ name: "removed_model", field, reason: "unknown_model" }]
      });
      const created = await instance.call("conversations.create", {
        payload: { title: "Default" }
      });
      const id = created.json<{ id: string }>().id;
      const refused = await instance.call("conversations.runs.start", {
        params: { conversationId: id },
        payload: {
          idempotencyKey: "missing-model",
          message: { text: "Help" },
          agentName: "test_agent"
        }
      });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      const started = await injectStartConversationRun(instance, id, "Hello");
      expect(await drainRunEvents(instance, id, started.run.id)).not.toContain("removed_model");
      expect(
        warn.mock.calls.filter(
          ([, message]) => message === "Stored agent references unavailable items"
        )
      ).toHaveLength(1);
    }
  );

  it("is ready with no runnable agents when the only agent has a missing primary model", async () => {
    await storeAgents([{ ...base, modelProviderId: "removed_model" }]);
    const instance = await start();
    expect((await instance.call("ready.get")).statusCode).toBe(200);
    expect(await read(instance)).toMatchObject({ chatAvailable: false });
  });

  it("refuses creating or changing agents with missing references, while allowing repairs and unrelated writes", async () => {
    await storeAgents([base]);
    const instance = await start();
    for (const extra of [
      { toolNames: ["missing_tool"], skillNames: [] },
      { toolNames: ["read_skill"], skillNames: ["missing_skill"] },
      { toolNames: [], skillNames: [], modelProviderId: "removed_model" },
      { toolNames: [], skillNames: [], modelProviderId: undefined, modelBindingId: "removed_model" }
    ]) {
      for (const name of ["test_agent", "new_agent"]) {
        const response = await instance.call("assets.put", {
          params: { kind: "agent", name },
          payload: {
            config: { ...base, ...extra, name, displayName: "Changed" },
            expectedRevision: name === "test_agent" ? 2 : null
          }
        });
        expect(response.statusCode, response.body).toBe(422);
      }
    }
    const unrelated = await instance.call("assets.put", {
      params: { kind: "skill", name: "another_skill" },
      payload: {
        config: {
          name: "another_skill",
          title: "Another",
          description: "Another skill",
          content: "Help."
        },
        expectedRevision: null
      }
    });
    expect(unrelated.statusCode, unrelated.body).toBe(200);
    const repaired = await instance.call("assets.put", {
      params: { kind: "agent", name: "test_agent" },
      payload: {
        config: { ...base, toolNames: ["read_skill"], skillNames: ["known_skill"] },
        expectedRevision: 2
      }
    });
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(await read(instance)).toMatchObject({
      chatAvailable: true,
      unavailableTools: [],
      unavailableSkills: [],
      unavailableModels: []
    });
  });
});
