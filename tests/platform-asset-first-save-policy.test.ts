import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asAgentRunId,
  asClientInstanceId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { waitUntil } from "./support/assertions";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// An administrator's setting on assets.put holds the agent's first save as it holds the same
// put through the API: it is asked of the kind and the owner the save creates, so a setting on
// a workspace applies to a save in its conversations and a setting on another kind does not
// (NAV-2, Platform Access check 44). The first case grew from the verifier's probe of PR 91.

const workflowConfig = (name: string) => ({
  name,
  manifest: {
    id: name,
    name,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
});
const skillConfig = (name: string) => ({
  name,
  title: name,
  description: "A skill",
  content: "Guidance."
});

describe("a setting on assets.put against the agent's first save", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  /** An instance with the Shared Workspace Finance and the settings the case gives for it. */
  async function instanceWith(settingsFor: (finance: string) => CentralPolicySetting[]) {
    let settings: CentralPolicySetting[] = [];
    const config = createTestConfig({
      toolNames: [...PLATFORM_TOOL_NAMES],
      developmentAuth: {
        enabled: true,
        defaultUserId: "owner",
        users: [
          {
            id: "owner",
            externalUserId: "owner",
            displayLabel: "Owner",
            roles: ["user", "admin", "superadmin"]
          }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
    config.administration.agentConfiguration.enabled = true;
    config.administration.agentConfiguration.allowSkillEditing = true;
    const app = await createTestInstance({
      config,
      env: {},
      tools: [],
      operations: { centralPolicySettings: () => settings }
    });
    open = app;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "workflow-runner"
    });
    const workspace = await app.call("workspaces.create", { payload: { name: "Finance" } });
    expect(workspace.statusCode, workspace.body).toBe(200);
    const finance = z.object({ id: z.string() }).parse(workspace.json()).id;
    settings = settingsFor(finance);
    /**
     * The agent's first save of the Workflow or skill `name`, in a private conversation of the
     * workspace or of the caller's own, and what was stored.
     */
    const firstSave = async (
      kind: typeof WORKFLOW_ASSET_KIND | "skill",
      name: string,
      collaborationWorkspaceId?: string
    ) => {
      const created = await app.call("conversations.create", {
        payload: {
          title: "New",
          ...(collaborationWorkspaceId ? { collaborationWorkspaceId, visibility: "private" } : {})
        }
      });
      const id = z.object({ id: z.string() }).parse(created.json()).id;
      const config = kind === WORKFLOW_ASSET_KIND ? workflowConfig(name) : skillConfig(name);
      const put = { kind, name, config };
      const started = await injectStartConversationRun(
        app,
        id,
        `/tool platform.assets.put ${JSON.stringify(put)}`
      );
      let drained = false;
      const observing = drainRunEvents(app, id, started.run.id).then(() => {
        drained = true;
      });
      // A new skill is live at once, so a save no setting refuses waits for its person, who
      // confirms it here.
      const runId = asAgentRunId(started.run.id);
      await waitUntil(
        async () =>
          drained ||
          (await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId }))?.status ===
            "waiting_for_decision",
        "the save is decided or waits for its person",
        60_000
      );
      if (!drained) {
        const held = (await app.stores.operationRuns.list({ clientInstanceId })).find(
          (run) =>
            run.origin.kind === "agent" &&
            run.origin.agentRunId === runId &&
            run.status === "pending_confirmation"
        );
        if (!held) throw new Error("The save waits for no confirmation");
        const confirmed = await app.call("operations.decide", {
          params: { runId: held.id },
          payload: { decision: "confirm" }
        });
        expect(confirmed.statusCode, confirmed.body).toBe(200);
      }
      await observing;
      return app.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
    };
    return { app, firstSave, finance };
  }

  it("refuses the first save in a workspace the setting denies, as the API's put is refused", async () => {
    const { app, firstSave, finance } = await instanceWith((finance) => [
      { operation: "assets.put", value: "deny", assetKind: "skill", workspaceId: finance }
    ]);
    const api = await app.call("assets.put", {
      params: { kind: "skill", name: "close-guide" },
      payload: { config: skillConfig("close-guide"), workspaceId: finance, expectedRevision: null }
    });
    expect(api.statusCode).toBe(403);
    expect(api.json()).toMatchObject({ error: { code: "POLICY_DENIED" } });
    expect(await firstSave("skill", "month-guide", finance)).toBeUndefined();
    // Outside the workspace the setting does not reach.
    expect(await firstSave("skill", "payroll-guide")).toBeDefined();
  }, 120_000);

  it("creates a Workflow and a skill where a setting denies writing agents only", async () => {
    const { firstSave, finance } = await instanceWith(() => [
      { operation: "assets.put", value: "deny", assetKind: "agent" }
    ]);
    expect(await firstSave(WORKFLOW_ASSET_KIND, "month-close")).toBeDefined();
    expect(await firstSave("skill", "month-guide", finance)).toMatchObject({
      scope: { kind: "workspace", workspaceId: finance }
    });
  }, 120_000);
});
