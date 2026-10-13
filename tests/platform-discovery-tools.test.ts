import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND } from "@vivd-catalyst/core";
import { createPlatformDiscoveryTools } from "@vivd-catalyst/tool-execution";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// Every agent, in every conversation, finds what is on the platform with two tools and reads
// how the platform works in one shipped skill. The tools answer with the rights of the person
// the agent acts for: an asset that person may not read is answered as one that does not
// exist. The model is the scripted one of the tests, which makes the one tool call each
// message names. Each test fails without the change: no agent could list the platform's
// assets, and a conversation about nothing was offered no tool and no skill of the platform.

const OWNER = "owner";
const MEMBER = "member";
const WORKFLOW = "month-end";

const contextSchema = z.object({
  instance: z.object({ name: z.string() }),
  modules: z.array(z.string()),
  kinds: z.array(z.object({ kind: z.string(), plural: z.string(), hasDraft: z.boolean() })),
  actions: z.array(z.string()),
  assetActions: z.array(z.string()),
  namespaces: z.array(z.unknown())
});
const foundSchema = z.object({
  assets: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      description: z.string().optional()
    })
  ),
  truncated: z.boolean()
});
const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), text: z.string() }))
});

/** A Workflow as small as a save takes one. */
const workflowConfig = {
  name: WORKFLOW,
  manifest: {
    id: WORKFLOW,
    name: "Month-end closing",
    description: "Closes the books at the end of each month.",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
};

describe("the tools that find what is on the platform", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  async function fixture(workflows: boolean) {
    const config = createTestConfig({
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
          { id: MEMBER, externalUserId: MEMBER, displayLabel: "Member", roles: ["user"] }
        ]
      }
    });
    config.modules = { assetManagement: { enabled: true }, workflows: { enabled: workflows } };
    const app = await createTestInstance({ config, env: {}, tools: [] });
    open = app;
    /** A conversation about nothing, of `as`, and one tool call in it with what it answered. */
    const conversationOf = async (as: string) => {
      const created = await app.call("conversations.create", { payload: { title: "Ask" } }, as);
      expect(created.statusCode, created.body).toBe(200);
      const { id } = z.object({ id: z.string() }).parse(created.json());
      const headers = { "x-dev-user-id": as };
      return async (tool: string, input: unknown = {}) => {
        const started = await injectStartConversationRun(
          app,
          id,
          `/tool ${tool} ${JSON.stringify(input)}`,
          { headers }
        );
        const events = await drainRunEvents(app, id, started.run.id, { headers });
        const messages = messagesSchema.parse(
          (
            await app.call("conversations.messages.list", { params: { conversationId: id } }, as)
          ).json()
        );
        const text = messages.items.filter((message) => message.role === "tool").at(-1)?.text;
        const answer: unknown = text === undefined ? undefined : JSON.parse(text);
        return { events, answer };
      };
    };
    return { app, conversationOf };
  }

  it("lets an agent in a conversation about nothing read the platform skill, see what the instance has and find the assets its user may read, and nothing of the others", async () => {
    const t = await fixture(true);
    const written = await t.app.call("assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW },
      payload: { config: workflowConfig, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);

    const owner = await t.conversationOf(OWNER);
    const skill = z
      .object({ name: z.string(), content: z.string() })
      .parse((await owner("read_skill", { name: "platform-guide" })).answer);
    expect(skill.content).toContain("platform.assets.list");

    const context = contextSchema.parse((await owner("platform.context")).answer);
    expect(context.modules).toContain("workflows");
    expect(context.kinds).toContainEqual({ kind: "workflow", plural: "workflows", hasDraft: true });
    expect(context.actions).toEqual(expect.arrayContaining(["workflow.write", "workflow.publish"]));

    // Names, titles and descriptions; never the definition.
    const found = foundSchema.parse(
      (await owner("platform.assets.list", { kind: "workflow", text: "MONTH" })).answer
    );
    expect(found).toEqual({
      assets: [
        {
          kind: "workflow",
          name: WORKFLOW,
          title: "Month-end closing",
          description: "Closes the books at the end of each month."
        }
      ],
      truncated: false
    });
    const everyKind = foundSchema.parse((await owner("platform.assets.list", {})).answer);
    expect(everyKind.assets.map(({ kind, name }) => `${kind}:${name}`)).toContain(
      `workflow:${WORKFLOW}`
    );

    // A member who may not read the Workflow is told what is told of a name that is not there.
    const member = await t.conversationOf(MEMBER);
    const memberContext = contextSchema.parse((await member("platform.context")).answer);
    expect(memberContext.actions).not.toContain("workflow.write");
    const hidden = await member("platform.assets.list", { kind: "workflow", text: WORKFLOW });
    const missing = await member("platform.assets.list", { kind: "workflow", text: "no-such" });
    expect(hidden.answer).toEqual({ assets: [], truncated: false });
    expect(hidden.answer).toEqual(missing.answer);
    const memberEveryKind = foundSchema.parse((await member("platform.assets.list", {})).answer);
    expect(memberEveryKind.assets.map(({ kind }) => kind)).not.toContain("workflow");
  }, 120_000);

  it("lists no kind of a module that is off, and refuses it as a kind that does not exist", async () => {
    const t = await fixture(false);
    const owner = await t.conversationOf(OWNER);
    const context = contextSchema.parse((await owner("platform.context")).answer);
    expect(context.modules).not.toContain("workflows");
    expect(context.kinds.map(({ kind }) => kind)).not.toContain("workflow");
    expect(context.actions.filter((action) => action.startsWith("workflow."))).toEqual([]);

    const off = await owner("platform.assets.list", { kind: "workflow" });
    const unknown = await owner("platform.assets.list", { kind: "no-such-kind" });
    const refusal = (kind: string) => ({
      code: "handler_failed",
      message: `This platform has no kind '${kind}'. platform.context lists the kinds it has`
    });
    expect(off.answer).toEqual(refusal("workflow"));
    expect(unknown.answer).toEqual(refusal("no-such-kind"));
  }, 120_000);

  it("finds nothing on an instance that holds no asset of a kind", async () => {
    const t = await fixture(true);
    const owner = await t.conversationOf(OWNER);
    expect((await owner("platform.assets.list", { kind: "workflow" })).answer).toEqual({
      assets: [],
      truncated: false
    });
    // What the release ships alone: the instance holds no asset anybody wrote.
    const everyKind = foundSchema.parse((await owner("platform.assets.list", {})).answer);
    expect(everyKind.truncated).toBe(false);
    expect(everyKind.assets.map(({ kind }) => kind)).not.toContain("workflow");
  }, 120_000);

  it("refuses search text the store cannot hold before it reaches the store", () => {
    const unused = () => Promise.reject(new Error("The schema refuses the input first"));
    const tools = createPlatformDiscoveryTools({ readContext: unused, listAssets: unused });
    const find = tools.find((tool) => tool.name === "platform.assets.list");
    expect(find?.inputSchema.safeParse({ text: "month\u0000end" }).success).toBe(false);
    expect(find?.inputSchema.safeParse({ kind: "work\u0000flow" }).success).toBe(false);
    expect(find?.inputSchema.safeParse({ kind: "workflow", text: "month" }).success).toBe(true);
  });
});
