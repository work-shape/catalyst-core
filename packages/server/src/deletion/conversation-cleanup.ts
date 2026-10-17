import {
  createPlatformId,
  isAppError,
  type AuditActor,
  type CollaborationWorkspaceId,
  type ConversationId,
  type UserId
} from "@work-shape/catalyst-core";
import { deleteConversationPages } from "../pages/page-file-sets";
import { OPERATION_CALL_APPROVAL_KIND } from "@work-shape/catalyst-tool-execution";
import type { ChatServerOptions } from "../types";
import { endHeldOperationCalls } from "../approvals/operation-call-approval-handler";
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
 * Removes the Try conversations, stored objects, file and artifact records, preview state,
 * execution workspace, Pages, Operation Runs and agent proposals of a Conversation that is
 * already deleted or expired. Call it only after the claim: it does not check that the
 * Conversation may be deleted. Safe to repeat.
 */
async function cleanUpConversationData(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string
): Promise<ConversationDataDeletionTotals> {
  // A chat Conversation's runs and its subagents' runs stop first, parents before children;
  // then its run threads are cleaned up as it is (CR-1).
  await cancelRunsOfConversation(options, conversationId);
  const threads = await options.stores.childAgentRuns.listRunThreadIds({
    clientInstanceId: options.clientInstanceId,
    rootConversationId: conversationId
  });
  for (const threadId of threads) await cleanUpOneConversation(options, threadId, deletedAt);
  return cleanUpOneConversation(options, conversationId, deletedAt);
}

/** The reason a run of a deleted Conversation carries. */
const RUN_CANCELLED_WITH_CONVERSATION = "The conversation of this run was deleted.";

/**
 * Asks every run of a deleted Conversation and of its run threads that has not ended to stop.
 * A parent's end cancels its open subagents too; one that ended meanwhile needs no request.
 */
async function cancelRunsOfConversation(
  options: ChatServerOptions,
  rootConversationId: ConversationId
): Promise<void> {
  const runs = await options.stores.agentRuns.listAgentRunsInProgress({
    clientInstanceId: options.clientInstanceId,
    rootConversationId
  });
  for (const run of runs) {
    if (run.status === "cancelling") continue;
    try {
      await options.stores.agentRuns.requestAgentRunCancellation({
        clientInstanceId: options.clientInstanceId,
        runId: run.id,
        requestedAt: new Date().toISOString(),
        reason: RUN_CANCELLED_WITH_CONVERSATION
      });
    } catch (error) {
      if (!isAppError(error) || (error.code !== "CONFLICT" && error.code !== "NOT_FOUND")) {
        throw error;
      }
    }
  }
}

async function cleanUpOneConversation(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string
): Promise<ConversationDataDeletionTotals> {
  // A Build conversation's Try conversations go with it.
  await deleteTryConversations(
    options,
    { buildConversationId: conversationId },
    {
      deletedAt,
      requestedBy: "build_conversation_deleted",
      correlationId: createPlatformId("corr")
    }
  );
  const objects = options.attachments
    ? await options.attachments.deleteConversationAttachments({ conversationId, deletedAt })
    : undefined;
  const workspace = await cleanupExecutionWorkspaceForConversation(options, {
    conversationId,
    deletedAt
  });
  await deleteConversationPages(options, conversationId);
  await deleteOperationRunsOfConversation(options, conversationId);
  // A Build conversation's proposals for agents go with it; the agents stay as they are.
  await options.stores.agentProposals.removeOfConversations({
    clientInstanceId: options.clientInstanceId,
    conversationIds: [conversationId]
  });
  // Last, because it hides a Try conversation and leads the retry of its cleanup to it.
  await options.stores.agentTryConversations.remove({
    clientInstanceId: options.clientInstanceId,
    conversationId
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
 * Deletes the Operation Runs the agents of a Conversation caused. A call of theirs that still
 * waits for an approval is ended first, and its request loses the input, so nothing of a
 * deleted Conversation stays open for a decision that could execute nothing. The request of a
 * call that was decided lost its input when it ended.
 */
async function deleteOperationRunsOfConversation(
  options: ChatServerOptions,
  conversationId: ConversationId
): Promise<void> {
  const { clientInstanceId } = options;
  const approvals = options.approvalRequests?.store;
  if (approvals) {
    await endHeldOperationCalls(
      { clientInstanceId, approvals },
      { conversationId },
      {
        denial: { kind: "policy", operation: OPERATION_CALL_APPROVAL_KIND },
        message: "The conversation of this call was deleted."
      }
    );
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

/** Why a Try conversation was deleted: its proposal was settled, or its Build conversation went. */
type TryConversationDeletionReason =
  "proposal_applied" | "proposal_discarded" | "build_conversation_deleted";

/**
 * Deletes the Try conversations of a Build conversation, or the one of an agent: claims each
 * that is still active and cleans it up. A cleanup that fails is left to the retention job,
 * which the link of the Try conversation leads to it. Each claim is audited.
 */
export async function deleteTryConversations(
  options: ChatServerOptions,
  of: { buildConversationId: ConversationId; agentId?: string },
  deletion: {
    deletedAt: string;
    requestedBy: TryConversationDeletionReason;
    correlationId: string;
    actor?: AuditActor;
  }
): Promise<void> {
  const { clientInstanceId } = options;
  const tries = await options.stores.agentTryConversations.list({ clientInstanceId, ...of });
  for (const conversationId of tries) {
    // One that is gone already was claimed by an earlier pass; its cleanup is repeated.
    const claimed = await options.stores.conversations
      .deleteConversation({ clientInstanceId, conversationId, deletedAt: deletion.deletedAt })
      .then(
        () => true,
        (error: unknown) => {
          if (isAppError(error) && error.code === "NOT_FOUND") return false;
          throw error;
        }
      );
    const cleanup = await attemptConversationDataCleanup(
      options,
      conversationId,
      deletion.deletedAt
    );
    if (!claimed) continue;
    await options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      ...(deletion.actor ? { actor: deletion.actor } : {}),
      subject: conversationId,
      correlationId: deletion.correlationId,
      metadata: { requestedBy: deletion.requestedBy, ...cleanup }
    });
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
