import {
  createPlatformId,
  isAppError,
  type ConversationId,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceDeletionSummary,
  type JsonObject
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

export interface ExecutionWorkspaceCleanupRunSummary {
  cleanedCount: number;
  failedCount: number;
}

export interface ExecutionWorkspaceCleanupJobOptions {
  batchSize?: number;
  checkIntervalMs?: number;
  runOnStartup?: boolean;
  now?: () => Date;
}

interface WorkspaceCleanupLogger {
  error(input: unknown, message?: string): void;
}

const DEFAULT_CLEANUP_BATCH_SIZE = 100;
const DEFAULT_CLEANUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export class ExecutionWorkspaceCleanupWorkflow {
  private readonly store: ExecutionWorkspaceCleanupStore;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(private readonly options: ChatServerOptions, jobOptions: ExecutionWorkspaceCleanupJobOptions = {}) {
    if (!options.executionWorkspaceCleanup) {
      throw new Error("Execution workspace cleanup is not configured");
    }
    this.store = options.executionWorkspaceCleanup.store;
    this.batchSize = jobOptions.batchSize ?? DEFAULT_CLEANUP_BATCH_SIZE;
    this.now = jobOptions.now ?? (() => new Date());
  }

  async cleanupDeletedConversationWorkspaces(): Promise<ExecutionWorkspaceCleanupRunSummary> {
    const targets = await this.store.listExecutionWorkspaceCleanupTargets({
      clientInstanceId: this.options.clientInstanceId,
      limit: this.batchSize
    });
    let cleanedCount = 0;
    let failedCount = 0;
    const deletedAt = this.now().toISOString();
    for (const target of targets) {
      try {
        await cleanupExecutionWorkspaceForConversation(this.options, {
          conversationId: target.conversationId,
          deletedAt
        });
        cleanedCount += 1;
      } catch (error) {
        failedCount += 1;
        await recordWorkspaceCleanupFailure(this.options, target.conversationId, error);
      }
    }
    return { cleanedCount, failedCount };
  }
}

export class ExecutionWorkspaceCleanupJob {
  private readonly workflow: ExecutionWorkspaceCleanupWorkflow;
  private readonly checkIntervalMs: number;
  private readonly runOnStartup: boolean;
  private readonly logger: WorkspaceCleanupLogger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(input: {
    workflow: ExecutionWorkspaceCleanupWorkflow;
    options?: ExecutionWorkspaceCleanupJobOptions;
    logger: WorkspaceCleanupLogger;
  }) {
    this.workflow = input.workflow;
    this.checkIntervalMs = input.options?.checkIntervalMs ?? DEFAULT_CLEANUP_CHECK_INTERVAL_MS;
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
      .cleanupDeletedConversationWorkspaces()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error({ error }, "Execution workspace cleanup failed");
      })
      .finally(() => {
        if (this.running === currentRun) {
          this.running = undefined;
        }
      });
    this.running = currentRun;
  }
}

export function createExecutionWorkspaceCleanupJob(
  options: ChatServerOptions,
  input: {
    logger: WorkspaceCleanupLogger;
  }
): ExecutionWorkspaceCleanupJob | undefined {
  if (!options.executionWorkspaceCleanup) {
    return undefined;
  }
  return new ExecutionWorkspaceCleanupJob({
    workflow: new ExecutionWorkspaceCleanupWorkflow(
      options,
      options.executionWorkspaceCleanup.jobOptions
    ),
    options: options.executionWorkspaceCleanup.jobOptions,
    logger: input.logger
  });
}

export async function cleanupExecutionWorkspaceForConversation(
  options: ChatServerOptions,
  input: {
    conversationId: ConversationId;
    deletedAt: string;
  }
): Promise<ExecutionWorkspaceDeletionSummary | undefined> {
  const cleanup = options.executionWorkspaceCleanup;
  if (!cleanup) {
    return undefined;
  }
  const pending = await cleanup.store.listExecutionWorkspaceObjectsForDeletion({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId
  });
  if (pending.fileObjectKeys.length > 0 && !cleanup.objects) {
    throw new Error("Execution workspace object deletion is not configured");
  }
  if (cleanup.objects) {
    await Promise.all(pending.fileObjectKeys.map((objectKey) => cleanup.objects!.deleteObject(objectKey)));
  }
  const deleted = await cleanup.store.markExecutionWorkspaceDeleted({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId,
    deletedAt: input.deletedAt
  });
  if (deleted.workspaceCount > 0 || deleted.fileCount > 0 || deleted.commandCount > 0) {
    await options.auditRecorder.record({
      type: "execution_workspace.cleaned_up",
      status: "success",
      subject: input.conversationId,
      correlationId: createPlatformId("corr"),
      metadata: executionWorkspaceCleanupAuditMetadata(deleted)
    });
  }
  return deleted;
}

export function executionWorkspaceCleanupAuditMetadata(
  summary: ExecutionWorkspaceDeletionSummary | undefined
): JsonObject {
  return {
    workspaceCount: summary?.workspaceCount ?? 0,
    workspaceFileCount: summary?.fileCount ?? 0,
    workspaceCommandCount: summary?.commandCount ?? 0,
    workspaceObjectCount: summary?.fileObjectKeys.length ?? 0
  };
}

async function recordWorkspaceCleanupFailure(
  options: ChatServerOptions,
  conversationId: ConversationId,
  error: unknown
): Promise<void> {
  await options.auditRecorder.record({
    type: "execution_workspace.cleanup_failed",
    status: "failed",
    subject: conversationId,
    correlationId: createPlatformId("corr"),
    metadata: workspaceCleanupFailureAuditMetadata(error)
  });
}

export function workspaceCleanupFailureAuditMetadata(error: unknown): JsonObject {
  return {
    errorCode: isAppError(error) ? error.code : "INTERNAL",
    errorCategory: "workspace_cleanup",
    errorMessage: "Execution workspace cleanup failed"
  };
}
