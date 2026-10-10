import {
  createPlatformId,
  isAppError,
  type ConversationId,
  type ExecutionWorkspaceCleanupStore,
  type ExecutionWorkspaceDeletionSummary,
  type JsonObject
} from "@vivd-catalyst/core";
import type { ChatServerOptions, ExecutionWorkspaceCleanupJobOptions } from "./types";

export interface ExecutionWorkspaceCleanupRunSummary {
  cleanedCount: number;
  failedCount: number;
}

const DEFAULT_CLEANUP_BATCH_SIZE = 100;

export class ExecutionWorkspaceCleanupWorkflow {
  private readonly store: ExecutionWorkspaceCleanupStore;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly options: ChatServerOptions,
    jobOptions: ExecutionWorkspaceCleanupJobOptions = {}
  ) {
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

export async function cleanupExecutionWorkspaceForConversation(
  options: ChatServerOptions,
  input: {
    conversationId: ConversationId;
    deletedAt: string;
  }
): Promise<ExecutionWorkspaceDeletionSummary> {
  // An instance that has the feature off can still hold the rows of a time it was on. They
  // are read from the store of the instance, so a Conversation without stored workspace
  // objects is done, and one with objects fails here instead of looking clean.
  const store = options.executionWorkspaceCleanup?.store ?? options.stores.executionWorkspaces;
  const objects = options.executionWorkspaceCleanup?.objects;
  const pending = await store.listExecutionWorkspaceObjectsForDeletion({
    clientInstanceId: options.clientInstanceId,
    conversationId: input.conversationId
  });
  if (pending.fileObjectKeys.length > 0 && !objects) {
    throw new Error("Execution workspace object deletion is not configured");
  }
  if (objects) {
    await Promise.all(pending.fileObjectKeys.map((objectKey) => objects.deleteObject(objectKey)));
  }
  const deleted = await store.markExecutionWorkspaceDeleted({
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

function executionWorkspaceCleanupAuditMetadata(
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

function workspaceCleanupFailureAuditMetadata(error: unknown): JsonObject {
  return {
    errorCode: isAppError(error) ? error.code : "INTERNAL",
    errorCategory: "workspace_cleanup",
    errorMessage: "Execution workspace cleanup failed"
  };
}
