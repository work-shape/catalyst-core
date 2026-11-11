import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId } from "@work-shape/catalyst-core";
import {
  as,
  clientInstanceId,
  createChat,
  createFixture,
  required,
  share
} from "./support/chat-share-server";
import type { TestInstance, TestStore } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CHAT-SHARE-6b (chat-sharing.md 3.9): "Shared with you" lists the chats that name a person
// from workspaces they are no member of, each with its workspace's name, latest activity first.
// It never holds anything else of those workspaces, and members keep finding a shared chat in
// Recent. The fixture's `outsider` is in no workspace with the creator.

const listedSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        collaborationWorkspaceId: z.string(),
        workspaceName: z.string()
      })
      .passthrough()
  ),
  nextCursor: z.string().nullable().optional()
});

async function sharedWithMe(app: TestInstance<TestStore>, actor: string, query?: string) {
  const response = await app.call(
    "conversations.shared_from_outside.list",
    { query: query === undefined ? {} : { query } },
    as(actor)
  );
  expect(response.statusCode, response.body).toBe(200);
  return listedSchema.parse(response.json()).items;
}

const peopleSchema = z.object({
  conversation: z.object({
    people: z.array(z.object({ userId: z.string(), deactivated: z.literal(true).optional() }))
  })
});

describe("CHAT-SHARE-6b: the chats shared with a person from outside their workspaces", () => {
  it("lists only chats that name them from a workspace they are no member of, with its name alone", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    // Nothing before a share.
    expect(await sharedWithMe(app, "outsider")).toEqual([]);

    // Beside the chat shared with them: a team chat, another private chat of the creator, and
    // a chat shared with a member only. None of them names the outsider.
    // The team chat is one the whole workspace reads.
    const teamChat = await createChat(app, workspaceId, "Team notes");
    await withTestSql(
      (sql) => sql`update conversations set visibility = 'workspace' where id = ${teamChat}`
    );
    await createChat(app, workspaceId, "Private draft");
    const withMember = await createChat(app, workspaceId, "Member only");
    expect((await share(app, withMember, ids.named)).statusCode).toBe(200);
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);

    const listed = await sharedWithMe(app, "outsider");
    expect(listed.map(({ id, title, workspaceName }) => ({ id, title, workspaceName }))).toEqual([
      { id: conversationId, title: "Quarter figures", workspaceName: "Team" }
    ]);
    // The workspace's name is all of it the item carries: no other chat, no workspace field.
    const body = JSON.stringify(listed);
    for (const other of [teamChat, withMember]) {
      expect(body).not.toContain(other);
    }
    expect(Object.keys(required(listed[0])).filter((key) => key.startsWith("workspace"))).toEqual([
      "workspaceName"
    ]);

    // A member named on a chat finds it in Recent, never here; nobody else gets anything.
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    for (const actor of ["named", "colleague", "owner", "creator"]) {
      expect(await sharedWithMe(app, actor), actor).toEqual([]);
    }

    // The palette's search: by title, without regard to case.
    expect((await sharedWithMe(app, "outsider", "quarter")).map(({ id }) => id)).toEqual([
      conversationId
    ]);
    expect(await sharedWithMe(app, "outsider", "Team notes")).toEqual([]);

    // Latest activity first.
    const later = await createChat(app, workspaceId, "Later figures");
    expect((await share(app, later, ids.outsider)).statusCode).toBe(200);
    await withTestSql(
      (sql) =>
        sql`update conversations set updated_at = now() + interval '1 minute' where id = ${later}`
    );
    expect((await sharedWithMe(app, "outsider")).map(({ id }) => id)).toEqual([
      later,
      conversationId
    ]);
    const firstPage = await app.call(
      "conversations.shared_from_outside.list",
      { query: { limit: "1" } },
      as("outsider")
    );
    expect(listedSchema.parse(firstPage.json()).items.map(({ id }) => id)).toEqual([later]);

    // A removal takes the chat off at once.
    const removed = await app.call(
      "conversations.remove_person",
      { params: { conversationId: later, userId: ids.outsider } },
      as("creator")
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await sharedWithMe(app, "outsider")).map(({ id }) => id)).toEqual([conversationId]);

    // One who joins the team finds the chat in Recent instead.
    const joined = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { email: "outsider@example.test" }
      },
      as("owner")
    );
    expect(joined.statusCode, joined.body).toBe(200);
    expect(await sharedWithMe(app, "outsider")).toEqual([]);
    const left = await app.call(
      "workspaces.members.leave",
      { params: { collaborationWorkspaceId: workspaceId } },
      as("outsider")
    );
    expect(left.statusCode, left.body).toBe(200);
    expect(await sharedWithMe(app, "outsider")).toEqual([]);

    // A workspace whose deletion was requested is closed: it lists nothing.
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    expect(await sharedWithMe(app, "outsider")).toHaveLength(1);
    await withTestSql(
      (sql) =>
        sql`update collaboration_workspaces set deletion_requested_at = now() where id = ${workspaceId}`
    );
    expect(await sharedWithMe(app, "outsider")).toEqual([]);
    await app.close();
  });

  it("shows a deactivated named person as deactivated to the chat's readers, until they are active again", async () => {
    const { app, ids, conversationId } = await createFixture();
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const people = async (actor: string) =>
      peopleSchema.parse(
        (
          await app.call("conversations.thread.get", { params: { conversationId } }, as(actor))
        ).json()
      ).conversation.people;

    expect((await people("creator")).filter((person) => person.deactivated)).toEqual([]);
    await app.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(ids.outsider),
      status: "disabled"
    });
    for (const actor of ["creator", "named"]) {
      expect(await people(actor), actor).toEqual([
        expect.objectContaining({ userId: ids.outsider, deactivated: true }),
        expect.not.objectContaining({ deactivated: true })
      ]);
    }
    await app.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(ids.outsider),
      status: "active"
    });
    expect((await people("creator")).filter((person) => person.deactivated)).toEqual([]);

    // A requested deletion shows the same until the deletion takes the row; the creator can
    // remove them meanwhile.
    await withTestSql(
      (sql) => sql`update product_users set deletion_requested_at = now() where id = ${ids.named}`
    );
    expect(await people("creator")).toEqual([
      expect.not.objectContaining({ deactivated: true }),
      expect.objectContaining({ userId: ids.named, deactivated: true })
    ]);
    const removed = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.named } },
      as("creator")
    );
    expect(removed.statusCode, removed.body).toBe(200);
    await app.close();
  });
});
