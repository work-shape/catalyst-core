import type { Logger } from "@vivd-catalyst/core";
import {
  type Conversation,
  type ExpireConversationResult,
  type JsonObject,
  type ManagedFileId,
  createPlatformId,
  isAppError
} from "@vivd-catalyst/core";
import {
  attemptConversationDataCleanup,
  retryPendingConversationCleanup,
  type ConversationCleanupRetrySummary
} from "./conversation-cleanup";
import type { ChatServerOptions, ConversationRetentionOptions } from "./types";

export interface ConversationRetentionRunSummary {
  expiredCount: number;
  /** Conversations whose claim failed. One that is no longer due is skipped, not failed. */
  failedCount: number;
  /** Expired Conversations whose data cleanup failed and waits for the retry. */
  cleanupPendingCount: number;
}

export interface OrphanedFileCleanupSummary {
  /** Managed files marked deleted. */
  fileCount: number;
  /** Stored objects removed. */
  objectCount: number;
  /** Orphaned files left alone because no attachment handler stores their object. */
  unclaimedCount: number;
}

const DEFAULT_RETENTION_BATCH_SIZE = 100;
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

  constructor(options: ChatServerOptions, jobOptions: ConversationRetentionOptions = {}) {
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
    const criteria = {
      ...(this.expireConversations ? { now } : {}),
      abandonedBefore: new Date(
        currentTime.getTime() - ABANDONED_CONVERSATION_GRACE_MS
      ).toISOString()
    };
    const expired = await this.options.stores.conversations.listExpiredConversations({
      clientInstanceId: this.options.clientInstanceId,
      ...criteria,
      limit: this.batchSize
    });
    const summary: ConversationRetentionRunSummary = {
      expiredCount: 0,
      failedCount: 0,
      cleanupPendingCount: 0
    };

    for (const conversation of expired) {
      const result = await this.expireConversation(conversation, criteria, now);
      if (result === "failed") {
        summary.failedCount += 1;
      } else if (result !== "skipped") {
        summary.expiredCount += 1;
        if (result === "cleanup_pending") {
          summary.cleanupPendingCount += 1;
        }
      }
    }

    return summary;
  }

  /**
   * One run of retention, as the `conversation.expire` job makes it. The cleanup retry comes
   * first, so a cleanup that fails during this run's expiry is attempted once in this run and
   * again in the next. A step that fails does not keep the later steps from running; the run
   * then fails with the first error.
   */
  async run(logger: Logger): Promise<void> {
    const failures: unknown[] = [];
    let cleanupPendingCount = 0;
    try {
      cleanupPendingCount += (await this.cleanUpPendingConversations()).cleanupPendingCount;
    } catch (error) {
      logger.error({ error }, "Conversation data cleanup failed");
      failures.push(error);
    }
    try {
      cleanupPendingCount += (await this.expireDueConversations()).cleanupPendingCount;
    } catch (error) {
      logger.error({ error }, "Conversation retention expiration failed");
      failures.push(error);
    }
    if (cleanupPendingCount > 0) {
      logger.error({ cleanupPendingCount }, "Conversation data cleanup is pending");
    }
    try {
      await this.deleteOrphanedManagedFiles();
    } catch (error) {
      logger.error({ error }, "Orphaned file cleanup failed");
      failures.push(error);
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * Finishes the cleanup of Conversations that are deleted or expired and still hold files,
   * artifacts, preview state or Pages, because an earlier cleanup failed or the process stopped.
   * Safe to repeat.
   */
  async cleanUpPendingConversations(): Promise<ConversationCleanupRetrySummary> {
    // Without an attachment service and without the store of Pages nothing here can remove
    // stored objects. Either one is enough: the Pages of a Conversation are removed by the
    // retry whether or not the instance keeps attachments.
    if (!this.options.attachments && !this.options.pages) {
      return { completedCount: 0, cleanupPendingCount: 0 };
    }
    return retryPendingConversationCleanup(this.options, {
      limit: this.batchSize,
      deletedAt: this.now().toISOString()
    });
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
    const store = this.options.stores;
    try {
      let afterFileId: ManagedFileId | undefined;
      for (;;) {
        const orphans = await store.files.listOrphanedManagedFiles({
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
        summary.fileCount += await store.files.markOrphanedManagedFilesDeleted({
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

  /**
   * Claims first: the store expires the Conversation only if it still meets the criteria under
   * its row lock. Nothing of the Conversation is touched before that, and the cleanup that
   * follows cannot undo it.
   */
  private async expireConversation(
    conversation: Conversation,
    criteria: { now?: string; abandonedBefore: string },
    expiredAt: string
  ): Promise<"expired" | "cleanup_pending" | "skipped" | "failed"> {
    let result: ExpireConversationResult;
    try {
      result = await this.options.stores.conversations.expireConversation({
        clientInstanceId: this.options.clientInstanceId,
        conversationId: conversation.id,
        expiredAt,
        ...criteria
      });
    } catch (error) {
      await this.recordRetentionFailure(conversation, error);
      return "failed";
    }
    if (result.status === "not_expired") {
      return "skipped";
    }
    const cleanup = await attemptConversationDataCleanup(
      this.options,
      result.conversation.id,
      expiredAt
    );
    await this.options.auditRecorder.record({
      type: "conversation.retention_expired",
      status: "success",
      subject: result.conversation.id,
      correlationId: createPlatformId("corr"),
      metadata: {
        retainedUntil: result.conversation.retainedUntil,
        expiredAt,
        reason: result.reason,
        ...cleanup
      }
    });
    return cleanup.cleanup === "pending" ? "cleanup_pending" : "expired";
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

function toAuditErrorMetadata(error: unknown): JsonObject {
  return {
    errorCode: isAppError(error) ? error.code : "INTERNAL",
    errorCategory: "retention_expiration",
    errorMessage: "Conversation retention expiration failed"
  };
}
