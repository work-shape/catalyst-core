import type { ChatAttachmentService, ChatServerOptions } from "@vivd-catalyst/chat-server";
import {
  createManagedObjectAccess,
  type ManagedObjectByteStore
} from "@vivd-catalyst/capability-sdk";
import {
  StoreBackedAuditRecorder,
  type AuthenticatedUser,
  type Logger,
  type ClientInstanceId,
  type Conversation,
  type ConversationAttachment,
  type ExecutionWorkspaceId,
  type ManagedArtifactRecord,
  type ManagedFileRecord,
  type PlatformFileStore
} from "@vivd-catalyst/core";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { PostgresStores } from "@vivd-catalyst/postgres-store";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createMissingRuntime, createUnusedModelProvider } from "./chat-server-run-harness";
import { completeServerOptions } from "./test-instance";

export type ManagedObjectAccess = ReturnType<typeof createManagedObjectAccess>;

/** Object keys that name the Conversation, so that a test can tell whose object was touched. */
export function createTestManagedObjectAccess(input: {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  byteStore: ManagedObjectByteStore;
  logger?: Logger;
}): ManagedObjectAccess {
  return createManagedObjectAccess({
    ...input,
    keyFactory: {
      createFileObjectKey(key) {
        return `files/${key.conversationId ?? "unscoped"}/${key.checksum}`;
      },
      createArtifactObjectKey(key) {
        return `artifacts/${key.conversationId}/${key.kind}/${key.checksum}`;
      }
    }
  });
}

/**
 * Server options for the retention and deletion workflows. The background jobs do not run on
 * their own, so a test decides when a retention pass happens.
 */
export function createRetentionOptions(input: {
  clientInstanceId: ClientInstanceId;
  store: PostgresStores;
  attachments?: ChatAttachmentService;
  workspaceObjects?: { deleteObject(key: string): Promise<void> };
  expireConversations?: boolean;
  /** Who a request is made by. Only the tests that send requests need it. */
  authenticate?: (userId: string | undefined) => AuthenticatedUser;
}): ChatServerOptions {
  const { store } = input;
  const config = parseClientInstanceConfig({
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
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    tools: []
  });
  return completeServerOptions(
    {
      config,
      clientInstanceId: input.clientInstanceId,
      authAdapter: {
        credentialMode: "ambient",
        id: "test-auth",
        async authenticate(request) {
          if (!input.authenticate) {
            throw new Error("This test does not send requests");
          }
          const header = request.headers["x-dev-user-id"];
          return input.authenticate(Array.isArray(header) ? header[0] : header);
        }
      },
      stores: store,
      usageGovernance: new ModelUsageGovernance({
        store: store.usage,
        budget: config.usage.budget,
        safeguards: config.usage.safeguards,
        costs: config.usage.costs
      }),
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: input.clientInstanceId,
        store: store.audit
      }),
      agentRuntime: createMissingRuntime(),
      attachments: input.attachments,
      executionWorkspaceCleanup: input.workspaceObjects
        ? {
            store: store.executionWorkspaces,
            objects: input.workspaceObjects,
            jobOptions: {
              checkIntervalMs: 0,
              runOnStartup: false
            }
          }
        : undefined,
      retentionExpiration: { checkIntervalMs: 0, runOnStartup: false },
      runRecovery: { runOnStartup: false, watchdogIntervalMs: 60 * 60 * 1000 },
      modelProvider: createUnusedModelProvider()
    },
    store
  );
}

export async function createAttachedObjects(input: {
  store: PlatformFileStore;
  managedObjects: ManagedObjectAccess;
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

/** An execution workspace with one stored file, as a run leaves it behind. */
export async function createExecutionWorkspaceData(input: {
  store: PostgresStores;
  byteStore: RecordingByteStore;
  clientInstanceId: ClientInstanceId;
  conversation: Conversation;
}): Promise<{ workspaceId: ExecutionWorkspaceId; objectKey: string }> {
  const workspace = await input.store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversation.id,
    ownerUserId: input.conversation.createdByUserId,
    now: new Date().toISOString()
  });
  const objectKey = `execution-workspaces/${input.conversation.id}/report.csv`;
  const bytes = new TextEncoder().encode("value\n42\n");
  await input.byteStore.putObject({ key: objectKey, body: bytes });
  await input.store.executionWorkspaces.upsertWorkspaceFile({
    clientInstanceId: input.clientInstanceId,
    workspaceId: workspace.id,
    path: "report.csv",
    objectKey,
    byteSize: bytes.byteLength,
    checksum: "sha256:report.csv",
    mimeType: "text/csv",
    metadata: { source: "workspace.exec" },
    updatedAt: new Date().toISOString()
  });
  return { workspaceId: workspace.id, objectKey };
}

export function createManagedObjectAttachmentService(input: {
  managedObjects: ManagedObjectAccess;
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

export class RecordingByteStore implements ManagedObjectByteStore {
  readonly deletedKeys: string[] = [];
  /** Every key a deletion was asked for, whether or not it went through. */
  readonly deleteAttempts: string[] = [];
  /** While true, every deletion fails. */
  failDeletes = false;
  /** Runs before each deletion is attempted, so a test can look at the state it happens in. */
  onDeleteAttempt: ((key: string) => Promise<void>) | undefined;
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
    this.deleteAttempts.push(key);
    await this.onDeleteAttempt?.(key);
    if (this.failDeletes) {
      throw new Error(`Object ${key} deletion failed`);
    }
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

  keys(): string[] {
    return [...this.objects.keys()];
  }

  failNextDeleteFor(key: string): void {
    this.failuresByKey.set(key, (this.failuresByKey.get(key) ?? 0) + 1);
  }
}
