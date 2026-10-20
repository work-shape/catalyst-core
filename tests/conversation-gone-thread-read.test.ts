import { describe, expect, it } from "vitest";
import { asClientInstanceId, asConversationId } from "@work-shape/catalyst-core";
import { createTestConfig, seedConversationMessage } from "./support/fixtures";
import { createTestInstance, type TestInstance } from "./support/test-instance";

// A conversation's address that leads nowhere: deleted, expired, in a workspace the reader does
// not reach, or never made. The interface shows "This conversation no longer exists" for a
// refused thread read, so every one of them must be refused, and refused alike: an answer that
// told them apart would say that a closed conversation exists.

const clientInstanceId = asClientInstanceId("demo-local");

function identity(id: string) {
  return {
    id,
    externalUserId: id,
    displayLabel: id,
    email: `${id}@example.test`,
    emailVerified: true,
    roles: ["user"],
    permissionRefs: ["demo-tools"]
  };
}

async function createApp() {
  return createTestInstance({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "reader",
        users: [identity("reader"), identity("outsider")]
      }
    }),
    tools: []
  });
}

/** A conversation of `actor` with one message, so it is a conversation and not a draft. */
async function createConversation(app: TestInstance, actor: string): Promise<string> {
  const created = await app.call("conversations.create", { payload: { title: "Notes" } }, actor);
  expect(created.statusCode).toBe(200);
  const conversationId = created.json<{ id: string }>().id;
  await seedConversationMessage(app.stores.conversations, conversationId);
  return conversationId;
}

async function readThread(app: TestInstance, conversationId: string) {
  const response = await app.call(
    "conversations.thread.get",
    { params: { conversationId } },
    "reader"
  );
  return {
    statusCode: response.statusCode,
    error: response.json<{ error: { code: string; message: string } }>().error
  };
}

const refusal = {
  statusCode: 404,
  error: expect.objectContaining({ code: "NOT_FOUND", message: "Conversation is not available" })
};

describe("the thread read of a conversation that is gone", () => {
  it("refuses a deleted conversation", async () => {
    const app = await createApp();
    const conversationId = await createConversation(app, "reader");
    expect((await readThread(app, conversationId)).statusCode).toBe(200);

    const deleted = await app.call(
      "conversations.delete",
      { params: { conversationId } },
      "reader"
    );
    expect(deleted.statusCode).toBe(200);

    await expect(readThread(app, conversationId)).resolves.toEqual(refusal);
    await app.close();
  });

  it("refuses a conversation whose retention expired", async () => {
    const app = await createApp();
    const conversationId = await createConversation(app, "reader");
    expect((await readThread(app, conversationId)).statusCode).toBe(200);

    // The retention job's own step, at a moment after the conversation's retention date.
    const later = new Date(Date.UTC(2100, 0, 1)).toISOString();
    await expect(
      app.stores.conversations.expireConversation({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        expiredAt: later,
        now: later
      })
    ).resolves.toMatchObject({ status: "expired" });

    await expect(readThread(app, conversationId)).resolves.toEqual(refusal);
    await app.close();
  });

  it("refuses a conversation in a workspace the reader does not reach", async () => {
    const app = await createApp();
    // The outsider's own conversation lies in the outsider's Personal Workspace.
    const conversationId = await createConversation(app, "outsider");

    await expect(readThread(app, conversationId)).resolves.toEqual(refusal);
    await app.close();
  });

  it("refuses an address no conversation ever had", async () => {
    const app = await createApp();

    await expect(readThread(app, "conv_never_made")).resolves.toEqual(refusal);
    await app.close();
  });
});
