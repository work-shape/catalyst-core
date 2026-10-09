import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  asManagedArtifactId,
  type CollaborationWorkspace,
  type Conversation
} from "@vivd-catalyst/core";
import { settled, waitUntilBlocked } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import type { TestPostgresStore } from "./support/test-instance";
import { RecordingByteStore, createTestManagedObjectAccess } from "./support/retention-harness";

const NOT_AVAILABLE = { code: "NOT_FOUND", message: "Conversation is not available" };

describe("Postgres writes into a conversation that is being deleted", () => {
  // The first pool takes a row lock, the second waits for it, and the barrier is the test's own
  // transaction that pins the first side in the middle of its work.
  const db = usePostgresSuite("writelock");

  async function createFixture(label: string) {
    const clientInstanceId = db.clientInstance(label);
    const scope = { clientInstanceId };
    const user = await db.store.createUser({ clientInstanceId, displayLabel: "Author" });
    const personalWorkspace = await db.store.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const byteStore = new RecordingByteStore();
    /** Writes through the second pool, as a run does that works while the first side deletes. */
    const writer = createTestManagedObjectAccess({
      clientInstanceId,
      files: db.secondStore,
      byteStore
    });
    const now = () => new Date().toISOString();

    const createSharedWorkspace = (name: string) =>
      db.store.createWorkspace({
        clientInstanceId,
        kind: "shared",
        name,
        visibility: "discoverable",
        creatorUserId: user.id
      });
    const conversationInput = (title: string, workspace: CollaborationWorkspace) => ({
      visibility: "workspace" as const,
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: user.id,
      createdByExternalUserId: "user_test",
      title,
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    /** A Conversation with one message. */
    const createConversation = async (
      title: string,
      workspace: CollaborationWorkspace = personalWorkspace
    ) => {
      const conversation = await db.store.createConversation(conversationInput(title, workspace));
      const message = await db.store.appendMessage({
        ...scope,
        conversationId: conversation.id,
        role: "user",
        text: `message for ${title}`
      });
      return { conversation, message };
    };
    const artifactInput = (conversation: Conversation, name: string) => ({
      conversationId: conversation.id,
      kind: "test.output",
      filename: `${name}.txt`,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(name)
    });
    const artifactRow = (conversation: Conversation, name: string) => ({
      ...scope,
      conversationId: conversation.id,
      kind: "test.output",
      objectKey: `artifacts/${conversation.id}/${name}`,
      filename: `${name}.txt`,
      mimeType: "text/plain",
      byteSize: name.length,
      checksum: name
    });
    const deleteConversation = (store: TestPostgresStore, conversation: Conversation) =>
      store.deleteConversation({ ...scope, conversationId: conversation.id, deletedAt: now() });
    /**
     * The deletion claim removes the messages after it has taken the Conversation lock, so a
     * row lock on a message holds it there.
     */
    const holdAtMessage = (messageId: string) =>
      db.hold((tx) => tx`select 1 from messages where id = ${messageId} for update`);
    /** A hard delete removes the Conversation rows after its checks; this holds it there. */
    const holdAtConversation = (conversation: Conversation) =>
      db.hold((tx) => tx`select 1 from conversations where id = ${conversation.id} for update`);
    const artifactRows = async (conversation: Conversation) =>
      db.sql<Array<{ status: string; object_key: string }>>`
        select status, object_key from managed_artifacts
        where conversation_id = ${conversation.id}
        order by created_at
      `;
    const count = async (query: postgres.PendingQuery<Array<{ count: number }>>) =>
      (await query)[0]?.count;
    const messageCount = (conversation: Conversation) =>
      count(db.sql`
        select count(*)::int as count from messages where conversation_id = ${conversation.id}
      `);
    const conversationsIn = (workspace: CollaborationWorkspace) =>
      count(db.sql`
        select count(*)::int as count from conversations
        where collaboration_workspace_id = ${workspace.id}
      `);
    const workspaceRows = (workspace: CollaborationWorkspace) =>
      count(db.sql`
        select count(*)::int as count from collaboration_workspaces where id = ${workspace.id}
      `);
    const pending = () => db.store.listConversationsPendingObjectCleanup({ ...scope, limit: 10 });

    return {
      clientInstanceId,
      scope,
      user,
      personalWorkspace,
      byteStore,
      writer,
      now,
      createSharedWorkspace,
      conversationInput,
      createConversation,
      artifactInput,
      artifactRow,
      deleteConversation,
      holdAtMessage,
      holdAtConversation,
      artifactRows,
      messageCount,
      conversationsIn,
      workspaceRows,
      pending
    };
  }

  it("refuses an artifact that waited for the deletion claim, and removes its bytes", async () => {
    const fixture = await createFixture("artifact_waits");
    const { conversation, message } = await fixture.createConversation("deleted under a run");
    const held = await fixture.holdAtMessage(message.id);

    const deletion = settled(fixture.deleteConversation(db.store, conversation));
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const insert = settled(
      fixture.writer.createArtifact(fixture.artifactInput(conversation, "late"))
    );
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();

    expect(await deletion).toMatchObject({ status: "fulfilled", value: { status: "deleted" } });
    expect(await insert).toMatchObject({ status: "rejected", reason: NOT_AVAILABLE });
    await expect(fixture.artifactRows(conversation)).resolves.toEqual([]);
    await expect(fixture.pending()).resolves.toEqual([]);
    // The writer had stored the bytes before it asked for the row.
    expect(fixture.byteStore.deletedKeys).toHaveLength(1);
    expect(fixture.byteStore.keys()).toEqual([]);
  });

  it("refuses an artifact while cleanup's marking transaction is open", async () => {
    const fixture = await createFixture("artifact_marking");
    const { conversation } = await fixture.createConversation("being cleaned");
    const existing = await fixture.writer.createArtifact(
      fixture.artifactInput(conversation, "existing")
    );
    await fixture.deleteConversation(db.store, conversation);
    // The marking transaction updates the artifact rows last, so a row lock on one holds it
    // open after it has listed what it will mark.
    const held = await db.hold(
      (tx) => tx`select 1 from managed_artifacts where id = ${existing.id} for update`
    );
    const marking = settled(
      db.store.markConversationManagedObjectsDeleted({
        ...fixture.scope,
        conversationId: conversation.id,
        deletedAt: fixture.now()
      })
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });

    const insert = await settled(
      db.secondStore.createManagedArtifact(fixture.artifactRow(conversation, "late"))
    );
    await held.commit();

    expect(insert).toMatchObject({ status: "rejected", reason: NOT_AVAILABLE });
    expect(await marking).toMatchObject({ status: "fulfilled" });
    await expect(fixture.artifactRows(conversation)).resolves.toEqual([
      { status: "deleted", object_key: existing.objectKey }
    ]);
    await expect(fixture.pending()).resolves.toEqual([]);
  });

  it("cleans an artifact whose insert held the lock before the claim", async () => {
    const fixture = await createFixture("artifact_first");
    const { conversation } = await fixture.createConversation("written first");
    const seed = await fixture.writer.createArtifact(fixture.artifactInput(conversation, "seed"));
    const early = {
      ...fixture.artifactRow(conversation, "early"),
      id: asManagedArtifactId(`art_${globalThis.crypto.randomUUID()}`)
    };
    await fixture.byteStore.putObject({ key: early.objectKey, body: new Uint8Array([1]) });
    // An uncommitted row with the same id makes the insert wait in the middle of its
    // transaction, with the Conversation lock taken.
    const held = await db.hold(
      (tx) => tx`
        insert into managed_artifacts
        select (jsonb_populate_record(
          null::managed_artifacts,
          to_jsonb(ma) || jsonb_build_object('id', ${early.id}::text)
        )).*
        from managed_artifacts ma
        where ma.id = ${seed.id}
      `
    );

    const insert = settled(db.secondStore.ensureManagedArtifact(early));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.barrier });
    const deletion = settled(fixture.deleteConversation(db.store, conversation));
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.second });
    await held.rollback();

    expect(await insert).toMatchObject({ status: "fulfilled", value: { id: early.id } });
    expect(await deletion).toMatchObject({ status: "fulfilled", value: { status: "deleted" } });
    await expect(fixture.pending()).resolves.toEqual([conversation.id]);

    await fixture.writer.deleteConversationObjects({
      conversationId: conversation.id,
      deletedAt: fixture.now()
    });

    expect(fixture.byteStore.keys()).toEqual([]);
    expect([...fixture.byteStore.deletedKeys].sort()).toEqual(
      [seed.objectKey, early.objectKey].sort()
    );
    await expect(fixture.artifactRows(conversation)).resolves.toEqual([
      { status: "deleted", object_key: seed.objectKey },
      { status: "deleted", object_key: early.objectKey }
    ]);
    await expect(fixture.pending()).resolves.toEqual([]);
  });

  it("refuses an artifact, an ensured artifact and a workspace file in a deleted conversation", async () => {
    const fixture = await createFixture("refused");
    const { conversation } = await fixture.createConversation("deleted");
    const workspace = await db.store.ensureExecutionWorkspace({
      ...fixture.scope,
      conversationId: conversation.id,
      ownerUserId: fixture.user.id,
      now: fixture.now()
    });
    await fixture.deleteConversation(db.store, conversation);

    await expect(
      db.secondStore.createManagedArtifact(fixture.artifactRow(conversation, "late"))
    ).rejects.toMatchObject(NOT_AVAILABLE);
    await expect(
      db.secondStore.ensureManagedArtifact({
        ...fixture.artifactRow(conversation, "ensured"),
        id: asManagedArtifactId(`art_${globalThis.crypto.randomUUID()}`)
      })
    ).rejects.toMatchObject(NOT_AVAILABLE);
    await expect(
      db.secondStore.upsertWorkspaceFile({
        ...fixture.scope,
        workspaceId: workspace.id,
        path: "late.csv",
        objectKey: `execution-workspaces/${conversation.id}/late.csv`,
        byteSize: 4,
        checksum: "late",
        updatedAt: fixture.now()
      })
    ).rejects.toMatchObject(NOT_AVAILABLE);

    await expect(fixture.artifactRows(conversation)).resolves.toEqual([]);
    await expect(
      db.sql`select path from execution_workspace_files where workspace_id = ${workspace.id}`
    ).resolves.toEqual([]);
  });

  it("refuses an assistant message that waited for the user's deletion", async () => {
    const fixture = await createFixture("message_waits");
    const { conversation, message } = await fixture.createConversation("deleted under a run");
    const held = await fixture.holdAtMessage(message.id);

    const deletion = settled(fixture.deleteConversation(db.store, conversation));
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const append = settled(
      db.secondStore.appendAssistantMessage({
        ...fixture.scope,
        conversationId: conversation.id,
        text: "An answer that arrives too late"
      })
    );
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();

    expect(await deletion).toMatchObject({ status: "fulfilled", value: { status: "deleted" } });
    expect(await append).toMatchObject({ status: "rejected", reason: NOT_AVAILABLE });
    await expect(fixture.messageCount(conversation)).resolves.toBe(0);
    await expect(
      db.secondStore.appendMessage({
        ...fixture.scope,
        conversationId: conversation.id,
        role: "user",
        text: "A message after the deletion"
      })
    ).rejects.toMatchObject(NOT_AVAILABLE);
    await expect(fixture.messageCount(conversation)).resolves.toBe(0);
  });

  describe("hard delete of a workspace", () => {
    /** A workspace with one deleted Conversation whose data is gone, ready for the hard delete. */
    async function createDeletableWorkspace(label: string, kind: "shared" | "personal") {
      const fixture = await createFixture(label);
      const workspace =
        kind === "shared"
          ? await fixture.createSharedWorkspace("Shared")
          : fixture.personalWorkspace;
      const { conversation: removed } = await fixture.createConversation("removed", workspace);
      await fixture.deleteConversation(db.store, removed);
      const hardDelete = () =>
        kind === "shared"
          ? db.store.deleteWorkspace({
              ...fixture.scope,
              collaborationWorkspaceId: workspace.id
            })
          : db.store.deletePersonalWorkspaceForUser({
              ...fixture.scope,
              userId: fixture.user.id
            });
      return { fixture, workspace, removed, hardDelete };
    }

    it.each(["shared", "personal"] as const)(
      "makes a conversation created in a %s workspace wait, and fail, while the delete runs",
      async (kind) => {
        const { fixture, workspace, removed, hardDelete } = await createDeletableWorkspace(
          `create_${kind}`,
          kind
        );
        const held = await fixture.holdAtConversation(removed);

        const deletion = settled(hardDelete());
        await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
        const creation = settled(
          db.secondStore.createConversation(fixture.conversationInput("too late", workspace))
        );
        await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
        await held.commit();

        expect(await deletion).toMatchObject({ status: "fulfilled" });
        expect(await creation).toMatchObject({ status: "rejected" });
        await expect(fixture.workspaceRows(workspace)).resolves.toBe(0);
        // The delete removed the one Conversation it saw. The late one never existed.
        await expect(
          db.sql`select id from conversations where client_instance_id = ${fixture.clientInstanceId}`
        ).resolves.toEqual([]);
      }
    );

    it("makes a move into the workspace wait, and fail, while the delete runs", async () => {
      const { fixture, workspace, removed, hardDelete } = await createDeletableWorkspace(
        "move",
        "shared"
      );
      const { conversation: moving } = await fixture.createConversation("moving");
      const held = await fixture.holdAtConversation(removed);

      const deletion = settled(hardDelete());
      await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
      const move = settled(
        db.secondStore.moveConversation({
          ...fixture.scope,
          conversationId: moving.id,
          fromCollaborationWorkspaceId: fixture.personalWorkspace.id,
          toCollaborationWorkspaceId: workspace.id,
          visibility: "workspace"
        })
      );
      await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
      await held.commit();

      expect(await deletion).toMatchObject({ status: "fulfilled" });
      expect(await move).toMatchObject({ status: "rejected" });
      await expect(fixture.workspaceRows(workspace)).resolves.toBe(0);
      // The Conversation stays where it was, with its message.
      await expect(
        db.store.getConversation(fixture.clientInstanceId, moving.id)
      ).resolves.toMatchObject({
        status: "active",
        collaborationWorkspaceId: fixture.personalWorkspace.id
      });
      await expect(fixture.messageCount(moving)).resolves.toBe(1);
    });

    it("answers CONFLICT when a conversation was created just before the delete's lock", async () => {
      const { fixture, workspace, hardDelete } = await createDeletableWorkspace(
        "create_first",
        "shared"
      );
      // A Conversation whose insert is not committed yet. It holds the key-share lock on the
      // workspace row that every insert of a Conversation takes through the foreign key.
      const template = await fixture.createConversation("template");
      const createdId = `conv_${globalThis.crypto.randomUUID()}`;
      const held = await db.hold(
        (tx) => tx`
          insert into conversations
          select (jsonb_populate_record(
            null::conversations,
            to_jsonb(c) || jsonb_build_object(
              'id', ${createdId}::text,
              'collaboration_workspace_id', ${workspace.id}::text
            )
          )).*
          from conversations c
          where c.id = ${template.conversation.id}
        `
      );

      const deletion = settled(hardDelete());
      await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
      await held.commit();

      expect(await deletion).toMatchObject({
        status: "rejected",
        reason: { code: "CONFLICT", message: "Workspace still contains conversations" }
      });
      await expect(fixture.workspaceRows(workspace)).resolves.toBe(1);
      await expect(fixture.conversationsIn(workspace)).resolves.toBe(2);
    });
  });
});
