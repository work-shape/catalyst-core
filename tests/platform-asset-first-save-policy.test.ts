import { PLATFORM_TOOL_NAMES } from "@work-shape/catalyst-client-assembly";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// An administrator's setting on assets.put holds the agent's first save as it holds the same
// put through the API: it is asked of the kind and the name the save creates, so a Namespace
// setting applies and a setting on another kind does not (NAV-2, Platform Access check 44).
// The first case is the verifier's probe of PR 91.

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

describe("a setting on assets.put against the agent's first save", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  /** An instance with the Namespace `fin-` and the settings the case gives. */
  async function instanceWith(settings: CentralPolicySetting[]) {
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
    const namespace = await app.call("namespaces.create", {
      payload: { prefix: "fin-", displayName: "Finance" }
    });
    expect(namespace.statusCode).toBe(200);
    /** The agent's first save of the Workflow `name`, and whether it was stored. */
    const firstSave = async (name: string) => {
      const created = await app.call("conversations.create", { payload: { title: "New" } });
      const id = z.object({ id: z.string() }).parse(created.json()).id;
      const put = { kind: WORKFLOW_ASSET_KIND, name, config: workflowConfig(name) };
      const started = await injectStartConversationRun(
        app,
        id,
        `/tool platform.assets.put ${JSON.stringify(put)}`
      );
      await drainRunEvents(app, id, started.run.id);
      return app.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name
      });
    };
    return { app, firstSave };
  }

  it("refuses the first save in a Namespace the setting denies, as the API's put is refused", async () => {
    const { app, firstSave } = await instanceWith([
      { operation: "assets.put", value: "deny", assetKind: WORKFLOW_ASSET_KIND, namespace: "fin-" }
    ]);
    const api = await app.call("assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "fin-close" },
      payload: { config: workflowConfig("fin-close"), expectedRevision: null }
    });
    expect(api.statusCode).toBe(403);
    expect(await firstSave("fin-month")).toBeUndefined();
    // Outside the Namespace the setting does not reach.
    expect(await firstSave("payroll-month")).toBeDefined();
  }, 120_000);

  it("creates a Workflow where a setting denies writing agents only", async () => {
    const { firstSave } = await instanceWith([
      { operation: "assets.put", value: "deny", assetKind: "agent" }
    ]);
    expect(await firstSave("fin-month")).toBeDefined();
  }, 120_000);
});
