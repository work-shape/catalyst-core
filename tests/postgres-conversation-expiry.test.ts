import type { PlatformStores } from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asMessageId,
  type Conversation,
  type ManagedFileRecord,
  type PrepareConversationRunStartInput
} from "@vivd-catalyst/core";
import { settled, waitUntilBlocked } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Postgres conversation expiry claim", () => {
  // The first pool takes the Conversation row lock, the second waits for it, and the barrier is
  // the test's own transaction that pins the first side in the middle of its work.
  const db = usePostgresSuite("expiry");

  async function createFixture(label: string) {
    const clientInstanceId = db.clientInstance(label);
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Author" });
    const workspace = await db.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: user.id
    });
    const now = new Date();
    const criteria = {
      now: now.toISOString(),
      abandonedBefore: new Date(now.getTime() - DAY_MS).toISOString()
    };

    const createConversation = (title: string, retainedUntil = "2999-01-01T00:00:00.000Z") =>
      db.store.conversations.createConversation({
        visibility: "workspace",
        clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        createdByUserId: user.id,
        createdByExternalUserId: "user_test",
        title,
        retainedUntil
      });
    /** Moves the last touch behind the abandoned-draft grace period. */
    const age = async (conversation: Conversation) => {
      await db.sql`
        update conversations
        set updated_at = ${new Date(now.getTime() - 3 * DAY_MS)}
        where id = ${conversation.id}
      `;
    };
    const createFile = (conversation: Conversation, name: string) =>
      db.store.files.createManagedFile({
        clientInstanceId,
        ownerUserId: user.id,
        filename: `${name}.txt`,
        byteSize: 5,
        checksum: name,
        objectKey: `files/${conversation.id}/${name}`
      });
    const attach = (conversation: Conversation, file: ManagedFileRecord) =>
      db.store.files.createConversationAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        fileId: file.id,
        filename: file.filename,
        byteSize: file.byteSize,
        checksum: file.checksum,
        status: "ready"
      });
    /** A draft whose only upload was removed again: no message, no draft attachment. */
    const createAbandonedDraft = async (title: string) => {
      const conversation = await createConversation(title);
      const file = await createFile(conversation, `${title}-removed`);
      const attachment = await attach(conversation, file);
      await db.store.files.deleteDraftAttachment({
        clientInstanceId,
        conversationId: conversation.id,
        attachmentId: attachment.id,
        deletedAt: now.toISOString()
      });
      await age(conversation);
      return { conversation, file, attachment };
    };
    /**
     * A claimed run start command and the acceptance input that completes it. The acceptance
     * writes the command last, after the message and the run, so a row lock on the command
     * holds it in the middle of its transaction with the Conversation lock taken.
     */
    const claimAcceptance = async (conversation: Conversation) => {
      const id = globalThis.crypto.randomUUID();
      const idempotencyKey = `key_${id}`;
      const claim = await db.store.agentRuns.claimRunStartCommand({
        clientInstanceId,
        ownerUserId: user.id,
        idempotencyKey,
        commandKind: "start_conversation_run"
      });
      const messageId = asMessageId(`msg_${id}`);
      const input: PrepareConversationRunStartInput = {
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: user.id,
        userMessage: { id: messageId, text: "First message" },
        run: {
          id: asAgentRunId(`run_${id}`),
          clientInstanceId,
          conversationId: conversation.id,
          ownerUserId: user.id,
          inputMessageId: messageId,
          agentName: "expiry-test",
          correlationId: `corr_${id}`
        },
        runStartCommand: {
          idempotencyKey,
          commandKind: "start_conversation_run",
          claimedAt: claim.command.updatedAt
        }
      };
      return { idempotencyKey, input };
    };
    const lockCommand = (idempotencyKey: string) =>
      db.hold(
        (tx) => tx`
          select 1 from run_start_commands
          where client_instance_id = ${clientInstanceId} and idempotency_key = ${idempotencyKey}
          for update
        `
      );
    const countRows = async (conversation: Conversation) => {
      const [messages] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from messages where conversation_id = ${conversation.id}
      `;
      const [runs] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from agent_runs where conversation_id = ${conversation.id}
      `;
      return { messages: messages?.count, runs: runs?.count };
    };
    const statusOf = async (conversation: Conversation) =>
      (await db.store.conversations.getConversation(clientInstanceId, conversation.id))?.status;
    const expire = (store: PlatformStores, conversation: Conversation) =>
      store.conversations.expireConversation({
        clientInstanceId,
        conversationId: conversation.id,
        expiredAt: criteria.now,
        ...criteria
      });

    return {
      clientInstanceId,
      scope: { clientInstanceId },
      criteria,
      createConversation,
      age,
      createFile,
      attach,
      createAbandonedDraft,
      claimAcceptance,
      lockCommand,
      countRows,
      statusOf,
      expire
    };
  }

  it("keeps an abandoned draft whose first message is accepted while expiry waits", async () => {
    const fixture = await createFixture("acceptance_wins");
    const draft = await fixture.createAbandonedDraft("draft");
    await expect(
      db.store.conversations.listExpiredConversations({
        ...fixture.scope,
        ...fixture.criteria,
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ id: draft.conversation.id })]);
    const acceptanceInput = await fixture.claimAcceptance(draft.conversation);
    const held = await fixture.lockCommand(acceptanceInput.idempotencyKey);

    const acceptance = settled(
      db.store.agentRuns.prepareConversationRunStart(acceptanceInput.input)
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const expiry = settled(fixture.expire(db.secondStore, draft.conversation));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.rollback();

    expect(await acceptance).toMatchObject({ status: "fulfilled" });
    expect(await expiry).toEqual({ status: "fulfilled", value: { status: "not_expired" } });
    await expect(fixture.statusOf(draft.conversation)).resolves.toBe("active");
    await expect(
      db.store.conversations.listMessages({
        ...fixture.scope,
        conversationId: draft.conversation.id
      })
    ).resolves.toEqual([expect.objectContaining({ text: "First message" })]);
    await expect(fixture.countRows(draft.conversation)).resolves.toEqual({ messages: 1, runs: 1 });
    // The removed upload is still restorable: its file and its attachment row are untouched.
    await expect(
      db.store.files.getManagedFile({ ...fixture.scope, fileId: draft.file.id })
    ).resolves.toMatchObject({ status: "available" });
    await expect(
      db.store.files.reactivateDraftAttachment({
        ...fixture.scope,
        conversationId: draft.conversation.id,
        attachmentId: draft.attachment.id,
        status: "ready"
      })
    ).resolves.toMatchObject({ status: "ready" });
  });

  it("refuses a message once expiry holds the lock and stores nothing of it", async () => {
    const fixture = await createFixture("expiry_wins");
    const conversation = await fixture.createConversation("due", "2024-01-01T00:00:00.000Z");
    const existing = await db.store.conversations.appendMessage({
      ...fixture.scope,
      conversationId: conversation.id,
      role: "user",
      text: "Old message"
    });
    const acceptanceInput = await fixture.claimAcceptance(conversation);
    // Expiry deletes the messages after it has taken the lock and decided, so a row lock on
    // the message holds it there.
    const held = await db.hold(
      (tx) => tx`select 1 from messages where id = ${existing.id} for update`
    );

    const expiry = settled(fixture.expire(db.store, conversation));
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const acceptance = settled(
      db.secondStore.agentRuns.prepareConversationRunStart(acceptanceInput.input)
    );
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();

    expect(await expiry).toMatchObject({
      status: "fulfilled",
      value: { status: "expired", reason: "retention_due" }
    });
    expect(await acceptance).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_FOUND", message: "Conversation is not available" }
    });
    await expect(fixture.statusOf(conversation)).resolves.toBe("retention_expired");
    await expect(fixture.countRows(conversation)).resolves.toEqual({ messages: 0, runs: 0 });
    await expect(
      db.sql`
        select status, run_id from run_start_commands
        where client_instance_id = ${fixture.clientInstanceId}
          and idempotency_key = ${acceptanceInput.idempotencyKey}
      `
    ).resolves.toEqual([{ status: "pending", run_id: null }]);
  });

  it("expires the draft when the acceptance it waited for rolls back", async () => {
    const fixture = await createFixture("acceptance_rolls_back");
    const draft = await fixture.createAbandonedDraft("draft");
    const acceptanceInput = await fixture.claimAcceptance(draft.conversation);
    // The acceptance completes its command last. Removing the command under it makes that
    // step fail, so the whole acceptance rolls back with its message already written.
    const held = await db.hold(
      (tx) => tx`
        delete from run_start_commands
        where client_instance_id = ${fixture.clientInstanceId}
          and idempotency_key = ${acceptanceInput.idempotencyKey}
      `
    );

    const acceptance = settled(
      db.store.agentRuns.prepareConversationRunStart(acceptanceInput.input)
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const expiry = settled(fixture.expire(db.secondStore, draft.conversation));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.commit();

    expect(await acceptance).toMatchObject({
      status: "rejected",
      reason: { code: "NOT_FOUND", message: "Run start command is not available" }
    });
    expect(await expiry).toMatchObject({
      status: "fulfilled",
      value: {
        status: "expired",
        reason: "abandoned_draft",
        conversation: { id: draft.conversation.id, status: "retention_expired" }
      }
    });
    await expect(fixture.countRows(draft.conversation)).resolves.toEqual({ messages: 0, runs: 0 });
  });

  it("keeps a draft whose upload is stored while expiry waits", async () => {
    const fixture = await createFixture("upload_wins");
    const draft = await fixture.createAbandonedDraft("draft");
    const file = await fixture.createFile(draft.conversation, "upload");
    // The attachment row refers to the file, so a row lock on the file holds the upload after
    // it has taken the Conversation lock.
    const held = await db.hold(
      (tx) => tx`select 1 from managed_files where id = ${file.id} for update`
    );

    const upload = settled(fixture.attach(draft.conversation, file));
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const expiry = settled(fixture.expire(db.secondStore, draft.conversation));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.rollback();

    const uploaded = await upload;
    expect(uploaded).toMatchObject({ status: "fulfilled", value: { status: "ready" } });
    expect(await expiry).toEqual({ status: "fulfilled", value: { status: "not_expired" } });
    await expect(fixture.statusOf(draft.conversation)).resolves.toBe("active");
    await expect(
      db.store.files.listDraftAttachments({
        ...fixture.scope,
        conversationId: draft.conversation.id
      })
    ).resolves.toEqual([expect.objectContaining({ fileId: file.id, status: "ready" })]);
  });

  it("keeps a draft whose removed attachment is restored while expiry waits", async () => {
    const fixture = await createFixture("restore_wins");
    const draft = await fixture.createAbandonedDraft("draft");
    const held = await db.hold(
      (tx) => tx`
        select 1 from conversation_attachments where id = ${draft.attachment.id} for update
      `
    );

    const restore = settled(
      db.store.files.reactivateDraftAttachment({
        ...fixture.scope,
        conversationId: draft.conversation.id,
        attachmentId: draft.attachment.id,
        status: "ready"
      })
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const expiry = settled(fixture.expire(db.secondStore, draft.conversation));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.rollback();

    expect(await restore).toMatchObject({ status: "fulfilled", value: { status: "ready" } });
    expect(await expiry).toEqual({ status: "fulfilled", value: { status: "not_expired" } });
    await expect(fixture.statusOf(draft.conversation)).resolves.toBe("active");
    await expect(
      db.store.files.listDraftAttachments({
        ...fixture.scope,
        conversationId: draft.conversation.id
      })
    ).resolves.toEqual([expect.objectContaining({ id: draft.attachment.id, status: "ready" })]);
  });

  it("refuses an upload and a restore once the conversation is expired", async () => {
    const fixture = await createFixture("upload_after_expiry");
    const draft = await fixture.createAbandonedDraft("draft");
    const file = await fixture.createFile(draft.conversation, "late");
    await expect(fixture.expire(db.store, draft.conversation)).resolves.toMatchObject({
      status: "expired"
    });

    await expect(fixture.attach(draft.conversation, file)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await expect(
      db.store.files.reactivateDraftAttachment({
        ...fixture.scope,
        conversationId: draft.conversation.id,
        attachmentId: draft.attachment.id,
        status: "ready"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Conversation is not available" });
    await expect(
      db.sql`select status from conversation_attachments where conversation_id = ${draft.conversation.id}`
    ).resolves.toEqual([{ status: "deleted" }]);
  });

  it("skips a due conversation while its run is in progress and expires it by date afterwards", async () => {
    const fixture = await createFixture("due_with_run");
    const conversation = await fixture.createConversation("due", "2024-01-01T00:00:00.000Z");
    const acceptanceInput = await fixture.claimAcceptance(conversation);
    const held = await fixture.lockCommand(acceptanceInput.idempotencyKey);

    const acceptance = settled(
      db.store.agentRuns.prepareConversationRunStart(acceptanceInput.input)
    );
    await waitUntilBlocked(db.sql, { waiter: db.first, holder: db.barrier });
    const expiry = settled(fixture.expire(db.secondStore, conversation));
    await waitUntilBlocked(db.sql, { waiter: db.second, holder: db.first });
    await held.rollback();

    expect(await acceptance).toMatchObject({ status: "fulfilled" });
    // The message does not move the date, but its run is in progress: the next pass takes it.
    expect(await expiry).toEqual({ status: "fulfilled", value: { status: "not_expired" } });
    await expect(
      db.store.conversations.listExpiredConversations({
        ...fixture.scope,
        ...fixture.criteria,
        limit: 10
      })
    ).resolves.toEqual([]);
    await expect(fixture.countRows(conversation)).resolves.toEqual({ messages: 1, runs: 1 });

    await db.store.agentRuns.updateAgentRunStatus({
      ...fixture.scope,
      runId: acceptanceInput.input.run.id,
      status: "completed",
      updatedAt: new Date().toISOString()
    });
    await expect(
      db.store.conversations.listExpiredConversations({
        ...fixture.scope,
        ...fixture.criteria,
        limit: 10
      })
    ).resolves.toEqual([expect.objectContaining({ id: conversation.id })]);
    await expect(fixture.expire(db.secondStore, conversation)).resolves.toMatchObject({
      status: "expired",
      reason: "retention_due"
    });
    await expect(fixture.countRows(conversation)).resolves.toEqual({ messages: 0, runs: 0 });
  });

  it("claims exactly the conversations the list returns", async () => {
    const fixture = await createFixture("predicate");
    const due = await fixture.createConversation("due", "2024-01-01T00:00:00.000Z");
    await db.store.conversations.appendMessage({
      ...fixture.scope,
      conversationId: due.id,
      role: "user",
      text: "Old message"
    });
    const abandoned = (await fixture.createAbandonedDraft("abandoned")).conversation;
    const started = await fixture.createConversation("started");
    await db.store.conversations.appendMessage({
      ...fixture.scope,
      conversationId: started.id,
      role: "user",
      text: "First message"
    });
    await fixture.age(started);
    const drafting = await fixture.createConversation("drafting");
    await fixture.attach(drafting, await fixture.createFile(drafting, "draft"));
    await fixture.age(drafting);
    const fresh = await fixture.createConversation("fresh");
    const running = await fixture.createConversation("running", "2024-01-01T00:00:00.000Z");
    await db.store.agentRuns.prepareConversationRunStart(
      (await fixture.claimAcceptance(running)).input
    );
    const everything = [due, abandoned, started, drafting, fresh, running];

    const expectClaimsToFollowTheList = async (
      criteria: { now?: string; abandonedBefore?: string },
      reasons: Record<string, "retention_due" | "abandoned_draft">
    ) => {
      const listed = (
        await db.store.conversations.listExpiredConversations({
          ...fixture.scope,
          ...criteria,
          limit: 10
        })
      ).map(({ id }) => id);
      expect([...listed].sort()).toEqual(Object.keys(reasons).sort());
      for (const conversation of everything) {
        const result = await db.secondStore.conversations.expireConversation({
          ...fixture.scope,
          conversationId: conversation.id,
          expiredAt: fixture.criteria.now,
          ...criteria
        });
        const reason = reasons[conversation.id];
        expect(result).toMatchObject(
          reason ? { status: "expired", reason } : { status: "not_expired" }
        );
      }
    };

    // No criterion: nothing is due.
    await expectClaimsToFollowTheList({}, {});
    // Expiry by date is off: only the abandoned draft goes, whatever the stamped dates say.
    await expectClaimsToFollowTheList(
      { abandonedBefore: fixture.criteria.abandonedBefore },
      { [abandoned.id]: "abandoned_draft" }
    );
    await expectClaimsToFollowTheList(fixture.criteria, { [due.id]: "retention_due" });
    for (const conversation of [started, drafting, fresh, running]) {
      await expect(fixture.statusOf(conversation)).resolves.toBe("active");
    }
  });

  it("lists the conversations that still have data to clean up", async () => {
    const fixture = await createFixture("pending_cleanup");
    const pending = () =>
      db.store.files.listConversationsPendingObjectCleanup({ ...fixture.scope, limit: 10 });
    const withMessage = async (title: string) => {
      const conversation = await fixture.createConversation(title);
      await db.store.conversations.appendMessage({
        ...fixture.scope,
        conversationId: conversation.id,
        role: "user",
        text: "Message"
      });
      return conversation;
    };
    const deleteConversation = (conversation: Conversation) =>
      db.store.conversations.deleteConversation({
        ...fixture.scope,
        conversationId: conversation.id,
        deletedAt: fixture.criteria.now
      });
    const createArtifact = (conversation: Conversation, name: string) =>
      db.store.files.createManagedArtifact({
        ...fixture.scope,
        conversationId: conversation.id,
        kind: "test.preview",
        objectKey: `artifacts/${conversation.id}/${name}`,
        mimeType: "text/plain",
        byteSize: 5,
        checksum: name
      });

    const active = await withMessage("active with everything");
    await fixture.attach(active, await fixture.createFile(active, "active"));
    await createArtifact(active, "active");

    const withFile = await withMessage("deleted with a file");
    const withFileAttachment = await fixture.attach(
      withFile,
      await fixture.createFile(withFile, "own")
    );
    const withArtifact = await withMessage("deleted with an artifact");
    await createArtifact(withArtifact, "left");
    const withPreview = await withMessage("deleted with preview state");
    const previewSource = await createArtifact(withPreview, "source");
    await db.store.files.enqueueArtifactPreviewJob({
      ...fixture.scope,
      conversationId: withPreview.id,
      sourceArtifactId: previewSource.id,
      sourceChecksum: previewSource.checksum,
      sourceMimeType: previewSource.mimeType
    });
    // A file that is still attached in an active conversation is not this one's to remove.
    const sharing = await withMessage("deleted, file shared");
    const sharedFile = await fixture.createFile(sharing, "shared");
    await fixture.attach(sharing, sharedFile);
    await fixture.attach(active, sharedFile);
    const empty = await withMessage("deleted without data");

    await expect(pending()).resolves.toEqual([]);
    for (const conversation of [withFile, withArtifact, withPreview, sharing, empty]) {
      await deleteConversation(conversation);
    }
    const expected = [withFile.id, withArtifact.id, withPreview.id].sort();
    await expect(pending().then((ids) => [...ids].sort())).resolves.toEqual(expected);
    await expect(
      db.store.files.listConversationsPendingObjectCleanup({ ...fixture.scope, limit: 2 })
    ).resolves.toHaveLength(2);
    await expect(
      db.store.files.listConversationsPendingObjectCleanup({ ...fixture.scope, limit: 0 })
    ).resolves.toEqual([]);

    // The claim marked the attachment row deleted; the file behind it is what is left.
    await expect(
      db.store.files.getConversationAttachment({
        ...fixture.scope,
        attachmentId: withFileAttachment.id
      })
    ).resolves.toBeUndefined();
    for (const conversation of [withFile, withArtifact, withPreview]) {
      await db.store.files.markConversationManagedObjectsDeleted({
        ...fixture.scope,
        conversationId: conversation.id,
        deletedAt: fixture.criteria.now
      });
    }
    await expect(pending()).resolves.toEqual([]);
  });
});
