import {
  type Conversation,
  type ConversationId,
  type JsonObject,
  type ManagedFileId,
  type ManagedObjectDeletionResult,
  createPlatformId,
  isAppError
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import {
  cleanupExecutionWorkspaceForConversation,
  executionWorkspaceCleanupAuditMetadata
} from "./workspace-cleanup";

export interface ConversationRetentionRunSummary {
  expiredCount: number;
  failedCount: number;
}

export interface OrphanedFileCleanupSummary {
  /** Managed files marked deleted. */
  fileCount: number;
  /** Stored objects removed. */
  objectCount: number;
  /** Orphaned files left alone because no attachment handler stores their object. */
  unclaimedCount: number;
}

export interface ConversationRetentionJobOptions {
  batchSize?: number;
  checkIntervalMs?: number;
  runOnStartup?: boolean;
  now?: () => Date;
}

interface RetentionLogger {
  error(input: unknown, message?: string): void;
}

const DEFAULT_RETENTION_BATCH_SIZE = 100;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/**
 * A Conversation without messages or draft attachments is an abandoned draft: it was created to
 * hold uploads that were removed again. The grace period keeps a conversation that is still
 * being set up, with uploads in flight or a first message about to be sent.
 */
const ABANDONED_CONVERSATION_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * An upload stores its managed file a moment before the attachment that refers to it. The
 * grace period keeps a file that is still on its way into a Conversation.
 */
const ORPHANED_FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export class ConversationRetentionWorkflow {
  private readonly options: ChatServerOptions;
  private readonly batchSize: number;
  private readonly now: () => Date;
  /** False when the client instance keeps conversations indefinitely. */
  private readonly expireConversations: boolean;

  constructor(options: ChatServerOptions, jobOptions: ConversationRetentionJobOptions = {}) {
    this.options = options;
    this.expireConversations = options.config.retention.expireConversations;
    this.batchSize = jobOptions.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
    this.now = jobOptions.now ?? (() => new Date());
  }

  async expireDueConversations(): Promise<ConversationRetentionRunSummary> {
    const currentTime = this.now();
    const now = currentTime.toISOString();
    // Keeping conversations indefinitely covers the ones a user started. An abandoned draft
    // is an empty shell and is removed either way.
    const expired = await this.options.conversationStore.listExpiredConversations({
      clientInstanceId: this.options.clientInstanceId,
      ...(this.expireConversations ? { now } : {}),
      abandonedBefore: new Date(
        currentTime.getTime() - ABANDONED_CONVERSATION_GRACE_MS
      ).toISOString(),
      limit: this.batchSize
    });
    let expiredCount = 0;
    let failedCount = 0;

    for (const conversation of expired) {
      const result = await this.expireConversation(conversation, now);
      if (result === "expired") {
        expiredCount += 1;
      } else if (result === "failed") {
        failedCount += 1;
      }
    }

    return {
      expiredCount,
      failedCount
    };
  }

  /**
   * Removes managed files that no active Conversation refers to, with their stored objects.
   * Deleting a Conversation or a user removes its files, so this only finds what an earlier
   * deletion or an interrupted upload left behind. Safe to repeat.
   */
  async deleteOrphanedManagedFiles(): Promise<OrphanedFileCleanupSummary> {
    const summary: OrphanedFileCleanupSummary = { fileCount: 0, objectCount: 0, unclaimedCount: 0 };
    const attachments = this.options.attachments;
    if (!attachments?.deleteOrphanedFileObjects) {
      return summary;
    }
    const currentTime = this.now();
    const deletedAt = currentTime.toISOString();
    const createdBefore = new Date(currentTime.getTime() - ORPHANED_FILE_GRACE_MS).toISOString();
    const store = this.options.conversationStore;
    try {
      let afterFileId: ManagedFileId | undefined;
      for (;;) {
        const orphans = await store.listOrphanedManagedFiles({
          clientInstanceId: this.options.clientInstanceId,
          createdBefore,
          afterFileId,
          limit: this.batchSize
        });
        const removableKeys = [
          ...new Set(orphans.filter((file) => !file.objectKeyInUse).map((file) => file.objectKey))
        ];
        const removedKeys = new Set(
          removableKeys.length > 0
            ? await attachments.deleteOrphanedFileObjects({ objectKeys: removableKeys })
            : []
        );
        // A file whose object nobody stores keeps its row, so that the object stays findable.
        const settled = orphans.filter(
          (file) => file.objectKeyInUse || removedKeys.has(file.objectKey)
        );
        summary.fileCount += await store.markOrphanedManagedFilesDeleted({
          clientInstanceId: this.options.clientInstanceId,
          fileIds: settled.map((file) => file.id),
          createdBefore,
          deletedAt
        });
        summary.objectCount += removedKeys.size;
        summary.unclaimedCount += orphans.length - settled.length;
        afterFileId = orphans.at(-1)?.id;
        if (orphans.length < this.batchSize) {
          break;
        }
      }
    } catch (error) {
      await this.options.auditRecorder.record({
        type: "storage.orphaned_file_cleanup_failed",
        status: "failed",
        correlationId: createPlatformId("corr"),
        metadata: {
          ...summary,
          errorCode: isAppError(error) ? error.code : "INTERNAL",
          errorCategory: "orphaned_file_cleanup",
          errorMessage: "Orphaned file cleanup failed"
        }
      });
      throw error;
    }
    if (summary.fileCount > 0) {
      await this.options.auditRecorder.record({
        type: "storage.orphaned_files_deleted",
        status: "success",
        correlationId: createPlatformId("corr"),
        metadata: { ...summary }
      });
    }
    return summary;
  }

  private async expireConversation(
    conversation: Conversation,
    expiredAt: string
  ): Promise<"expired" | "skipped" | "failed"> {
    try {
      const objectDeletion = await this.deleteConversationObjects(conversation.id, expiredAt);
      const workspaceDeletion = await cleanupExecutionWorkspaceForConversation(this.options, {
        conversationId: conversation.id,
        deletedAt: expiredAt
      });
      const expired = await this.options.conversationStore.expireConversation({
        clientInstanceId: this.options.clientInstanceId,
        conversationId: conversation.id,
        expiredAt
      });
      await this.options.auditRecorder.record({
        type: "conversation.retention_expired",
        status: "success",
        subject: expired.id,
        correlationId: createPlatformId("corr"),
        metadata: createRetentionAuditMetadata(
          conversation,
          expiredAt,
          this.expireConversations,
          objectDeletion,
          workspaceDeletion
        )
      });
      return "expired";
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") {
        return "skipped";
      }
      await this.recordRetentionFailure(conversation, error);
      return "failed";
    }
  }

  private async deleteConversationObjects(
    conversationId: ConversationId,
    deletedAt: string
  ): Promise<ManagedObjectDeletionResult | undefined> {
    if (!this.options.attachments) {
      return undefined;
    }
    return this.options.attachments.deleteConversationAttachments({
      conversationId,
      deletedAt
    });
  }

  private async recordRetentionFailure(conversation: Conversation, error: unknown): Promise<void> {
    await this.options.auditRecorder.record({
      type: "conversation.retention_expiration_failed",
      status: "failed",
      subject: conversation.id,
      correlationId: createPlatformId("corr"),
      metadata: {
        retainedUntil: conversation.retainedUntil,
        ...toAuditErrorMetadata(error)
      }
    });
  }
}

export class ConversationRetentionJob {
  private readonly workflow: ConversationRetentionWorkflow;
  private readonly checkIntervalMs: number;
  private readonly runOnStartup: boolean;
  private readonly logger: RetentionLogger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(input: {
    workflow: ConversationRetentionWorkflow;
    options?: ConversationRetentionJobOptions;
    logger: RetentionLogger;
  }) {
    this.workflow = input.workflow;
    this.checkIntervalMs = input.options?.checkIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS;
    this.runOnStartup = input.options?.runOnStartup ?? true;
    this.logger = input.logger;
  }

  start(): void {
    if (this.runOnStartup) {
      this.run();
    }
    if (this.checkIntervalMs <= 0 || this.timer) {
      return;
    }
    this.timer = setInterval(() => this.run(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  run(): void {
    if (this.running) {
      return;
    }
    const currentRun = this.workflow
      .expireDueConversations()
      .catch((error: unknown) => {
        this.logger.error({ error }, "Conversation retention expiration failed");
      })
      .then(() => this.workflow.deleteOrphanedManagedFiles())
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error({ error }, "Orphaned file cleanup failed");
      })
      .finally(() => {
        if (this.running === currentRun) {
          this.running = undefined;
        }
      });
    this.running = currentRun;
  }
}

export function createConversationRetentionJob(
  options: ChatServerOptions,
  input: {
    logger: RetentionLogger;
    jobOptions?: ConversationRetentionJobOptions;
  }
): ConversationRetentionJob {
  return new ConversationRetentionJob({
    workflow: new ConversationRetentionWorkflow(options, input.jobOptions),
    options: input.jobOptions,
    logger: input.logger
  });
}

function createRetentionAuditMetadata(
  conversation: Conversation,
  expiredAt: string,
  expireConversations: boolean,
  deletion: ManagedObjectDeletionResult | undefined,
  workspaceDeletion: Awaited<ReturnType<typeof cleanupExecutionWorkspaceForConversation>>
): JsonObject {
  return {
    retainedUntil: conversation.retainedUntil,
    expiredAt,
    ...(!expireConversations || conversation.retainedUntil > expiredAt
      ? { reason: "abandoned_draft" }
      : {}),
    attachmentCount: deletion?.attachmentCount ?? 0,
    fileCount: deletion?.fileObjectKeys.length ?? 0,
    artifactCount: deletion?.artifactObjectKeys.length ?? 0,
    ...executionWorkspaceCleanupAuditMetadata(workspaceDeletion)
  };
}

function toAuditErrorMetadata(error: unknown): JsonObject {
  return {
    errorCode: isAppError(error) ? error.code : "INTERNAL",
    errorCategory: "retention_expiration",
    errorMessage: "Conversation retention expiration failed"
  };
}
