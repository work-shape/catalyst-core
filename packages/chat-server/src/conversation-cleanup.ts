import { createPlatformId, isAppError, type ConversationId } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import { cleanupExecutionWorkspaceForConversation } from "./workspace-cleanup";

export interface ConversationDataDeletionTotals {
  attachmentCount: number;
  fileCount: number;
  artifactCount: number;
  workspaceCount: number;
  workspaceFileCount: number;
  workspaceCommandCount: number;
  workspaceObjectCount: number;
}

/** What the cleanup after a claim achieved. Spread into the audit metadata of the deletion. */
export type ConversationDataCleanupOutcome =
  ({ cleanup: "complete" } & ConversationDataDeletionTotals) | { cleanup: "pending" };

/**
 * Removes the stored objects, file and artifact records, preview state and execution workspace
 * of a Conversation that is already deleted or expired. Call it only after the claim: it does
 * not check that the Conversation may be deleted. Safe to repeat.
 */
async function cleanUpConversationData(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string
): Promise<ConversationDataDeletionTotals> {
  const objects = options.attachments
    ? await options.attachments.deleteConversationAttachments({ conversationId, deletedAt })
    : undefined;
  const workspace = await cleanupExecutionWorkspaceForConversation(options, {
    conversationId,
    deletedAt
  });
  return {
    attachmentCount: objects?.attachmentCount ?? 0,
    fileCount: objects?.fileObjectKeys.length ?? 0,
    artifactCount: objects?.artifactObjectKeys.length ?? 0,
    workspaceCount: workspace?.workspaceCount ?? 0,
    workspaceFileCount: workspace?.fileCount ?? 0,
    workspaceCommandCount: workspace?.commandCount ?? 0,
    workspaceObjectCount: workspace?.fileObjectKeys.length ?? 0
  };
}

/**
 * Runs the cleanup for a claimed Conversation and reports the outcome instead of throwing. A
 * failure is audited and left to the retention job, which retries it. It never undoes or hides
 * the deletion.
 */
export async function attemptConversationDataCleanup(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string
): Promise<ConversationDataCleanupOutcome> {
  try {
    return {
      cleanup: "complete",
      ...(await cleanUpConversationData(options, conversationId, deletedAt))
    };
  } catch (error) {
    await options.auditRecorder.record({
      type: "conversation.cleanup_failed",
      status: "failed",
      subject: conversationId,
      correlationId: createPlatformId("corr"),
      metadata: {
        errorCode: isAppError(error) ? error.code : "INTERNAL",
        errorCategory: "conversation_cleanup"
      }
    });
    return { cleanup: "pending" };
  }
}

/**
 * The number of Conversations whose pending cleanup made the store refuse to delete their
 * workspace, or undefined when the error is not that refusal.
 */
export function pendingCleanupCountOf(error: unknown): number | undefined {
  if (!isAppError(error) || error.code !== "CONFLICT") {
    return undefined;
  }
  const { details } = error;
  if (typeof details !== "object" || details === null || !("pendingCleanupCount" in details)) {
    return undefined;
  }
  return typeof details.pendingCleanupCount === "number" ? details.pendingCleanupCount : undefined;
}
