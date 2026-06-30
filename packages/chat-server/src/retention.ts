import {
  type Conversation,
  type ConversationId,
  type JsonObject,
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

export class ConversationRetentionWorkflow {
  private readonly options: ChatServerOptions;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(options: ChatServerOptions, jobOptions: ConversationRetentionJobOptions = {}) {
    this.options = options;
    this.batchSize = jobOptions.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
    this.now = jobOptions.now ?? (() => new Date());
  }

  async expireDueConversations(): Promise<ConversationRetentionRunSummary> {
    const now = this.now().toISOString();
    const expired = await this.options.conversationStore.listExpiredConversations({
      clientInstanceId: this.options.clientInstanceId,
      now,
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
        metadata: createRetentionAuditMetadata(conversation, expiredAt, objectDeletion, workspaceDeletion)
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
    this.checkIntervalMs =
      input.options?.checkIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS;
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
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error({ error }, "Conversation retention expiration failed");
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
  deletion: ManagedObjectDeletionResult | undefined,
  workspaceDeletion: Awaited<ReturnType<typeof cleanupExecutionWorkspaceForConversation>>
): JsonObject {
  return {
    retainedUntil: conversation.retainedUntil,
    expiredAt,
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
