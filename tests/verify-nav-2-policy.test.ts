import { PLATFORM_TOOL_NAMES } from "@vivd-catalyst/client-assembly";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// Verifier probe: an administrator's setting on assets.put scoped to a Namespace, against the
// agent's first save and against the same put through the API.

const LOG = process.env.PROBE_LOG ?? join(tmpdir(), "verify-nav-2-probes.log");
const note = (label: string, value: unknown) =>
  appendFileSync(LOG, `${JSON.stringify({ label, value })}\n`);

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
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

describe("NAV-2 verifier: a Namespace setting on assets.put", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it("holds the agent's first save as it holds the API's put", async () => {
    const settings: CentralPolicySetting[] = [];
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
    const ns = await app.call("namespaces.create", {
      payload: { prefix: "fin-", displayName: "Finance" }
    });
    note("namespace fin-", ns.statusCode);
    settings.push({
      operation: "assets.put",
      value: "deny",
      assetKind: WORKFLOW_ASSET_KIND,
      namespace: "fin-"
    });

    const api = await app.call("assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "fin-close" },
      payload: { config: workflowConfig("fin-close"), expectedRevision: null }
    });
    note("API put fin-close", { status: api.statusCode, body: api.body.slice(0, 200) });

    const created = await app.call("conversations.create", { payload: { title: "New" } });
    const id = z.object({ id: z.string() }).parse(created.json()).id;
    const started = await injectStartConversationRun(
      app,
      id,
      `/tool platform.assets.put ${JSON.stringify({ kind: WORKFLOW_ASSET_KIND, name: "fin-month", config: workflowConfig("fin-month") })}`
    );
    const events = await drainRunEvents(app, id, started.run.id);
    const texts = messagesSchema
      .parse(
        (await app.call("conversations.messages.list", { params: { conversationId: id } })).json()
      )
      .items.filter((m) => m.role === "tool")
      .map((m) => m.text);
    note("chat first save fin-month", {
      tool: texts.at(-1)?.slice(0, 200),
      denied: events.includes("denied by policy")
    });
    const stored = await app.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: "fin-month"
    });
    note(
      "fin-month stored",
      stored ? { revision: stored.revision, scope: stored.scope } : undefined
    );
    // The API refuses the put in the Namespace; the agent's first save must be refused alike.
    expect(api.statusCode).toBe(403);
    expect(stored).toBeUndefined();
  }, 120_000);
});
