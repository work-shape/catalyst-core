import { describe, expect, it } from "vitest";
import {
  ConversationRetentionJob,
  ConversationRetentionWorkflow,
  ExecutionWorkspaceCleanupWorkflow,
  createConversationRetentionJob,
  type ChatAttachmentService,
  type ChatServerOptions
} from "@vivd-catalyst/chat-server";
import {
  createManagedObjectAccess,
  type ManagedObjectByteStore
} from "@vivd-catalyst/capability-sdk";
import {
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asExecutionWorkspaceId,
  asWorkspaceCommandId,
  type ClientInstanceId,
  type Conversation,
  type ConversationAttachment,
  type ConversationId,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  type PlatformFileStore
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("conversation retention expiration", () => {
  it("expires due conversations on startup and periodically with object cleanup and audit", async () => {
    const clientInstanceId = asClientInstanceId("retention-test");
    const store = new InMemoryPlatformStore();
    const byteStore = new RecordingByteStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store,
      byteStore,
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const attachments = createManagedObjectAttachmentService({ managedObjects });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments,
      workspaceObjects: byteStore
    });
    const job = new ConversationRetentionJob({
      workflow: new ConversationRetentionWorkflow(options),
      options: {
        checkIntervalMs: 10,
        runOnStartup: true
      },
      logger: {
        error(error) {
          throw error instanceof Error ? error : new Error("Retention job failed");
        }
      }
    });

    const startupConversation = await createExpiredConversation(store, clientInstanceId, "startup");
    const startupObjects = await createAttachedObjects({
      store,
      managedObjects,
      clientInstanceId,
      conversation: startupConversation
    });
    const startupWorkspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation: startupConversation
    });

    try {
      job.start();
      await waitFor(async () => {
        await expectConversationStatus(
          store,
          clientInstanceId,
          startupConversation.id,
          "retention_expired"
        );
      });

      await expect(
        store.listMessages({
          clientInstanceId,
          conversationId: startupConversation.id
        })
      ).rejects.toMatchObject({
        code: "NOT_FOUND"
      });
      await expectDeletedManagedObjects(store, byteStore, clientInstanceId, startupObjects);
      await expectDeletedWorkspaceObjects(
        store,
        byteStore,
        clientInstanceId,
        startupWorkspaceObjects
      );

      const periodicConversation = await createExpiredConversation(
        store,
        clientInstanceId,
        "periodic"
      );
      await waitFor(async () => {
        await expectConversationStatus(
          store,
          clientInstanceId,
          periodicConversation.id,
          "retention_expired"
        );
      });

      const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
      const startupAudit = events.find(
        (event) =>
          event.subject === startupConversation.id &&
          event.type === "conversation.retention_expired"
      );
      expect(startupAudit).toMatchObject({
        type: "conversation.retention_expired",
        status: "success",
        metadata: expect.objectContaining({
          retainedUntil: startupConversation.retainedUntil,
          attachmentCount: 1,
          fileCount: 1,
          artifactCount: 1,
          workspaceCount: 1,
          workspaceFileCount: 6,
          workspaceCommandCount: 1,
          workspaceObjectCount: 6
        })
      });
      expect(startupAudit).not.toHaveProperty("actor");
      expect(
        events.find(
          (event) =>
            event.subject === periodicConversation.id &&
            event.type === "conversation.retention_expired"
        )
      ).toMatchObject({
        type: "conversation.retention_expired",
        status: "success",
        metadata: expect.objectContaining({
          retainedUntil: periodicConversation.retainedUntil,
          attachmentCount: 0,
          fileCount: 0,
          artifactCount: 0
        })
      });
    } finally {
      await job.stop();
    }
  });

  it("expires abandoned draft conversations after the grace period", async () => {
    const clientInstanceId = asClientInstanceId("retention-abandoned-test");
    const store = new InMemoryPlatformStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store,
      byteStore: new RecordingByteStore(),
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects })
    });
    const create = (title: string) =>
      store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "external-user-1",
        title,
        retainedUntil: "2999-01-01T00:00:00.000Z"
      });
    const abandoned = await create("5 attached files");
    const started = await create("started");
    await store.appendMessage({
      clientInstanceId,
      conversationId: started.id,
      role: "user",
      text: "first message"
    });
    const drafting = await create("drafting");
    await createAttachedObjects({
      store,
      managedObjects,
      clientInstanceId,
      conversation: drafting
    });
    const emptied = await create("emptied");
    const removed = await createAttachedObjects({
      store,
      managedObjects,
      clientInstanceId,
      conversation: emptied
    });
    await store.deleteDraftAttachment({
      clientInstanceId,
      conversationId: emptied.id,
      attachmentId: removed.attachment.id,
      deletedAt: new Date().toISOString()
    });
    const hoursFromNow = (hours: number) => () => new Date(Date.now() + hours * 60 * 60 * 1000);

    await expect(
      new ConversationRetentionWorkflow(options, {
        now: hoursFromNow(23)
      }).expireDueConversations()
    ).resolves.toEqual({ expiredCount: 0, failedCount: 0 });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "active");

    await expect(
      new ConversationRetentionWorkflow(options, {
        now: hoursFromNow(25)
      }).expireDueConversations()
    ).resolves.toEqual({ expiredCount: 2, failedCount: 0 });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, emptied.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, started.id, "active");
    await expectConversationStatus(store, clientInstanceId, drafting.id, "active");

    const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      events.find(
        (event) => event.subject === abandoned.id && event.type === "conversation.retention_expired"
      )
    ).toMatchObject({
      status: "success",
      metadata: expect.objectContaining({ reason: "abandoned_draft", attachmentCount: 0 })
    });
  });

  it("keeps overdue conversations while expiry is turned off", async () => {
    const clientInstanceId = asClientInstanceId("retention-off-test");
    const store = new InMemoryPlatformStore();
    const jobInput = {
      logger: {
        error(error: unknown) {
          throw error instanceof Error ? error : new Error("Retention job failed");
        }
      },
      jobOptions: { checkIntervalMs: 10, runOnStartup: true }
    };
    const conversation = await createExpiredConversation(store, clientInstanceId, "kept");

    const disabledJob = createConversationRetentionJob(
      createRetentionOptions({ clientInstanceId, store, expireConversations: false }),
      jobInput
    );
    try {
      disabledJob.start();
      // Long enough for a startup run and several interval ticks.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expectConversationStatus(store, clientInstanceId, conversation.id, "active");
      await expect(
        store.listMessages({ clientInstanceId, conversationId: conversation.id })
      ).resolves.toHaveLength(1);
    } finally {
      await disabledJob.stop();
    }

    // The stamped date still stands: turning expiry back on expires it.
    const enabledJob = createConversationRetentionJob(
      createRetentionOptions({ clientInstanceId, store }),
      jobInput
    );
    try {
      enabledJob.start();
      await waitFor(async () => {
        await expectConversationStatus(
          store,
          clientInstanceId,
          conversation.id,
          "retention_expired"
        );
      });
    } finally {
      await enabledJob.stop();
    }
  });

  it("expires only abandoned drafts while expiry is turned off", async () => {
    const clientInstanceId = asClientInstanceId("retention-off-abandoned-test");
    const store = new InMemoryPlatformStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store,
      byteStore: new RecordingByteStore(),
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments: createManagedObjectAttachmentService({ managedObjects }),
      expireConversations: false
    });
    // Every conversation is past its stamped date, as after a long time without expiry.
    const create = (title: string) =>
      store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: "user-1",
        createdByExternalUserId: "external-user-1",
        title,
        retainedUntil: "2024-01-01T00:00:00.000Z"
      });
    const abandoned = await create("5 attached files");
    const started = await createExpiredConversation(store, clientInstanceId, "started");
    const drafting = await create("drafting");
    await createAttachedObjects({
      store,
      managedObjects,
      clientInstanceId,
      conversation: drafting
    });
    const workflowAt = (hours: number) =>
      new ConversationRetentionWorkflow(options, {
        now: () => new Date(Date.now() + hours * 60 * 60 * 1000)
      });

    await expect(workflowAt(23).expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 0
    });
    await expect(workflowAt(25).expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0
    });
    await expectConversationStatus(store, clientInstanceId, abandoned.id, "retention_expired");
    await expectConversationStatus(store, clientInstanceId, started.id, "active");
    await expectConversationStatus(store, clientInstanceId, drafting.id, "active");
    await expect(
      store.listMessages({ clientInstanceId, conversationId: started.id })
    ).resolves.toHaveLength(1);

    const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
    expect(
      events.find(
        (event) => event.subject === abandoned.id && event.type === "conversation.retention_expired"
      )
    ).toMatchObject({ metadata: expect.objectContaining({ reason: "abandoned_draft" }) });
  });

  it("keeps deletion metadata retryable when object byte deletion fails", async () => {
    const clientInstanceId = asClientInstanceId("retention-retry-test");
    const store = new InMemoryPlatformStore();
    const byteStore = new RecordingByteStore();
    const managedObjects = createManagedObjectAccess({
      clientInstanceId,
      files: store,
      byteStore,
      keyFactory: {
        createFileObjectKey(input) {
          return `files/${input.conversationId ?? "unscoped"}/${input.checksum}`;
        },
        createArtifactObjectKey(input) {
          return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
        }
      }
    });
    const attachments = createManagedObjectAttachmentService({ managedObjects });
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      attachments,
      workspaceObjects: byteStore
    });
    const workflow = new ConversationRetentionWorkflow(options);
    const conversation = await createExpiredConversation(store, clientInstanceId, "retry");
    const objects = await createAttachedObjects({
      store,
      managedObjects,
      clientInstanceId,
      conversation
    });

    byteStore.failNextDeleteFor(objects.artifact.objectKey);
    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 1
    });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "active");
    await expect(
      store.getConversationAttachment({
        clientInstanceId,
        attachmentId: objects.attachment.id
      })
    ).resolves.toMatchObject({
      id: objects.attachment.id,
      status: "ready"
    });
    await expect(
      store.getManagedArtifact({
        clientInstanceId,
        artifactId: objects.artifact.id
      })
    ).resolves.toMatchObject({
      id: objects.artifact.id,
      status: "available"
    });
    expect(byteStore.has(objects.artifact.objectKey)).toBe(true);

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 1,
      failedCount: 0
    });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "retention_expired");
    await expectDeletedManagedObjects(store, byteStore, clientInstanceId, objects);

    const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
    const failureAudit = events.find(
      (event) => event.type === "conversation.retention_expiration_failed"
    );
    expect(failureAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: expect.objectContaining({
        retainedUntil: conversation.retainedUntil,
        errorCode: "INTERNAL",
        errorCategory: "retention_expiration",
        errorMessage: "Conversation retention expiration failed"
      })
    });
    expect(JSON.stringify(failureAudit)).not.toContain(objects.artifact.objectKey);
    expect(events.find((event) => event.type === "conversation.retention_expired")).toMatchObject({
      status: "success",
      subject: conversation.id
    });
  });

  it("sanitizes workspace object keys in direct retention cleanup failure audit", async () => {
    const clientInstanceId = asClientInstanceId("retention-workspace-failure-test");
    const store = new InMemoryPlatformStore();
    const byteStore = new RecordingByteStore();
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      workspaceObjects: byteStore
    });
    const workflow = new ConversationRetentionWorkflow(options);
    const conversation = await createExpiredConversation(
      store,
      clientInstanceId,
      "workspace-failure"
    );
    const workspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation
    });
    byteStore.failNextDeleteFor(workspaceObjects.objectKey);

    await expect(workflow.expireDueConversations()).resolves.toEqual({
      expiredCount: 0,
      failedCount: 1
    });
    await expectConversationStatus(store, clientInstanceId, conversation.id, "active");

    const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
    const failureAudit = events.find(
      (event) => event.type === "conversation.retention_expiration_failed"
    );
    expect(failureAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: expect.objectContaining({
        errorCode: "INTERNAL",
        errorCategory: "retention_expiration",
        errorMessage: "Conversation retention expiration failed"
      })
    });
    expect(JSON.stringify(failureAudit)).not.toContain(workspaceObjects.objectKey);
  });

  it("sanitizes workspace object keys in periodic workspace cleanup failure audit", async () => {
    const clientInstanceId = asClientInstanceId("workspace-cleanup-failure-test");
    const store = new InMemoryPlatformStore();
    const byteStore = new RecordingByteStore();
    const options = createRetentionOptions({
      clientInstanceId,
      store,
      workspaceObjects: byteStore
    });
    const conversation = await createExpiredConversation(
      store,
      clientInstanceId,
      "cleanup-failure"
    );
    const workspaceObjects = await createWorkspaceObjects({
      store,
      byteStore,
      clientInstanceId,
      conversation
    });
    await store.deleteConversation({
      clientInstanceId,
      conversationId: conversation.id,
      deletedAt: "2024-01-02T00:00:00.000Z"
    });
    byteStore.failNextDeleteFor(workspaceObjects.objectKey);

    const workflow = new ExecutionWorkspaceCleanupWorkflow(options);
    await expect(workflow.cleanupDeletedConversationWorkspaces()).resolves.toEqual({
      cleanedCount: 0,
      failedCount: 1
    });

    const events = await store.listAuditEvents({ clientInstanceId, limit: 10 });
    const cleanupAudit = events.find(
      (event) => event.type === "execution_workspace.cleanup_failed"
    );
    expect(cleanupAudit).toMatchObject({
      status: "failed",
      subject: conversation.id,
      metadata: expect.objectContaining({
        errorCode: "INTERNAL",
        errorCategory: "workspace_cleanup",
        errorMessage: "Execution workspace cleanup failed"
      })
    });
    expect(JSON.stringify(cleanupAudit)).not.toContain(workspaceObjects.objectKey);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function createOrphanFixture(name: string, keyPrefix = "files") {
  const clientInstanceId = asClientInstanceId(name);
  const store = new InMemoryPlatformStore();
  const byteStore = new RecordingByteStore();
  const managedObjects = createManagedObjectAccess({
    clientInstanceId,
    files: store,
    byteStore,
    keyFactory: {
      createFileObjectKey(input) {
        const prefix = input.filename.startsWith("foreign") ? "foreign" : keyPrefix;
        return `${prefix}/${input.conversationId ?? "unscoped"}/${input.checksum}`;
      },
      createArtifactObjectKey(input) {
        return `artifacts/${input.conversationId}/${input.kind}/${input.checksum}`;
      }
    }
  });
  const options = createRetentionOptions({
    clientInstanceId,
    store,
    attachments: createManagedObjectAttachmentService({ managedObjects, byteStore })
  });
  const createFile = (conversation: Conversation, filename: string, content = filename) =>
    managedObjects.createFile({
      ownerUserId: conversation.createdByUserId,
      conversationId: conversation.id,
      filename,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(content)
    });
  const attach = (conversation: Conversation, file: ManagedFileRecord) =>
    store.createConversationAttachment({
      clientInstanceId,
      conversationId: conversation.id,
      fileId: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
      checksum: file.checksum,
      status: "ready",
      format: "txt"
    });
  const createConversation = (title: string) =>
    store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "external-user-1",
      title,
      retainedUntil: "2999-01-01T00:00:00.000Z"
    });
  const isAvailable = async (file: ManagedFileRecord) =>
    (await store.getManagedFile({ clientInstanceId, fileId: file.id })) !== undefined;
  return {
    clientInstanceId,
    store,
    byteStore,
    options,
    createFile,
    attach,
    createConversation,
    isAvailable,
    /** A workflow that runs after the grace period of everything created so far. */
    laterWorkflow: (batchSize?: number) =>
      new ConversationRetentionWorkflow(options, {
        batchSize,
        now: () => new Date(Date.now() + 2 * DAY_MS)
      })
  };
}

describe("orphaned managed file cleanup", () => {
  it("removes files without an active conversation and keeps every file that has one", async () => {
    const fixture = createOrphanFixture("orphan-test");
    const { store, byteStore, clientInstanceId } = fixture;
    const active = await fixture.createConversation("active");
    const deleted = await fixture.createConversation("deleted without cleanup");

    const neverAttached = await fixture.createFile(active, "never-attached.txt");
    const leftBehind = await fixture.createFile(deleted, "left-behind.txt");
    await fixture.attach(deleted, leftBehind);
    await store.deleteConversation({
      clientInstanceId,
      conversationId: deleted.id,
      deletedAt: new Date().toISOString()
    });
    const attached = await fixture.createFile(active, "attached.txt");
    await fixture.attach(active, attached);
    const removedDraft = await fixture.createFile(active, "removed-draft.txt");
    const removedDraftAttachment = await fixture.attach(active, removedDraft);
    await store.deleteDraftAttachment({
      clientInstanceId,
      conversationId: active.id,
      attachmentId: removedDraftAttachment.id,
      deletedAt: new Date().toISOString()
    });

    // A file younger than the grace period may still be on its way into a conversation.
    await expect(
      new ConversationRetentionWorkflow(fixture.options).deleteOrphanedManagedFiles()
    ).resolves.toEqual({ fileCount: 0, objectCount: 0, unclaimedCount: 0 });
    expect(byteStore.deletedKeys).toEqual([]);

    const workflow = fixture.laterWorkflow();
    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 2,
      objectCount: 2,
      unclaimedCount: 0
    });
    for (const file of [neverAttached, leftBehind]) {
      expect(byteStore.has(file.objectKey)).toBe(false);
      await expect(fixture.isAvailable(file)).resolves.toBe(false);
    }
    for (const file of [attached, removedDraft]) {
      expect(byteStore.has(file.objectKey)).toBe(true);
      await expect(fixture.isAvailable(file)).resolves.toBe(true);
    }

    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 0,
      objectCount: 0,
      unclaimedCount: 0
    });
    const audits = (await store.listAuditEvents({ clientInstanceId, limit: 20 })).filter((event) =>
      event.type.startsWith("storage.")
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      type: "storage.orphaned_files_deleted",
      status: "success",
      metadata: { fileCount: 2, objectCount: 2, unclaimedCount: 0 }
    });
    expect(audits[0]!.subject).toBeUndefined();
    expect(JSON.stringify(audits[0])).not.toContain(neverAttached.objectKey);
  });

  it("keeps bytes that a file with an owner stores under the same object key", async () => {
    const fixture = createOrphanFixture("orphan-shared-key-test");
    const active = await fixture.createConversation("active");
    const attached = await fixture.createFile(active, "same.txt", "same bytes");
    await fixture.attach(active, attached);
    const duplicate = await fixture.createFile(active, "same.txt", "same bytes");
    expect(duplicate.objectKey).toBe(attached.objectKey);

    await expect(fixture.laterWorkflow().deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 1,
      objectCount: 0,
      unclaimedCount: 0
    });
    expect(fixture.byteStore.has(attached.objectKey)).toBe(true);
    await expect(fixture.isAvailable(attached)).resolves.toBe(true);
    await expect(fixture.isAvailable(duplicate)).resolves.toBe(false);
  });

  it("leaves a file whose object no handler stores and continues past it", async () => {
    const fixture = createOrphanFixture("orphan-unclaimed-test");
    const conversation = await fixture.createConversation("active");
    const foreign = await fixture.createFile(conversation, "foreign.txt");
    const own = [
      await fixture.createFile(conversation, "own-1.txt"),
      await fixture.createFile(conversation, "own-2.txt")
    ];

    await expect(fixture.laterWorkflow(1).deleteOrphanedManagedFiles()).resolves.toEqual({
      fileCount: 2,
      objectCount: 2,
      unclaimedCount: 1
    });
    expect(fixture.byteStore.has(foreign.objectKey)).toBe(true);
    await expect(fixture.isAvailable(foreign)).resolves.toBe(true);
    for (const file of own) {
      expect(fixture.byteStore.has(file.objectKey)).toBe(false);
      await expect(fixture.isAvailable(file)).resolves.toBe(false);
    }
  });

  it("keeps the file retryable and audits counts only when byte deletion fails", async () => {
    const fixture = createOrphanFixture("orphan-failure-test");
    const { store, byteStore, clientInstanceId } = fixture;
    const conversation = await fixture.createConversation("active");
    const orphan = await fixture.createFile(conversation, "orphan.txt");
    const workflow = fixture.laterWorkflow();

    byteStore.failNextDeleteFor(orphan.objectKey);
    await expect(workflow.deleteOrphanedManagedFiles()).rejects.toThrow();
    await expect(fixture.isAvailable(orphan)).resolves.toBe(true);
    const failure = (await store.listAuditEvents({ clientInstanceId, limit: 10 })).find(
      (event) => event.type === "storage.orphaned_file_cleanup_failed"
    );
    expect(failure).toMatchObject({
      status: "failed",
      metadata: { fileCount: 0, objectCount: 0, errorCategory: "orphaned_file_cleanup" }
    });
    expect(JSON.stringify(failure)).not.toContain(orphan.objectKey);

    await expect(workflow.deleteOrphanedManagedFiles()).resolves.toMatchObject({ fileCount: 1 });
    expect(byteStore.has(orphan.objectKey)).toBe(false);
  });

  it("runs after conversation expiry in the retention job", async () => {
    const fixture = createOrphanFixture("orphan-job-test");
    const conversation = await fixture.createConversation("active");
    const orphan = await fixture.createFile(conversation, "orphan.txt");
    const job = new ConversationRetentionJob({
      workflow: fixture.laterWorkflow(),
      options: { checkIntervalMs: 0, runOnStartup: true },
      logger: {
        error(error) {
          throw error instanceof Error ? error : new Error("Retention job failed");
        }
      }
    });

    job.start();
    await job.stop();

    expect(fixture.byteStore.has(orphan.objectKey)).toBe(false);
    await expect(fixture.isAvailable(orphan)).resolves.toBe(false);
  });
});

function createRetentionOptions(input: {
  clientInstanceId: ClientInstanceId;
  store: InMemoryPlatformStore;
  attachments?: ChatAttachmentService;
  workspaceObjects?: { deleteObject(key: string): Promise<void> };
  expireConversations?: boolean;
}): ChatServerOptions {
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId: input.clientInstanceId,
    store: input.store
  });
  return {
    config: parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: input.clientInstanceId,
        displayName: "Retention Test",
        environment: "development"
      },
      auth: {
        development: {
          enabled: true
        }
      },
      retention: {
        conversationDays: 30,
        expireConversations: input.expireConversations,
        auditDays: 365,
        allowUserDelete: true
      },
      modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
      tools: []
    }),
    clientInstanceId: input.clientInstanceId,
    authAdapter: {} as ChatServerOptions["authAdapter"],
    conversationStore: input.store,
    auditEventStore: input.store,
    userStore: input.store,
    usageGovernance: {} as ChatServerOptions["usageGovernance"],
    auditRecorder,
    agentRuntime: {} as ChatServerOptions["agentRuntime"],
    attachments: input.attachments,
    executionWorkspaceCleanup: input.workspaceObjects
      ? {
          store: input.store,
          objects: input.workspaceObjects,
          jobOptions: {
            runOnStartup: false
          }
        }
      : undefined,
    modelProvider: {} as ChatServerOptions["modelProvider"]
  };
}

async function createExpiredConversation(
  store: InMemoryPlatformStore,
  clientInstanceId: ClientInstanceId,
  title: string
): Promise<Conversation> {
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "external-user-1",
    title,
    retainedUntil: "2024-01-01T00:00:00.000Z"
  });
  await store.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: `message for ${title}`
  });
  return conversation;
}

async function createAttachedObjects(input: {
  store: InMemoryPlatformStore;
  managedObjects: ReturnType<typeof createManagedObjectAccess>;
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
}): Promise<{
  attachment: ConversationAttachment;
  file: ManagedFileRecord;
  artifact: ManagedArtifactRecord;
}> {
  const file = await input.managedObjects.createFile({
    ownerUserId: input.conversation.createdByUserId,
    conversationId: input.conversation.id,
    filename: "retention.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("retained file")
  });
  const artifact = await input.managedObjects.createArtifact({
    conversationId: input.conversation.id,
    sourceFileId: file.id,
    kind: "test.preview",
    filename: "retention-preview.txt",
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("retained artifact")
  });
  const attachment = await input.store.createConversationAttachment({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversation.id,
    fileId: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    checksum: file.checksum,
    status: "ready",
    format: "txt",
    artifactRefs: {
      preview: artifact.id
    }
  });
  return {
    attachment,
    file,
    artifact
  };
}

async function createWorkspaceObjects(input: {
  store: InMemoryPlatformStore;
  byteStore: RecordingByteStore;
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
}): Promise<{
  workspaceId: string;
  objectKey: string;
  objectKeys: string[];
}> {
  const workspace = await input.store.ensureExecutionWorkspace({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversation.id,
    ownerUserId: input.conversation.createdByUserId,
    now: "2023-12-31T23:00:00.000Z"
  });
  const files = [
    {
      path: "scripts/build-report.py",
      body: "print('retained script')\n",
      mimeType: "text/x-python",
      metadata: { source: "workspace.exec", role: "script" }
    },
    {
      path: "previews/page-1.png",
      body: "png bytes",
      mimeType: "image/png",
      metadata: { source: "workspace.exec", role: "preview" }
    },
    {
      path: "tmp/session-cache.json",
      body: '{"cached":true}\n',
      mimeType: "application/json",
      metadata: { source: "workspace.exec", role: "temporary" }
    },
    {
      path: "artifacts/unpromoted.csv",
      body: "value\n42\n",
      mimeType: "text/csv",
      metadata: { source: "workspace.exec", role: "unpromoted_artifact" }
    },
    {
      path: "artifacts/final-report.pdf",
      body: "%PDF promoted placeholder\n",
      mimeType: "application/pdf",
      metadata: {
        source: "workspace.exec",
        promotedArtifacts: [{ artifactId: "artifact_retention_seed", kind: "document.pdf" }]
      }
    }
  ];
  const objectKeys: string[] = [];
  for (const file of files) {
    const objectKey = `execution-workspaces/${input.conversation.id}/${file.path}`;
    const bytes = new TextEncoder().encode(file.body);
    objectKeys.push(objectKey);
    await input.byteStore.putObject({ key: objectKey, body: bytes });
    await input.store.upsertWorkspaceFile({
      clientInstanceId: input.clientInstanceId,
      workspaceId: workspace.id,
      path: file.path,
      objectKey,
      byteSize: bytes.byteLength,
      checksum: `sha256:${file.path}`,
      mimeType: file.mimeType,
      metadata: file.metadata,
      lastCommandId: asWorkspaceCommandId("wcmd_retention_seed"),
      updatedAt: "2023-12-31T23:01:00.000Z"
    });
  }
  const deletedObjectKey = `execution-workspaces/${input.conversation.id}/tmp/deleted-before-retention.txt`;
  const deletedBytes = new TextEncoder().encode("deleted before retention");
  objectKeys.push(deletedObjectKey);
  await input.byteStore.putObject({ key: deletedObjectKey, body: deletedBytes });
  await input.store.upsertWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "tmp/deleted-before-retention.txt",
    objectKey: deletedObjectKey,
    byteSize: deletedBytes.byteLength,
    checksum: "sha256:deleted-before-retention",
    mimeType: "text/plain",
    metadata: { source: "workspace.exec", role: "temporary" },
    lastCommandId: asWorkspaceCommandId("wcmd_retention_seed"),
    updatedAt: "2023-12-31T23:01:30.000Z"
  });
  await input.store.deleteWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "tmp/deleted-before-retention.txt",
    lastCommandId: asWorkspaceCommandId("wcmd_retention_delete"),
    deletedAt: "2023-12-31T23:01:45.000Z"
  });
  await input.store.enqueueWorkspaceCommand({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    ownerUserId: input.conversation.createdByUserId,
    command: "python3 calculate.py",
    limits: {
      timeoutSeconds: 60,
      idleTimeoutSeconds: 30,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
      maxWorkspaceBytes: 100 * 1024 * 1024
    },
    queuedAt: "2023-12-31T23:02:00.000Z"
  });
  return {
    workspaceId: workspace.id,
    objectKey: objectKeys[0]!,
    objectKeys
  };
}

function createManagedObjectAttachmentService(input: {
  managedObjects: ReturnType<typeof createManagedObjectAccess>;
  /** Stores the objects under `files/`; set to let the service remove orphaned ones. */
  byteStore?: RecordingByteStore;
}): ChatAttachmentService {
  const { byteStore } = input;
  return {
    ...(byteStore
      ? {
          async deleteOrphanedFileObjects({ objectKeys }) {
            const ownKeys = objectKeys.filter((key) => key.startsWith("files/"));
            for (const key of ownKeys) {
              await byteStore.deleteObject(key);
            }
            return ownKeys;
          }
        }
      : {}),
    maxFileBytes: 1024 * 1024,
    acceptedFileTypes: ["text/plain"],
    async listDraftAttachments() {
      return [];
    },
    async uploadDraftAttachment() {
      throw new Error("Upload is not used in retention tests");
    },
    async retryDraftAttachment() {
      throw new Error("Retry is not used in retention tests");
    },
    async deleteDraftAttachment() {
      throw new Error("Draft deletion is not used in retention tests");
    },
    async deleteConversationAttachments(deleteInput) {
      return input.managedObjects.deleteConversationObjects(deleteInput);
    },
    async readConversationFile() {
      throw new Error("File reads are not used in retention tests");
    },
    blockingDraftAttachmentMessage() {
      return undefined;
    },
    createAttachmentManifest() {
      return {
        version: 1,
        attachments: []
      };
    },
    isInlineDisplayMimeType() {
      return false;
    }
  };
}

async function expectConversationStatus(
  store: InMemoryPlatformStore,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  status: Conversation["status"]
): Promise<void> {
  await expect(store.getConversation(clientInstanceId, conversationId)).resolves.toMatchObject({
    status
  });
}

async function expectDeletedManagedObjects(
  store: PlatformFileStore,
  byteStore: RecordingByteStore,
  clientInstanceId: ClientInstanceId,
  objects: {
    attachment: ConversationAttachment;
    file: ManagedFileRecord;
    artifact: ManagedArtifactRecord;
  }
): Promise<void> {
  await expect(
    store.getConversationAttachment({
      clientInstanceId,
      attachmentId: objects.attachment.id
    })
  ).resolves.toBeUndefined();
  await expect(
    store.getManagedFile({
      clientInstanceId,
      fileId: objects.file.id
    })
  ).resolves.toBeUndefined();
  await expect(
    store.getManagedArtifact({
      clientInstanceId,
      artifactId: objects.artifact.id
    })
  ).resolves.toBeUndefined();
  expect(byteStore.has(objects.file.objectKey)).toBe(false);
  expect(byteStore.has(objects.artifact.objectKey)).toBe(false);
  expect(byteStore.deletedKeys).toEqual(
    expect.arrayContaining([objects.artifact.objectKey, objects.file.objectKey])
  );
}

async function expectDeletedWorkspaceObjects(
  store: InMemoryPlatformStore,
  byteStore: RecordingByteStore,
  clientInstanceId: ClientInstanceId,
  objects: {
    workspaceId: string;
    objectKey: string;
    objectKeys: string[];
  }
): Promise<void> {
  await expect(
    store.getExecutionWorkspace({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(objects.workspaceId)
    })
  ).resolves.toBeUndefined();
  await expect(
    store.listWorkspaceFiles({
      clientInstanceId,
      workspaceId: asExecutionWorkspaceId(objects.workspaceId)
    })
  ).resolves.toEqual([]);
  for (const objectKey of objects.objectKeys) {
    expect(byteStore.has(objectKey)).toBe(false);
  }
  expect(byteStore.deletedKeys).toEqual(expect.arrayContaining(objects.objectKeys));
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion");
}

class RecordingByteStore implements ManagedObjectByteStore {
  readonly deletedKeys: string[] = [];
  private readonly objects = new Map<string, Uint8Array>();
  private readonly failuresByKey = new Map<string, number>();

  async putObject(input: { key: string; body: Uint8Array }): Promise<void> {
    this.objects.set(input.key, input.body);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object ${key} is not available`);
    }
    return object;
  }

  async deleteObject(key: string): Promise<void> {
    const remainingFailures = this.failuresByKey.get(key) ?? 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) {
        this.failuresByKey.delete(key);
      } else {
        this.failuresByKey.set(key, remainingFailures - 1);
      }
      throw new Error(`Object ${key} deletion failed`);
    }
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  failNextDeleteFor(key: string): void {
    this.failuresByKey.set(key, (this.failuresByKey.get(key) ?? 0) + 1);
  }
}
