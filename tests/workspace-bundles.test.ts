import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import { agent, clientInstanceId, errorSchema } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";

// WS-BUILD-1: Builder and Publisher in a workspace, one row each, held without membership
// (access acceptance checks 10 and 24). Lena is no member of the workspace Sales; Kai is.

const conversationSchema = z.looseObject({ id: z.string(), visibility: z.string() });
const listSchema = z.object({ items: z.array(z.looseObject({ id: z.string() })) });
const revisionSchema = z.object({ revision: z.number() });

describe("a Builder and Publisher who is no member of the workspace", () => {
  let t: AppInstance;
  let other: CollaborationWorkspaceId;
  let membersConversation: string;
  beforeAll(async () => {
    t = await setupAppInstance();
    other = await t.sharedWorkspace("Other");
    const created = await t.expectOk(t.kai.id, "conversations.create", {
      payload: { title: "Team talk", collaborationWorkspaceId: t.workspaceId }
    });
    membersConversation = conversationSchema.parse(created.json()).id;
    expectStatus(await putApp(t.admin.id, "offers", t.workspaceId), 200);
    expectStatus(await putApp(t.admin.id, "offers-other", other), 200);
  });
  afterAll(async () => {
    await t.close();
  });

  const putAgent = (name: string, workspaceId?: string) =>
    t.call(t.lena.id, "assets.put", {
      params: { kind: "agent", name },
      payload: {
        config: agent(name),
        expectedRevision: null,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  function putApp(userId: string, name: string, workspaceId: string) {
    return t.call(userId, "assets.put", {
      params: { kind: "app", name },
      payload: { files: appFiles(name, { name: "Offers" }), workspaceId }
    });
  }
  const publishApp = async (name: string, workspaceId: string) => {
    const read = await t.expectOk(t.admin.id, "assets.get", {
      params: { kind: "app", name },
      query: { workspaceId }
    });
    const { revision } = revisionSchema.parse(read.json());
    return t.call(t.lena.id, "assets.publish", {
      params: { kind: "app", name },
      payload: { revision, workspaceId }
    });
  };
  const listConversations = (workspaceId: string) =>
    t.call(t.lena.id, "conversations.list", { query: { collaborationWorkspaceId: workspaceId } });
  const readMessages = (conversationId: string) =>
    t.call(t.lena.id, "conversations.messages.list", { params: { conversationId } });
  const refusal = (response: { json(): unknown }) =>
    errorSchema.parse(response.json()).error.details;

  let builderRow: string;
  let ownConversation: string;

  it("builds in the workspace and nowhere else", async () => {
    expect(refusal(await putAgent("lena-helper", t.workspaceId))).toMatchObject({
      action: "agent.write"
    });
    builderRow = await t.grant(t.lena.id, "builder", { workspaceId: t.workspaceId });

    expectStatus(await putAgent("lena-helper", t.workspaceId), 200);
    expectStatus(await putApp(t.lena.id, "offers", t.workspaceId), 200);
    expect(refusal(await putAgent("lena-elsewhere", other))).toMatchObject({
      action: "agent.write"
    });
    expect(refusal(await putAgent("lena-instance"))).toMatchObject({ action: "agent.write" });
    expect(refusal(await putApp(t.lena.id, "offers-other", other))).toMatchObject({
      action: "app.write"
    });
    // Builder carries no delete and no publish.
    const read = await t.expectOk(t.lena.id, "assets.get", {
      params: { kind: "agent", name: "lena-helper" },
      query: { workspaceId: t.workspaceId }
    });
    const deleted = await t.call(t.lena.id, "assets.delete", {
      params: { kind: "agent", name: "lena-helper" },
      payload: {
        expectedRevision: revisionSchema.parse(read.json()).revision,
        workspaceId: t.workspaceId
      }
    });
    expect(refusal(deleted)).toMatchObject({ action: "agent.delete" });
    expect(refusal(await publishApp("offers", t.workspaceId))).toMatchObject({
      action: "app.publish"
    });
  });

  it("works there in private conversations of its own and sees no member's", async () => {
    const empty = await t.expectOk(t.lena.id, "conversations.list", {
      query: { collaborationWorkspaceId: t.workspaceId }
    });
    expect(listSchema.parse(empty.json()).items).toEqual([]);
    expect((await readMessages(membersConversation)).statusCode).toBe(404);

    const created = await t.expectOk(t.lena.id, "conversations.create", {
      payload: { title: "Build", collaborationWorkspaceId: t.workspaceId }
    });
    const conversation = conversationSchema.parse(created.json());
    ownConversation = conversation.id;
    // The workspace shares new conversations by default; a non-member's stays its own.
    expect(conversation.visibility).toBe("private");
    expectStatus(await readMessages(ownConversation), 200);
    // Unsent, it is listed to nobody yet, the builder included.
    const listed = await listConversations(t.workspaceId);
    expect(listSchema.parse(listed.json()).items.map((item) => item.id)).toEqual([]);

    // Kai, a member, does not see it.
    const kaisList = await t.expectOk(t.kai.id, "conversations.list", {
      query: { collaborationWorkspaceId: t.workspaceId }
    });
    expect(listSchema.parse(kaisList.json()).items.map((item) => item.id)).not.toContain(
      ownConversation
    );
    // Nothing opens in a workspace it holds no bundle in.
    const elsewhere = await t.call(t.lena.id, "conversations.create", {
      payload: { title: "Build", collaborationWorkspaceId: other }
    });
    expect(elsewhere.statusCode).toBe(404);
    expect((await listConversations(other)).statusCode).toBe(404);
  });

  it("publishes the workspace's assets as a Publisher, and nowhere else", async () => {
    await t.grant(t.lena.id, "publisher", { workspaceId: t.workspaceId });
    expectStatus(await publishApp("offers", t.workspaceId), 200);
    expect(refusal(await publishApp("offers-other", other))).toMatchObject({
      action: "app.publish"
    });
  });

  it("loses the building and the conversations at once when the right is revoked", async () => {
    // Publisher alone still opens the workspace; take both away.
    const publisherRow = (
      await t.stores.access.listGrants({
        clientInstanceId,
        holderId: t.lena.id,
        action: "publisher"
      })
    )[0]?.id;
    for (const grantId of [builderRow, publisherRow]) {
      await t.expectOk(t.admin.id, "permissions.revoke", { params: { grantId } });
    }
    expect(refusal(await putAgent("lena-helper-2", t.workspaceId))).toMatchObject({
      action: "agent.write"
    });
    expect((await readMessages(ownConversation)).statusCode).toBe(404);
    expect((await listConversations(t.workspaceId)).statusCode).toBe(404);
  });
});
