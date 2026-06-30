import { describe, expect, it } from "vitest";
import {
  ConversationRetentionJob,
  ConversationRetentionWorkflow,
  ExecutionWorkspaceCleanupWorkflow,
  type ChatAttachmentService,
  type ChatServerOptions
} from "@vivd-catalyst/chat-server";
import { createManagedObjectAccess, type ManagedObjectByteStore } from "@vivd-catalyst/capability-sdk";
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

      await expect(store.listMessages({
        clientInstanceId,
        conversationId: startupConversation.id
      })).rejects.toMatchObject({
        code: "NOT_FOUND"
      });
      await expectDeletedManagedObjects(store, byteStore, clientInstanceId, startupObjects);
      await expectDeletedWorkspaceObjects(store, byteStore, clientInstanceId, startupWorkspaceObjects);

      const periodicConversation = await createExpiredConversation(store, clientInstanceId, "periodic");
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
        (event) => event.subject === startupConversation.id && event.type === "conversation.retention_expired"
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
          workspaceFileCount: 1,
          workspaceCommandCount: 1,
          workspaceObjectCount: 1
        })
      });
      expect(startupAudit).not.toHaveProperty("actor");
      expect(
        events.find(
          (event) => event.subject === periodicConversation.id && event.type === "conversation.retention_expired"
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
    await expect(store.getConversationAttachment({
      clientInstanceId,
      attachmentId: objects.attachment.id
    })).resolves.toMatchObject({
      id: objects.attachment.id,
      status: "ready"
    });
    await expect(store.getManagedArtifact({
      clientInstanceId,
      artifactId: objects.artifact.id
    })).resolves.toMatchObject({
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
    const failureAudit = events.find((event) => event.type === "conversation.retention_expiration_failed");
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
    const conversation = await createExpiredConversation(store, clientInstanceId, "workspace-failure");
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
    const failureAudit = events.find((event) => event.type === "conversation.retention_expiration_failed");
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
    const conversation = await createExpiredConversation(store, clientInstanceId, "cleanup-failure");
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
    const cleanupAudit = events.find((event) => event.type === "execution_workspace.cleanup_failed");
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

function createRetentionOptions(input: {
  clientInstanceId: ClientInstanceId;
  store: InMemoryPlatformStore;
  attachments?: ChatAttachmentService;
  workspaceObjects?: { deleteObject(key: string): Promise<void> };
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
        auditDays: 365,
        allowUserDelete: true
      },
      defaultAgentName: "test_agent",
      agents: [
        {
          name: "test_agent",
          displayName: "Test Agent",
          instructions: "Test only.",
          toolNames: []
        }
      ],
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
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "external-user-1",
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
    ownerUserId: input.conversation.ownerUserId,
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
}> {
  const workspace = await input.store.ensureExecutionWorkspace({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversation.id,
    ownerUserId: input.conversation.ownerUserId,
    now: "2023-12-31T23:00:00.000Z"
  });
  const objectKey = `execution-workspaces/${input.conversation.id}/internal-notes.txt`;
  const bytes = new TextEncoder().encode("internal workspace notes");
  await input.byteStore.putObject({ key: objectKey, body: bytes });
  await input.store.upsertWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "internal-notes.txt",
    objectKey,
    byteSize: bytes.byteLength,
    checksum: "sha256:internal-notes",
    mimeType: "text/plain",
    lastCommandId: asWorkspaceCommandId("wcmd_retention_seed"),
    updatedAt: "2023-12-31T23:01:00.000Z"
  });
  await input.store.enqueueWorkspaceCommand({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    ownerUserId: input.conversation.ownerUserId,
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
    objectKey
  };
}

function createManagedObjectAttachmentService(input: {
  managedObjects: ReturnType<typeof createManagedObjectAccess>;
}): ChatAttachmentService {
  return {
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
  await expect(store.getConversationAttachment({
    clientInstanceId,
    attachmentId: objects.attachment.id
  })).resolves.toBeUndefined();
  await expect(store.getManagedFile({
    clientInstanceId,
    fileId: objects.file.id
  })).resolves.toBeUndefined();
  await expect(store.getManagedArtifact({
    clientInstanceId,
    artifactId: objects.artifact.id
  })).resolves.toBeUndefined();
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
  }
): Promise<void> {
  await expect(store.getExecutionWorkspace({
    clientInstanceId,
    workspaceId: asExecutionWorkspaceId(objects.workspaceId)
  })).resolves.toBeUndefined();
  expect(byteStore.has(objects.objectKey)).toBe(false);
  expect(byteStore.deletedKeys).toContain(objects.objectKey);
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
