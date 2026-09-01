import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { asClientInstanceId, asMessageId, type MessageId } from "@vivd-catalyst/core";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres conversation store", () => {
  it("selects recent equal-timestamp messages by persisted append order", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    const sql = postgres(databaseUrl!, { max: 1 });
    const clientInstanceId = asClientInstanceId(
      `recent_messages_${globalThis.crypto.randomUUID()}`
    );
    const user = await store.createUser({ clientInstanceId, displayLabel: "Test user" });
    const personalWorkspace = await store.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: personalWorkspace.id,
      createdByUserId: user.id,
      createdByExternalUserId: "user_test",
      title: "Recent messages",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const messageIds: MessageId[] = ["first", "second", "third"].map((label) =>
      asMessageId(`msg_${label}_${globalThis.crypto.randomUUID()}`)
    );

    try {
      for (const [index, id] of messageIds.entries()) {
        await store.appendMessage({
          id,
          clientInstanceId,
          conversationId: conversation.id,
          role: "user",
          text: `Message ${index + 1}`
        });
      }
      await sql`
        update messages
        set created_at = ${"2026-08-06T10:00:00.000Z"}
        where client_instance_id = ${clientInstanceId}
          and conversation_id = ${conversation.id}
      `;

      await expect(
        store.listRecentMessages({
          clientInstanceId,
          conversationId: conversation.id,
          limit: 2
        })
      ).resolves.toMatchObject([{ id: messageIds[1] }, { id: messageIds[2] }]);
      await expect(
        store.listConversationsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: personalWorkspace.id
        })
      ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);
    } finally {
      await sql`delete from conversations where id = ${conversation.id}`;
      await sql`delete from collaboration_workspace_memberships where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
      await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
      await sql.end();
      await store.close();
    }
  });
});
