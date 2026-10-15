import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "@vivd-catalyst/config-schema";
import { assetSchema } from "@vivd-catalyst/api-contract";
import { createLogger } from "@vivd-catalyst/client-assembly";
import {
  asClientInstanceId,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject
} from "@vivd-catalyst/core";
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
