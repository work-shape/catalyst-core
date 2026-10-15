import { PLATFORM_TOOL_NAMES } from "@vivd-catalyst/client-assembly";
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

// The agent's save is a projection of `assets.put`: what an administrator sets on that
// operation for the Workflow of the conversation holds for the save of the agent too. Each
// case fails without the change: the tool declared `allow` and asked nothing of `assets.put`.

const WORKFLOW = "month-end";
const subject = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const configOf = (label: string) => ({
  name: WORKFLOW,
  manifest: {
    id: WORKFLOW,
    name: label,
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

describe("a policy on assets.put and the agent's save", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  async function fixture() {
    const settings: CentralPolicySetting[] = [];
    const config = createTestConfig({
      // The agent holds the platform's tools: its definition lists them.
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
    const written = await app.call("assets.put", {
      params: subject,
      payload: { config: configOf("Month end"), expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
    const created = await app.call("conversations.create", {
      payload: { title: "Edit", subject }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
    const revision = async () =>
      (await app.stores.configAssets.getConfigAsset({ clientInstanceId, ...subject }))?.revision;
    /** One save by the agent: the events of its run, and what the tool answered, if it did. */
    const save = async (label: string) => {
      const toolTexts = async () =>
        messagesSchema
          .parse(
            (await app.call("conversations.messages.list", { params: { conversationId } })).json()
          )
          .items.filter((message) => message.role === "tool")
          .map((message) => message.text);
      const before = (await toolTexts()).length;
      const input = { config: configOf(label), expectedRevision: await revision() };
      const started = await injectStartConversationRun(
        app,
        conversationId,
        `/tool platform.assets.put ${JSON.stringify(input)}`
      );
      const events = await drainRunEvents(app, conversationId, started.run.id);
      const after = await toolTexts();
      return { events, answer: after.length > before ? after.at(-1) : undefined };
    };
    /** The agent's first save of a Workflow in a conversation about nothing: its answer. */
    const firstSave = async (name: string) => {
      const fresh = await app.call("conversations.create", { payload: { title: "New" } });
      const freshId = z.object({ id: z.string() }).parse(fresh.json()).id;
      const input = {
        kind: WORKFLOW_ASSET_KIND,
        name,
        config: { ...configOf("New"), name, manifest: { ...configOf("New").manifest, id: name } }
      };
      const started = await injectStartConversationRun(
        app,
        freshId,
        `/tool platform.assets.put ${JSON.stringify(input)}`
      );
      const events = await drainRunEvents(app, freshId, started.run.id);
      const texts = messagesSchema
        .parse(
          (
            await app.call("conversations.messages.list", { params: { conversationId: freshId } })
          ).json()
        )
        .items.filter((message) => message.role === "tool")
        .map((message) => message.text);
      const stored = await app.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name
      });
      return { said: `${events}${texts.at(-1) ?? ""}`, stored };
    };
    return { settings, revision, save, firstSave };
  }

  it.each<[string, CentralPolicySetting]>([
    ["deny", { operation: "assets.put", value: "deny" }],
    [
      "deny for Workflows",
      { operation: "assets.put", value: "deny", assetKind: WORKFLOW_ASSET_KIND }
    ],
    ["deny for every asset operation", { operation: "assets.*", value: "deny" }]
  ])(
    "refuses the save where assets.put is set to %s",
    async (_title, setting) => {
      const t = await fixture();
      const before = await t.revision();
      t.settings.push(setting);
      const { events, answer } = await t.save("Under deny");
      expect(`${events}${answer ?? ""}`).toContain("denied by policy");
      expect(answer ?? "").not.toContain('"saved":true');
      expect(await t.revision()).toBe(before);
    },
    120_000
  );

  it("holds the save for an approval where assets.put asks for one, and saves nothing until then", async () => {
    const t = await fixture();
    const before = await t.revision();
    t.settings.push({ operation: "assets.put", value: "approval", assetKind: WORKFLOW_ASSET_KIND });
    const { answer } = await t.save("Under approval");
    expect(JSON.parse(answer ?? "null")).toMatchObject({ status: "pending_approval" });
    expect(await t.revision()).toBe(before);
  }, 120_000);

  it("saves where the setting on assets.put is of another kind of asset, or allows", async () => {
    const t = await fixture();
    const before = (await t.revision()) ?? 0;
    t.settings.push(
      { operation: "assets.put", value: "deny", assetKind: "agent" },
      { operation: "assets.put", value: "allow", assetKind: WORKFLOW_ASSET_KIND }
    );
    const { answer } = await t.save("Not meant");
    expect(JSON.parse(answer ?? "null")).toEqual({ saved: true, revision: before + 1 });
  }, 120_000);

  it("holds a first save that would create a Workflow to the setting on assets.put (NAV-2)", async () => {
    const t = await fixture();
    t.settings.push({ operation: "assets.put", value: "deny", assetKind: WORKFLOW_ASSET_KIND });
    const denied = await t.firstSave("year-end");
    expect(denied.said).toContain("denied by policy");
    expect(denied.stored).toBeUndefined();

    t.settings.splice(0);
    const saved = await t.firstSave("year-end");
    expect(saved.said).toContain('"created":true');
    expect(saved.stored?.scope).toEqual({ kind: "instance" });
  }, 120_000);
});
