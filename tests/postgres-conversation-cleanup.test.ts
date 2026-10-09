import { describe, expect, it } from "vitest";
import { ConversationRetentionWorkflow } from "@vivd-catalyst/chat-server";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { testRequest } from "./support/operations";
import { usePostgresSuite } from "./support/postgres-suite";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("Postgres conversation cleanup after the claim", () => {
  const db = usePostgresSuite("cleanup");

  it("touches no object of a draft that stops being abandoned before the claim", async () => {
    const fixture = await createConversationCleanupFixture(db, "claim_refused");
    const author = await fixture.createUser("author");
    const draft = await fixture.createConversation(author, "draft", { withMessage: false });
    const data = await fixture.createData(draft);
    await db.store.deleteDraftAttachment({
      ...fixture.scope,
      conversationId: draft.id,
      attachmentId: data.attachment.id,
      deletedAt: new Date().toISOString()
    });
    await db.sql`
      update conversations set updated_at = ${new Date(Date.now() - 3 * DAY_MS)}
      where id = ${draft.id}
    `;

    // The first message arrives after the job has listed the draft and before it claims it.
    const listExpiredConversations = db.store.listExpiredConversations.bind(db.store);
    const listed: string[] = [];
    db.store.listExpiredConversations = async (input) => {
      const conversations = await listExpiredConversations(input);
      listed.push(...conversations.map((conversation) => conversation.id));
      await db.store.appendMessage({
        ...fixture.scope,
        conversationId: draft.id,
        role: "user",
        text: "First message"
      });
      return conversations;
    };
    try {
      await expect(
        new ConversationRetentionWorkflow(fixture.options).expireDueConversations()
      ).resolves.toEqual({ expiredCount: 0, failedCount: 0, cleanupPendingCount: 0 });
    } finally {
      db.store.listExpiredConversations = listExpiredConversations;
    }

    expect(listed).toEqual([draft.id]);
    expect(fixture.byteStore.deleteAttempts).toEqual([]);
    await expect(fixture.statusOf(draft)).resolves.toBe("active");
    await fixture.expectDataLeft(draft, data);
    await expect(
      db.store.listMessages({ ...fixture.scope, conversationId: draft.id })
    ).resolves.toEqual([expect.objectContaining({ text: "First message" })]);
    await expect(
      db.store.reactivateDraftAttachment({
        ...fixture.scope,
        conversationId: draft.id,
        attachmentId: data.attachment.id,
        status: "ready"
      })
    ).resolves.toMatchObject({ status: "ready" });
    await expect(db.store.listAuditEvents({ ...fixture.scope, limit: 100 })).resolves.toEqual([]);
  });

  it("leaves the conversation expired when cleanup fails and finishes it in a later run", async () => {
    const fixture = await createConversationCleanupFixture(db, "cleanup_retry");
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "due", {
      retainedUntil: "2024-01-01T00:00:00.000Z"
    });
    const data = await fixture.createData(conversation);
    const workflow = new ConversationRetentionWorkflow(fixture.options);

    fixture.byteStore.failDeletes = true;
    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0,
      cleanupPendingCount: 1
    });

    await expect(fixture.statusOf(conversation)).resolves.toBe("retention_expired");
    await expect(
      db.store.listMessages({ ...fixture.scope, conversationId: conversation.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await fixture.expectDataLeft(conversation, data);
    await expect(fixture.pending()).resolves.toEqual([conversation.id]);
    await expect(
      fixture.auditEvents("conversation.retention_expired", conversation)
    ).resolves.toEqual([
      expect.objectContaining({
        status: "success",
        metadata: {
          retainedUntil: conversation.retainedUntil,
          expiredAt: expect.any(String),
          reason: "retention_due",
          cleanup: "pending"
        }
      })
    ]);
    const failures = await fixture.auditEvents("conversation.cleanup_failed", conversation);
    expect(failures).toEqual([
      expect.objectContaining({
        status: "failed",
        metadata: { errorCode: "INTERNAL", errorCategory: "conversation_cleanup" }
      })
    ]);
    expect(JSON.stringify(failures)).not.toContain(data.file.objectKey);
    await expect(
      fixture.auditEvents("conversation.retention_expiration_failed", conversation)
    ).resolves.toEqual([]);

    // A run while the object db.store is still failing reports the cleanup as pending.
    await expect(fixture.runRetentionJob()).resolves.toEqual([
      "Conversation data cleanup is pending"
    ]);
    await fixture.expectDataLeft(conversation, data);
    await expect(fixture.pending()).resolves.toEqual([conversation.id]);
    await expect(
      fixture.auditEvents("conversation.cleanup_failed", conversation)
    ).resolves.toHaveLength(2);

    fixture.byteStore.failDeletes = false;
    await expect(fixture.runRetentionJob()).resolves.toEqual([]);
    await fixture.expectDataRemoved(conversation, data);
    await expect(fixture.pending()).resolves.toEqual([]);
    await expect(
      fixture.auditEvents("conversation.cleanup_completed", conversation)
    ).resolves.toEqual([
      expect.objectContaining({
        status: "success",
        metadata: expect.objectContaining({ fileCount: 1, artifactCount: 1 })
      })
    ]);
    await expect(fixture.statusOf(conversation)).resolves.toBe("retention_expired");
    await expect(
      fixture.auditEvents("conversation.retention_expired", conversation)
    ).resolves.toHaveLength(1);

    await expect(workflow.cleanUpPendingConversations()).resolves.toEqual({
      completedCount: 0,
      cleanupPendingCount: 0
    });
  });

  it("keeps a conversation its user deleted that way when cleanup fails and finishes it later", async () => {
    const fixture = await createConversationCleanupFixture(db, "conversation_deletion");
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "deleted by its user");
    const data = await fixture.createData(conversation);
    const api = await fixture.api();

    fixture.byteStore.failDeletes = true;
    const deletion = await api.call(
      "deleteConversation",
      { params: { conversationId: conversation.id } },
      author.id
    );
    expect(deletion.statusCode).toBe(200);

    await expect(fixture.statusOf(conversation)).resolves.toBe("deleted");
    await fixture.expectDataLeft(conversation, data);
    await expect(fixture.pending()).resolves.toEqual([conversation.id]);
    await expect(fixture.auditEvents("conversation.deleted", conversation)).resolves.toEqual([
      expect.objectContaining({ status: "success", metadata: { cleanup: "pending" } })
    ]);
    await expect(
      fixture.auditEvents("conversation.cleanup_failed", conversation)
    ).resolves.toHaveLength(1);

    fixture.byteStore.failDeletes = false;
    await expect(fixture.runRetentionJob()).resolves.toEqual([]);
    await fixture.expectDataRemoved(conversation, data);
    await expect(fixture.pending()).resolves.toEqual([]);
    await expect(
      fixture.auditEvents("conversation.cleanup_completed", conversation)
    ).resolves.toHaveLength(1);
    await expect(fixture.statusOf(conversation)).resolves.toBe("deleted");
  });

  it("serves no file, artifact or preview of an expired conversation that is not cleaned yet", async () => {
    const fixture = await createConversationCleanupFixture(db, "reads_refused");
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "due", {
      retainedUntil: "2024-01-01T00:00:00.000Z"
    });
    const data = await fixture.createData(conversation);
    const api = await fixture.api();
    const conversationId = conversation.id;
    const fileContent = { params: { conversationId, fileId: data.file.id } };
    const artifact = { params: { conversationId, artifactId: data.artifact.id } };
    const attachment = { params: { conversationId, attachmentId: data.attachment.id } };

    const before = await api.call("getConversationArtifactPreview", artifact, author.id);
    expect(before.statusCode).toBe(200);

    fixture.byteStore.failDeletes = true;
    await expect(
      new ConversationRetentionWorkflow(fixture.options).expireDueConversations()
    ).resolves.toMatchObject({ expiredCount: 1, cleanupPendingCount: 1 });
    await fixture.expectDataLeft(conversation, data);

    const reads = [
      testRequest("getConversationFileContent", fileContent),
      testRequest("getConversationFileContent", { ...fileContent, query: { download: "true" } }),
      testRequest("getConversationArtifactContent", artifact),
      testRequest("getConversationArtifactContent", { ...artifact, query: { inline: "true" } }),
      testRequest("getConversationArtifactPreview", artifact),
      testRequest("getConversationAttachmentPreview", attachment)
    ];
    for (const read of reads) {
      const response = await api.call(read.operation, read.input, author.id);
      expect({ read, status: response.statusCode, body: response.json() }).toEqual({
        read,
        status: 404,
        body: { error: expect.objectContaining({ code: "NOT_FOUND" }) }
      });
    }
  });
});
