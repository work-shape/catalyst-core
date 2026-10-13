import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, asClientInstanceId, asUserId } from "@vivd-catalyst/core";
import { PLATFORM_ASSET_TOOL_NAMES } from "@vivd-catalyst/tool-execution";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestJobs, type TestInstance } from "./support/test-instance";

// The agent edits the draft of a Workflow, on an assembled instance: a conversation that is
// about the Workflow gives its agent the tools that read, check and save the definition, bound
// to that Workflow by the server. The model is the scripted one of the tests, which makes the
// one tool call each message names. Each test fails without the change: no tool of an agent
// reached the definition of an asset, and a conversation was about nothing.

const WORKFLOW = "month-end";
const OWNER = "owner";
const OTHER = "other";
const subject = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const address = subject;

const ref = (step: string, path: string) => ({ ref: { step, path } });
const trigger = {
  id: "start",
  name: "Start by hand",
  type: "trigger",
  triggers: [{ kind: "manual" }]
};
const result = {
  id: "result",
  name: "Result",
  type: "output",
  input: { note: ref("start", "input.note") }
};
/** The definition as it is published, and as the agent changes it: its steps between the two. */
const manifest = (steps: unknown[] = []) => ({
  id: WORKFLOW,
  name: "Month end",
  runAs: "workflow-runner",
  inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  outputs: { type: "object" },
  steps: [trigger, ...steps, result]
});
const configOf = (steps: unknown[] = []) => ({ name: WORKFLOW, manifest: manifest(steps) });
/** A step the engine of this release does not run, and the one the agent writes after it. */
const notRun = { id: "tell", name: "Tell the team", type: "notify", channel: "inbox", input: {} };
const added = {
  id: "books",
  name: "Read the books",
  type: "operation",
  operation: "connection.books.read",
  input: { month: ref("start", "input.note") }
};

const readSchema = z.object({
  config: z.object({
    name: z.string(),
    manifest: z.object({ steps: z.array(z.unknown()) }).loose()
  }),
  revision: z.number(),
  publishedRevision: z.number().optional(),
  shows: z.string()
});
const issuesSchema = z.array(
  z.object({ path: z.string(), message: z.string(), code: z.string().optional() })
);
const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  issues: issuesSchema.optional(),
  conflict: z.string().optional()
});
const assetSchema = z.object({ revision: z.number(), publishedRevision: z.number().optional() });
const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  definitionRevisionId: z.string()
});
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

describe("a conversation about a Workflow", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  async function fixture() {
    const config = createTestConfig({
      tools: [{ name: "read_skill", enabled: true }],
      developmentAuth: {
        enabled: true,
        defaultUserId: OWNER,
        users: [
          {
            id: OWNER,
            externalUserId: OWNER,
            displayLabel: "Owner",
            roles: ["user", "admin", "superadmin"]
          },
          { id: OTHER, externalUserId: OTHER, displayLabel: "Other", roles: ["user"] }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
    config.administration.agentConfiguration.enabled = true;
    const app = await createTestInstance({ config, env: {}, tools: [] });
    open = app;
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "workflow-runner"
    });
    const ok = async (response: ReturnType<TestInstance["call"]>) => {
      const answered = await response;
      expect(answered.statusCode, answered.body).toBe(200);
      return answered;
    };
    // The owner writes the Workflow and publishes it: revision 1 is what runs.
    const written = await ok(
      app.call("assets.put", {
        params: address,
        payload: { config: configOf(), expectedRevision: null }
      })
    );
    const { revision: published } = assetSchema.parse(written.json());
    await ok(app.call("assets.publish", { params: address, payload: { revision: published } }));

    const converse = async (about: typeof subject | undefined, as?: string) =>
      app.call(
        "conversations.create",
        { payload: { title: "Edit", ...(about ? { subject: about } : {}) } },
        as
      );
    /** One message to the agent, and what the tool it named answered. */
    const say = async (conversationId: string, text: string) => {
      const started = await injectStartConversationRun(app, conversationId, text);
      const events = await drainRunEvents(app, conversationId, started.run.id);
      const messages = messagesSchema.parse(
        (await app.call("conversations.messages.list", { params: { conversationId } })).json()
      );
      const answers = messages.items.filter((message) => message.role === "tool");
      return { events, answer: answers.at(-1)?.text };
    };
    const call = async (conversationId: string, tool: string, input: unknown = {}) => {
      const { answer } = await say(conversationId, `/tool ${tool} ${JSON.stringify(input)}`);
      const parsed: unknown = JSON.parse(answer ?? "null");
      return parsed;
    };
    const asset = async () =>
      assetSchema.parse((await ok(app.call("assets.get", { params: address }))).json());
    const publishedRevisionId = async () =>
      (await app.stores.configAssets.getConfigAsset({ clientInstanceId, ...address }))
        ?.publishedRevisionId;
    return {
      app,
      clientInstanceId,
      published,
      ok,
      converse,
      say,
      call,
      asset,
      publishedRevisionId
    };
  }

  it("lets the agent read the definition, be refused its first try, correct it and save a draft that changes nothing that runs", async () => {
    const t = await fixture();
    const created = await t.ok(t.converse(subject));
    const conversation = z
      .object({ id: z.string(), subject: z.object({ kind: z.string(), name: z.string() }) })
      .parse(created.json());
    expect(conversation.subject).toEqual(subject);
    const { id } = conversation;

    // The agent reads the skill the platform ships for a Workflow, and the definition.
    const skill = z
      .object({ name: z.string(), content: z.string() })
      .parse(await t.call(id, "read_skill", { name: "workflow-authoring" }));
    expect(skill.content).toContain("type: operation");
    const read = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(read).toMatchObject({
      config: { name: WORKFLOW },
      revision: t.published,
      publishedRevision: t.published,
      shows: "published"
    });
    expect(read.config.manifest.steps).toHaveLength(2);

    // Its first try holds a step the engine does not run: the check says so, and a save of
    // it stores nothing.
    const checked = z
      .object({ valid: z.boolean(), issues: issuesSchema })
      .parse(await t.call(id, "platform.assets.validate", { config: configOf([notRun]) }));
    expect(checked.valid).toBe(false);
    expect(checked.issues).toMatchObject([{ path: "steps[1].type", code: "not_supported_yet" }]);
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([notRun]),
        expectedRevision: read.revision
      })
    );
    expect(refused).toMatchObject({ saved: false, issues: [{ code: "not_supported_yet" }] });
    expect(await t.asset()).toEqual({ revision: t.published, publishedRevision: t.published });

    // It corrects the step, checks again and saves.
    expect(await t.call(id, "platform.assets.validate", { config: configOf([added]) })).toEqual({
      valid: true,
      issues: []
    });
    const saved = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added]),
        expectedRevision: read.revision
      })
    );
    expect(saved).toEqual({ saved: true, revision: t.published + 1 });

    // A draft now differs from what is published, and what is published is what it was.
    expect(await t.asset()).toEqual({ revision: t.published + 1, publishedRevision: t.published });
    const again = readSchema.parse(await t.call(id, "platform.assets.get"));
    expect(again).toMatchObject({ revision: t.published + 1, shows: "draft" });
    expect(again.config.manifest.steps).toHaveLength(3);

    // A run still starts on the published revision and ends on its two steps.
    const started = runSchema.parse(
      (
        await t.ok(
          t.app.call("workflows.start", {
            params: { workflow: WORKFLOW },
            payload: { input: { note: "2026-10" } }
          })
        )
      ).json()
    );
    expect(started.definitionRevisionId).toBe(await t.publishedRevisionId());
    const jobs = getTestJobs(t.app);
    for (let pass = 0; pass < 6; pass++) await jobs.runDue();
    const ended = z
      .object({ status: z.string(), stepRunCount: z.number() })
      .parse((await t.app.call("workflows.get_run", { params: { runId: started.id } })).json());
    expect(ended).toEqual({ status: "done", stepRunCount: 2 });

    // A save against the revision the agent read first is a conflict, and saves nothing.
    const stale = writeSchema.parse(
      await t.call(id, "platform.assets.put", {
        config: configOf([added, { ...added, id: "books_again" }]),
        expectedRevision: read.revision
      })
    );
    expect(stale).toMatchObject({ saved: false, conflict: "REVISION_CONFLICT" });
    expect((await t.asset()).revision).toBe(t.published + 1);

    // Each call is the owner's: its Operation Run names the person, and the save left the
    // audit row a save through the API leaves, with that run.
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    const put = runs.filter((run) => run.operation === "platform.assets.put");
    expect(put.map((run) => [run.status, run.actor.kind, run.origin.kind])).toEqual([
      ["done", "user", "agent"],
      ["done", "user", "agent"],
      ["done", "user", "agent"]
    ]);
    const audited = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId
    });
    const updates = audited.filter(
      (event) =>
        event.type === "config_asset.updated" &&
        put.some((run) => run.id === event.metadata?.operationRunId)
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.actor?.userId).toBe(
      asUserId((await t.app.call("me.get", {})).json<{ id: string }>().id)
    );
  }, 120_000);

  it("reaches the Workflow of its conversation whatever the model names", async () => {
    const t = await fixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(subject))).json());
    // A name in the input of the read is not part of the tool: the answer is the subject.
    const read = readSchema.parse(
      await t.call(id, "platform.assets.get", { kind: "agent", name: "test_agent" })
    );
    expect(read.config.name).toBe(WORKFLOW);
    // The operations a step may call, as far as the owner sees them: this instance has none.
    expect(await t.call(id, "platform.assets.operations")).toEqual({
      operations: [],
      truncated: false
    });
    // A config that names another asset is no save of this one, and none of the other.
    const other = { name: "year-end", manifest: { ...manifest(), id: "year-end" } };
    const refused = writeSchema.parse(
      await t.call(id, "platform.assets.put", { config: other, expectedRevision: read.revision })
    );
    expect(refused).toMatchObject({ saved: false, issues: [{ code: "subject_mismatch" }] });
    expect(
      await t.app.stores.configAssets.getConfigAsset({
        clientInstanceId: t.clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: "year-end"
      })
    ).toBeUndefined();
  }, 120_000);

  it("offers the tools in no conversation without a subject", async () => {
    const t = await fixture();
    const { id } = z.object({ id: z.string() }).parse((await t.ok(t.converse(undefined))).json());
    for (const tool of PLATFORM_ASSET_TOOL_NAMES) {
      const { events, answer } = await t.say(id, `/tool ${tool} {}`);
      // The scripted model refuses a tool it was not offered, and the run fails on that.
      expect(events).toContain(`Tool '${tool}' is not available to this agent`);
      expect(answer).toBeUndefined();
    }
  }, 120_000);

  it("refuses a conversation about a Workflow its creator may not read as it refuses one about nothing", async () => {
    const t = await fixture();
    const unreadable = await t.converse(subject, OTHER);
    const missing = await t.converse({ kind: WORKFLOW_ASSET_KIND, name: "no-such-workflow" });
    const unknownKind = await t.converse({ kind: "no-such-kind", name: WORKFLOW });
    const refusal = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
    const told = [unreadable, missing, unknownKind].map((response) => ({
      status: response.statusCode,
      ...refusal.parse(response.json()).error
    }));
    expect(told[0]).toEqual({
      status: 404,
      code: "NOT_FOUND",
      message: "The subject of the conversation is not available"
    });
    expect(told[1]).toEqual(told[0]);
    expect(told[2]).toEqual(told[0]);
    // The same person creates a conversation about nothing.
    expect((await t.converse(undefined, OTHER)).statusCode).toBe(200);
  }, 120_000);
});
