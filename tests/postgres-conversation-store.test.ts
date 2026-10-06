import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  type ConversationId,
  type ManagedFileId,
  type MessageId
} from "@vivd-catalyst/core";
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
      visibility: "workspace",
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
      const firstCheckpointMessage = await store.appendAssistantMessage({
        clientInstanceId,
        conversationId: conversation.id,
        text: "First checkpoint",
        providerContinuation: {
          providerId: "test-provider",
          state: { checkpoint: "first" }
        }
      });
      const latestCheckpointMessage = await store.appendAssistantMessage({
        clientInstanceId,
        conversationId: conversation.id,
        text: "Latest checkpoint",
        providerContinuation: {
          providerId: "test-provider",
          state: { checkpoint: "latest" }
        }
      });
      await sql`
        insert into model_provider_continuations (
          client_instance_id, conversation_id, provider_id, state, source_message_id,
          source_storage_ordinal, updated_at
        )
        select
          client_instance_id, conversation_id, 'test-provider', ${sql.json({ checkpoint: "stale" })},
          id, storage_ordinal, created_at
        from messages
        where id = ${firstCheckpointMessage.id}
        on conflict (client_instance_id, conversation_id, provider_id) do update
        set
          state = excluded.state,
          source_message_id = excluded.source_message_id,
          source_storage_ordinal = excluded.source_storage_ordinal,
          updated_at = excluded.updated_at
        where model_provider_continuations.source_storage_ordinal
          < excluded.source_storage_ordinal
      `;
      await expect(
        store.getModelProviderContinuation({
          clientInstanceId,
          conversationId: conversation.id,
          providerId: "test-provider"
        })
      ).resolves.toMatchObject({
        state: { checkpoint: "latest" },
        sourceMessageId: latestCheckpointMessage.id
      });
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
      ).resolves.toMatchObject([
        { id: firstCheckpointMessage.id },
        { id: latestCheckpointMessage.id }
      ]);
      await expect(
        store.listConversationsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: personalWorkspace.id,
          scope: { kind: "lifecycle" }
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

  it("lists and expires message-less conversations by their draft attachments", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    const sql = postgres(databaseUrl!, { max: 1 });
    const clientInstanceId = asClientInstanceId(`unsent_drafts_${globalThis.crypto.randomUUID()}`);
    const user = await store.createUser({ clientInstanceId, displayLabel: "Author" });
    const workspace = await store.ensurePersonalWorkspace({ clientInstanceId, userId: user.id });
    const conversation = await store.createConversation({
      visibility: "workspace",
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      createdByUserId: user.id,
      createdByExternalUserId: "user_test",
      title: "2 attached files",
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
    const listedFor = async (userId: string) =>
      (
        await store.listConversationsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          scope: { kind: "viewer", userId }
        })
      ).map(({ id }) => id);
    const now = new Date().toISOString();
    const expiredWith = async (abandonedBefore?: string) =>
      (
        await store.listExpiredConversations({ clientInstanceId, now, abandonedBefore, limit: 10 })
      ).map(({ id }) => id);
    const later = "2998-01-01T00:00:00.000Z";

    try {
      await expect(listedFor(user.id)).resolves.toEqual([]);
      await expect(
        store.listConversationsForWorkspace({
          clientInstanceId,
          collaborationWorkspaceId: workspace.id,
          scope: { kind: "lifecycle" }
        })
      ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);

      const file = await store.createManagedFile({
        clientInstanceId,
        ownerUserId: user.id,
        filename: "draft.txt",
        byteSize: 5,
        checksum: "draft",
        objectKey: `files/${conversation.id}/draft`
      });
      const attachment = await store.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready"
      });
      await expect(listedFor(user.id)).resolves.toEqual([conversation.id]);
      await expect(listedFor("usr_colleague")).resolves.toEqual([]);
      await expect(expiredWith(later)).resolves.toEqual([]);

      await store.deleteDraftAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        attachmentId: attachment.id,
        deletedAt: new Date().toISOString()
      });
      await expect(listedFor(user.id)).resolves.toEqual([]);
      await expect(expiredWith()).resolves.toEqual([]);
      await expect(expiredWith("2000-01-01T00:00:00.000Z")).resolves.toEqual([]);
      await expect(expiredWith(later)).resolves.toEqual([conversation.id]);
      // Without `now` only the abandoned criterion applies, whatever the stamped date.
      await expect(
        store.listExpiredConversations({ clientInstanceId, abandonedBefore: later, limit: 10 })
      ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);
      await expect(
        store.listExpiredConversations({ clientInstanceId, limit: 10 })
      ).resolves.toEqual([]);

      await store.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "First message"
      });
      await expect(listedFor(user.id)).resolves.toEqual([conversation.id]);
      await expect(listedFor("usr_colleague")).resolves.toEqual([conversation.id]);
      await expect(expiredWith(later)).resolves.toEqual([]);
      // A started conversation past its date is not returned without `now`.
      await expect(
        store.listExpiredConversations({
          clientInstanceId,
          now: "3000-01-01T00:00:00.000Z",
          limit: 10
        })
      ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);
      await expect(
        store.listExpiredConversations({ clientInstanceId, abandonedBefore: later, limit: 10 })
      ).resolves.toEqual([]);
    } finally {
      await sql`delete from conversations where id = ${conversation.id}`;
      await sql`delete from managed_files where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspace_memberships where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
      await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
      await sql.end();
      await store.close();
    }
  });

  it("finds and marks only managed files without an active conversation", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    const sql = postgres(databaseUrl!, { max: 1 });
    const clientInstanceId = asClientInstanceId(`orphan_files_${globalThis.crypto.randomUUID()}`);
    const user = await store.createUser({ clientInstanceId, displayLabel: "Test user" });
    const personalWorkspace = await store.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const createConversation = (title: string) =>
      store.createConversation({
        visibility: "workspace",
        clientInstanceId,
        collaborationWorkspaceId: personalWorkspace.id,
        createdByUserId: user.id,
        createdByExternalUserId: "user_test",
        title,
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
    const createFile = (name: string, objectKey = `orphan-test/${clientInstanceId}/${name}`) =>
      store.createManagedFile({
        clientInstanceId,
        ownerUserId: user.id,
        filename: name,
        byteSize: 1,
        checksum: name,
        objectKey
      });
    const attach = (
      conversationId: ConversationId,
      file: { id: ManagedFileId; filename: string }
    ) =>
      store.createConversationAttachment({
        clientInstanceId,
        conversationId,
        fileId: file.id,
        filename: file.filename,
        byteSize: 1,
        checksum: file.filename,
        status: "ready"
      });
    const active = await createConversation("Active");
    const softDeleted = await createConversation("Deleted without object cleanup");
    const hardDeleted = await createConversation("Removed with its user");

    try {
      const attached = await createFile("attached");
      await attach(active.id, attached);
      const removedDraft = await createFile("removed-draft");
      const removedDraftAttachment = await attach(active.id, removedDraft);
      await store.deleteDraftAttachment({
        clientInstanceId,
        conversationId: active.id,
        attachmentId: removedDraftAttachment.id,
        deletedAt: new Date().toISOString()
      });
      const artifactSource = await createFile("artifact-source");
      await store.createManagedArtifact({
        clientInstanceId,
        conversationId: active.id,
        sourceFileId: artifactSource.id,
        kind: "test.preview",
        objectKey: `orphan-test/${clientInstanceId}/artifact`,
        mimeType: "text/plain",
        byteSize: 1,
        checksum: "artifact"
      });
      const neverAttached = await createFile("never-attached");
      const inSoftDeleted = await createFile("in-soft-deleted");
      await attach(softDeleted.id, inSoftDeleted);
      await store.deleteConversation({
        clientInstanceId,
        conversationId: softDeleted.id,
        deletedAt: new Date().toISOString()
      });
      const inHardDeleted = await createFile("in-hard-deleted");
      await attach(hardDeleted.id, inHardDeleted);
      await sql`delete from conversations where id = ${hardDeleted.id}`;
      // Stores its bytes under the object key of a file that an active conversation uses.
      const sharedKey = await createFile("shared-key", attached.objectKey);

      const orphanIds = [neverAttached, inSoftDeleted, inHardDeleted, sharedKey]
        .map((file) => file.id)
        .sort();
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      await expect(
        store.listOrphanedManagedFiles({ clientInstanceId, createdBefore: past, limit: 10 })
      ).resolves.toEqual([]);

      const listed = await store.listOrphanedManagedFiles({
        clientInstanceId,
        createdBefore: future,
        limit: 10
      });
      expect(listed.map((file) => file.id)).toEqual(orphanIds);
      expect(listed.filter((file) => file.objectKeyInUse).map((file) => file.id)).toEqual([
        sharedKey.id
      ]);
      const firstPage = await store.listOrphanedManagedFiles({
        clientInstanceId,
        createdBefore: future,
        limit: 3
      });
      const secondPage = await store.listOrphanedManagedFiles({
        clientInstanceId,
        createdBefore: future,
        afterFileId: firstPage.at(-1)!.id,
        limit: 3
      });
      expect([...firstPage, ...secondPage].map((file) => file.id)).toEqual(orphanIds);

      const everyFileId = [attached, removedDraft, artifactSource].map((file) => file.id);
      await expect(
        store.markOrphanedManagedFilesDeleted({
          clientInstanceId,
          fileIds: [...everyFileId, ...orphanIds],
          createdBefore: future,
          deletedAt: new Date().toISOString()
        })
      ).resolves.toBe(orphanIds.length);
      for (const fileId of everyFileId) {
        await expect(store.getManagedFile({ clientInstanceId, fileId })).resolves.toMatchObject({
          status: "available"
        });
      }
      for (const fileId of orphanIds) {
        await expect(store.getManagedFile({ clientInstanceId, fileId })).resolves.toBeUndefined();
      }
      await expect(
        store.listOrphanedManagedFiles({ clientInstanceId, createdBefore: future, limit: 10 })
      ).resolves.toEqual([]);
    } finally {
      await sql`delete from conversations where client_instance_id = ${clientInstanceId}`;
      await sql`delete from managed_files where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspace_memberships where client_instance_id = ${clientInstanceId}`;
      await sql`delete from collaboration_workspaces where client_instance_id = ${clientInstanceId}`;
      await sql`delete from product_users where client_instance_id = ${clientInstanceId}`;
      await sql.end();
      await store.close();
    }
  });

  it("persists fast mode and the reported service tier with a usage event", async () => {
    const store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    const sql = postgres(databaseUrl!, { max: 1 });
    const clientInstanceId = asClientInstanceId(`usage_fast_${globalThis.crypto.randomUUID()}`);
    const event = {
      clientInstanceId,
      conversationId: asConversationId("conv_usage_fast"),
      agentRunId: asAgentRunId("run_usage_fast"),
      agentName: "agent",
      providerId: "azure-eu",
      model: "gpt",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      webSearchCallCount: 0,
      source: "provider_reported" as const,
      customerBillableCost: {
        status: "unpriced" as const,
        source: "rate_card" as const,
        calculationVersion: 1 as const,
        missingMeters: ["model_rate" as const]
      },
      correlationId: "corr_usage_fast"
    };

    try {
      await store.appendModelUsageEvent({ ...event, fastMode: false });
      await store.appendModelUsageEvent({
        ...event,
        fastMode: true,
        providerServiceTier: "priority"
      });

      const stored = await store.listModelUsageEvents({ clientInstanceId });
      expect(stored.filter((candidate) => !candidate.fastMode)).toEqual([
        expect.not.objectContaining({ providerServiceTier: expect.anything() })
      ]);
      expect(stored.filter((candidate) => candidate.fastMode)).toEqual([
        expect.objectContaining({ fastMode: true, providerServiceTier: "priority" })
      ]);
    } finally {
      await sql`delete from model_usage_events where client_instance_id = ${clientInstanceId}`;
      await sql.end();
      await store.close();
    }
  });
});
