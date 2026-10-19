import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import {
  asAgentRunId,
  asClientInstanceId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { required, waitUntil } from "./support/assertions";
import { injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createToolCallingModel, TOOL_CALLING_MODEL_PROVIDER } from "./support/held-model";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";

// Real tool -> policy -> pause -> Allow -> persisted revision, with no model service.
// An HR name prefix never changes the workspace that owns the saved asset.
describe("live first saves from the Build Agent (ACCEPT-FIX-5)", () => {
  let app: TestInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function fixture(
    settings: CentralPolicySetting[],
    roles = ["user", "admin", "superadmin"],
    creationAllowed = true
  ) {
    const model = createToolCallingModel();
    const config = createTestConfig({
      toolNames: [...PLATFORM_TOOL_NAMES],
      modelBindings: [{ id: "primary", providerId: "local", model: "local" }],
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [
          {
            id: "owner",
            externalUserId: "owner",
            displayLabel: "Owner",
            roles
          }
        ]
      }
    });
    config.modules.assetManagement = { enabled: true };
    config.administration.agentConfiguration.enabled = true;
    config.administration.agentConfiguration.allowAgentCreation = creationAllowed;
    config.administration.agentConfiguration.editableAgentFields = [
      "displayName",
      "instructions",
      "toolNames",
      "skillNames",
      "initialPrompts"
    ];
    config.administration.agentConfiguration.allowSkillEditing = true;
    config.infrastructure.models = {
      local: { provider: TOOL_CALLING_MODEL_PROVIDER, model: "local" }
    };
    const instance = await createTestInstance({
      config,
      env: {},
      tools: [],
      capabilities: [model.capability],
      operations: { centralPolicySettings: () => settings }
    });
    app = instance;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    const created = await instance.call("conversations.create", { payload: { title: "Build" } });
    expect(created.statusCode, created.body).toBe(200);
    const conversation = z
      .object({ id: z.string(), collaborationWorkspaceId: z.string() })
      .parse(created.json());
    return { instance, clientInstanceId, conversation };
  }

  it.each<{
    name: string;
    extra: Record<string, unknown>;
    expected: string;
    status: string;
    creationAllowed?: boolean;
    omitConfig?: boolean;
  }>([
    {
      name: "missing-config",
      extra: {},
      expected: "config definition",
      status: "failed",
      omitConfig: true
    },
    {
      name: "creation-disabled",
      extra: {},
      expected: "creation is disabled",
      status: "failed",
      creationAllowed: false
    },
    {
      name: "copied-model",
      extra: { modelBindingId: "primary" },
      expected: "agent_models.manage",
      status: "denied"
    },
    {
      name: "skill-without-reader",
      extra: { skillNames: ["platform-docs"] },
      expected: "invalid",
      status: "failed"
    },
    {
      name: "invalid-instructions",
      extra: { instructions: [] },
      expected: "invalid",
      status: "failed"
    },
    {
      name: "invalid-tool",
      extra: { toolNames: ["tool_that_does_not_exist"] },
      expected: "invalid",
      status: "failed"
    }
  ])(
    "refuses $name before offering Allow",
    async ({ name, extra, expected, status, creationAllowed = true, omitConfig = false }) => {
      const t = await fixture([], ["user", "admin"], creationAllowed);
      const config = {
        name,
        displayName: "Protocol writer",
        instructions: "Write minutes.",
        toolNames: [],
        skillNames: [],
        ...extra
      };
      const started = await injectStartConversationRun(
        t.instance,
        t.conversation.id,
        `/tool platform.assets.put ${JSON.stringify({ kind: "agent", name, ...(omitConfig ? {} : { config }) })}`
      );
      const runId = asAgentRunId(started.run.id);
      await waitUntil(async () => {
        const run = await t.instance.stores.agentRuns.getAgentRun({
          clientInstanceId: t.clientInstanceId,
          runId
        });
        return run?.status === "completed" || run?.status === "waiting_for_decision";
      }, "the invalid save settles before confirmation");
      const rows = (
        await t.instance.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId })
      ).filter((row) => row.origin.kind === "agent" && row.origin.agentRunId === runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe(status);
      expect(JSON.stringify(rows[0]?.error)).toContain(expected);
      if (name === "copied-model")
        expect(rows[0]?.error?.message).toContain("Instance admin (superadmin)");
      if (name === "skill-without-reader") expect(rows[0]?.error?.message).toContain("read_skill");
      expect(rows.some((row) => row.status === "pending_confirmation")).toBe(false);
      expect(
        await t.instance.stores.configAssets.getConfigAsset({
          clientInstanceId: t.clientInstanceId,
          kind: "agent",
          name
        })
      ).toBeUndefined();
    }
  );

  it.each(["skill", "agent"])(
    "writes a new %s once after Allow, never before, even under central allow",
    async (kind) => {
      const t = await fixture([{ operation: "assets.put", value: "allow" }], ["user", "admin"]);
      const name = `hr-${kind}`;
      const config =
        kind === "skill"
          ? { name, title: "Leave policy", description: "Sample", content: "Ask for cover." }
          : {
              name,
              displayName: "Leave reviewer",
              initialPrompts: [],
              instructions: "Ask for cover.",
              toolNames: [],
              skillNames: []
            };
      const key = { clientInstanceId: t.clientInstanceId, kind, name };
      const started = await injectStartConversationRun(
        t.instance,
        t.conversation.id,
        `/tool platform.assets.put ${JSON.stringify({ kind, name, config })}`
      );
      const runId = asAgentRunId(started.run.id);
      await waitUntil(
        async () =>
          (
            await t.instance.stores.agentRuns.getAgentRun({
              clientInstanceId: t.clientInstanceId,
              runId
            })
          )?.status === "waiting_for_decision",
        "the live save waits for Allow"
      );
      const calls = await t.instance.stores.operationRuns.list({
        clientInstanceId: t.clientInstanceId
      });
      const call = required(
        calls.find(
          (row) =>
            row.origin.kind === "agent" &&
            row.origin.agentRunId === runId &&
            row.status === "pending_confirmation"
        )
      );
      expect(await t.instance.stores.configAssets.getConfigAsset(key)).toBeUndefined();
      const allow = () =>
        t.instance.call("operations.decide", {
          params: { runId: call.id },
          payload: { decision: "confirm" }
        });
      const allowed = await allow();
      expect(allowed.statusCode, allowed.body).toBe(200);
      await waitUntil(
        async () =>
          (
            await t.instance.stores.agentRuns.getAgentRun({
              clientInstanceId: t.clientInstanceId,
              runId
            })
          )?.status === "completed",
        "the confirmed save completes"
      );
      const row = await t.instance.stores.configAssets.getConfigAsset(key);
      expect(row?.scope).toEqual({
        kind: "workspace",
        workspaceId: t.conversation.collaborationWorkspaceId
      });
      expect(row?.revision).toBe(1);
      expect((await allow()).statusCode).toBe(200);
      await getTestJobs(t.instance).runDue();
      expect(await t.instance.stores.configAssets.listConfigAssetRevisions(key)).toHaveLength(1);
      const messages = await t.instance.call("conversations.messages.list", {
        params: { conversationId: t.conversation.id }
      });
      const results = z
        .object({ items: z.array(z.object({ role: z.string(), text: z.string() })) })
        .parse(messages.json())
        .items.filter((message) => message.role === "tool");
      expect(results.map((message) => JSON.parse(message.text))).toContainEqual(
        expect.objectContaining({
          saved: true,
          workspaceId: t.conversation.collaborationWorkspaceId
        })
      );
      if (kind === "agent")
        expect(
          (
            await t.instance.stores.configAssets.listAgentAvailability({
              clientInstanceId: t.clientInstanceId
            })
          ).get(name)
        ).toMatchObject({
          mode: "selected",
          collaborationWorkspaceIds: [],
          personalWorkspaces: false
        });
    }
  );
});
