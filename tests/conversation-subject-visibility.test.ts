import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asUserId
} from "@vivd-catalyst/core";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// A conversation about a Workflow holds the definition in its transcript: what the agent read
// and saved. In a shared workspace it is its creator's alone, so a member without the read
// right on the Workflow reads nothing of it there. Fails without the change: the conversation
// took the visibility of its workspace, and the member read the definition from the messages.

const WORKFLOW = "month-end";
const OWNER = "owner";
const OTHER = "other";
const subject = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const config = {
  name: WORKFLOW,
  manifest: {
    id: WORKFLOW,
    name: "Month end",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  }
};
const conversationSchema = z.object({ id: z.string(), visibility: z.string() });
const idSchema = z.object({ id: z.string() });

describe("a conversation about a Workflow in a shared workspace", () => {
  let open: TestInstance | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it("is its creator's alone, and stays so when it is moved", async () => {
    const instanceConfig = createTestConfig({
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
    instanceConfig.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
    const app = await createTestInstance({ config: instanceConfig, env: {}, tools: [] });
    open = app;
    const clientInstanceId = asClientInstanceId(instanceConfig.clientInstance.id);
    await app.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "workflow-runner"
    });
    const ok = async (response: ReturnType<TestInstance["call"]>) => {
      const answered = await response;
      expect(answered.statusCode, answered.body).toBe(200);
      return answered;
    };
    await ok(
      app.call("assets.put", { params: subject, payload: { config, expectedRevision: null } })
    );
    const otherId = idSchema.parse((await ok(app.call("me.get", {}, OTHER))).json()).id;
    const shared = async (name: string) => {
      const { id } = idSchema.parse(
        (await ok(app.call("workspaces.create", { payload: { name } }))).json()
      );
      await app.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: asCollaborationWorkspaceId(id),
        userId: asUserId(otherId),
        role: "member"
      });
      return id;
    };
    const workspaceId = await shared("Shared");
    const create = async (about?: typeof subject) =>
      conversationSchema.parse(
        (
          await ok(
            app.call("conversations.create", {
              payload: {
                title: "Edit",
                collaborationWorkspaceId: workspaceId,
                ...(about ? { subject: about } : {})
              }
            })
          )
        ).json()
      );

    // A conversation about nothing is the workspace's, as before; one about the Workflow is not.
    const plain = await create();
    const about = await create(subject);
    expect(plain.visibility).toBe("workspace");
    expect(about.visibility).toBe("private");

    // The owner's agent reads the definition into the transcript. A list holds a conversation
    // once it has a message, so the other one gets a message too.
    const say = async (conversationId: string, text: string) => {
      const started = await injectStartConversationRun(app, conversationId, text);
      await drainRunEvents(app, conversationId, started.run.id);
    };
    await say(about.id, "/tool platform.assets.get {}");
    await say(plain.id, "Hello");
    const messages = (as?: string) =>
      app.call("conversations.messages.list", { params: { conversationId: about.id } }, as);
    expect((await ok(messages())).body).toContain("manifest");

    // The member reads the workspace's conversation, and nothing of the one about the Workflow.
    const refused = await messages(OTHER);
    expect(refused.statusCode, refused.body).toBe(404);
    expect(refused.body).not.toContain("manifest");
    const listed = async (as?: string) =>
      z
        .object({ items: z.array(idSchema) })
        .parse(
          (
            await ok(
              app.call(
                "conversations.list",
                { query: { collaborationWorkspaceId: workspaceId } },
                as
              )
            )
          ).json()
        )
        .items.map((item) => item.id);
    expect(await listed(OTHER)).toEqual([plain.id]);
    expect((await listed()).sort()).toEqual([plain.id, about.id].sort());

    // A move cannot open it to a workspace, and without a visibility it stays private.
    const elsewhere = await shared("Elsewhere");
    const move = (visibility?: string) =>
      app.call("conversations.move", {
        params: { conversationId: about.id },
        payload: { collaborationWorkspaceId: elsewhere, ...(visibility ? { visibility } : {}) }
      });
    const opened = await move("workspace");
    expect(opened.statusCode, opened.body).toBe(422);
    expect(opened.json()).toMatchObject({
      error: { details: { reason: "subject_conversation_private" } }
    });
    expect(conversationSchema.parse((await ok(move())).json()).visibility).toBe("private");
    expect((await messages(OTHER)).statusCode).toBe(404);
  }, 120_000);
});
