import {
  createPlatformId,
  isAppError,
  type CollaborationWorkspaceId,
  type ConversationId,
  type UserId
} from "@vivd-catalyst/core";
import { deleteConversationPages } from "./page-file-sets";
import { OPERATION_CALL_APPROVAL_KIND } from "@vivd-catalyst/tool-execution";
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
 * Removes the stored objects, file and artifact records, preview state, execution workspace and
 * Pages of a Conversation that is already deleted or expired. Call it only after the claim: it does
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
  await deleteConversationPages(options, conversationId);
  await deleteOperationRunsOfConversation(options, conversationId);
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
 * How many calls of one Conversation that still wait for an approval one cleanup ends. A
 * person may hold `HELD_OPERATION_CALLS_PER_ACTOR` at once, so one read takes them all.
 */
const HELD_CALLS_PER_CONVERSATION_LIMIT = 100;

/**
 * Deletes the Operation Runs the agents of a Conversation caused. A call of theirs that still
 * waits for an approval is ended first, so its request does not keep the input of a deleted
 * Conversation open for a decision that could execute nothing.
 */
async function deleteOperationRunsOfConversation(
  options: ChatServerOptions,
  conversationId: ConversationId
): Promise<void> {
  const { clientInstanceId } = options;
  const approvals = options.approvalRequests?.store;
  const held = approvals
    ? await approvals.listApprovalRequests({
        clientInstanceId,
        kinds: [OPERATION_CALL_APPROVAL_KIND],
        status: "pending",
        conversationId,
        page: { limit: HELD_CALLS_PER_CONVERSATION_LIMIT }
      })
    : [];
  for (const request of held) {
    try {
      await approvals?.transitionPendingApprovalRequest({
        clientInstanceId,
        requestId: request.id,
        resolve: () => Promise.resolve({ status: "superseded" })
      });
    } catch (error) {
      // Somebody decided it meanwhile.
      if (!(isAppError(error) && error.code === "CONFLICT")) throw error;
    }
  }
  await options.stores.operationRuns.deleteOfConversations({
    clientInstanceId,
    conversationIds: [conversationId]
  });
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

export interface ConversationCleanupRetrySummary {
  /** Conversations whose leftover data was removed in this pass. */
  completedCount: number;
  /** Conversations whose cleanup failed again. */
  cleanupPendingCount: number;
}

/** Which pending cleanups are meant: all, one workspace's, or those of one user's Conversations. */
export interface PendingCleanupScope {
  collaborationWorkspaceId?: CollaborationWorkspaceId;
  createdByUserId?: UserId;
}

/**
 * One pass over the Conversations that are deleted or expired and still hold data, at most
 * `limit` of them: of the instance, of one workspace, or those one user created. Each cleanup that completes is
 * audited. Safe to repeat.
 */
export async function retryPendingConversationCleanup(
  options: ChatServerOptions,
  input: PendingCleanupScope & { limit: number; deletedAt: string }
): Promise<ConversationCleanupRetrySummary> {
  const summary: ConversationCleanupRetrySummary = { completedCount: 0, cleanupPendingCount: 0 };
  const pending = await options.stores.files.listConversationsPendingObjectCleanup({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId: input.collaborationWorkspaceId,
    createdByUserId: input.createdByUserId,
    limit: input.limit
  });
  for (const conversationId of pending) {
    const { cleanup, ...counts } = await attemptConversationDataCleanup(
      options,
      conversationId,
      input.deletedAt
    );
    if (cleanup === "pending") {
      summary.cleanupPendingCount += 1;
      continue;
    }
    await options.auditRecorder.record({
      type: "conversation.cleanup_completed",
      status: "success",
      subject: conversationId,
      correlationId: createPlatformId("corr"),
      metadata: counts
    });
    summary.completedCount += 1;
  }
  return summary;
}
