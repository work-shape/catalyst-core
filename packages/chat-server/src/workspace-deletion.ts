import {
  type AuditActor,
  type CollaborationWorkspaceId,
  type PlatformStores,
  type UserId
} from "@vivd-catalyst/core";
import { assertConversationIdle } from "./conversation-idle";
import { deleteWorkspaceJob } from "./job-kinds";
import {
  acceptDeletion,
  countPendingCleanup,
  deletionDedupeKey,
  retryWorkspaceCleanup,
  type DeletionOutcome,
  type DeletionTransaction
} from "./subject-deletion";
import type { ChatServerOptions } from "./types";
import { deleteConversationAggregate } from "./user-deletion";

export interface WorkspaceDeletionResult {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  conversationCount: number;
  fileCount: number;
  memberCount: number;
}

interface WorkspaceDeletion {
  collaborationWorkspaceId: CollaborationWorkspaceId;
  actor: AuditActor;
  correlationId: string;
}

/**
 * Accepts the deletion of a Shared Workspace. The caller has checked who asks and that no
 * Conversation of the workspace has background work in progress. From the mark on the
 * workspace is closed.
 */
export async function requestWorkspaceDeletion(
  options: ChatServerOptions,
  input: WorkspaceDeletion & { actorUserId: UserId }
): Promise<DeletionOutcome<WorkspaceDeletionResult>> {
  return acceptDeletion(options, {
    job: deleteWorkspaceJob,
    payload: {
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      actorUserId: input.actorUserId
    },
    subjectId: input.collaborationWorkspaceId,
    correlationId: input.correlationId,
    async mark(stores) {
      const marked = await stores.workspaces.markWorkspaceDeletionRequested({
        clientInstanceId: options.clientInstanceId,
        collaborationWorkspaceId: input.collaborationWorkspaceId
      });
      if (marked) {
        await stores.audit.appendAuditEvent({
          clientInstanceId: options.clientInstanceId,
          type: "collaboration_workspace.deletion_requested",
          status: "success",
          actor: input.actor,
          subject: input.collaborationWorkspaceId,
          correlationId: input.correlationId
        });
      }
      return marked;
    },
    complete: () =>
      completeWorkspaceDeletion(options, input, (fn) => options.stores.transaction(fn))
  });
}

/**
 * One pass of the deletion of a Shared Workspace whose deletion was requested: its
 * Conversations with their stored data, then its access requests, memberships and the
 * workspace itself. It throws while a Conversation still has background work in progress or
 * data of deleted Conversations is still being removed; the next pass goes on from there.
 * Resolves undefined when the workspace is gone, or was never marked.
 */
export async function completeWorkspaceDeletion(
  options: ChatServerOptions,
  input: WorkspaceDeletion,
  transaction: DeletionTransaction
): Promise<WorkspaceDeletionResult | undefined> {
  const { collaborationWorkspaceId } = input;
  const scope = { clientInstanceId: options.clientInstanceId, collaborationWorkspaceId };
  const inDeletion = await options.stores.workspaces.getWorkspaceInDeletion(scope);
  if (!inDeletion) return undefined;
  await retryWorkspaceCleanup(options, collaborationWorkspaceId);

  const conversations = await options.stores.conversations.listConversationsForWorkspace({
    ...scope,
    scope: { kind: "lifecycle" }
  });
  let conversationCount = 0;
  let fileCount = 0;
  for (const conversation of conversations) {
    const current = await options.stores.conversations.getConversation(
      options.clientInstanceId,
      conversation.id
    );
    // A Conversation that was moved away meanwhile is no longer this workspace's to delete.
    if (!current || current.collaborationWorkspaceId !== collaborationWorkspaceId) continue;
    await assertConversationIdle(options, conversation.id);
    const deletion = await deleteConversationAggregate(
      options,
      conversation.id,
      new Date().toISOString()
    );
    conversationCount += 1;
    if (deletion.cleanup === "complete") {
      fileCount += deletion.fileCount + deletion.artifactCount + deletion.workspaceFileCount;
    }
    await options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: input.actor,
      subject: conversation.id,
      correlationId: input.correlationId,
      metadata: { requestedBy: "workspace_deletion", ...deletion }
    });
  }

  const result = {
    collaborationWorkspaceId,
    conversationCount,
    fileCount,
    memberCount: inDeletion.memberships.length
  };
  return transaction(async (stores) => {
    // The store refuses while data of a deleted Conversation is still being removed.
    await stores.workspaces.deleteWorkspace(scope);
    await stores.audit.appendAuditEvent({
      clientInstanceId: options.clientInstanceId,
      type: "collaboration_workspace.deleted",
      status: "success",
      actor: input.actor,
      subject: collaborationWorkspaceId,
      correlationId: input.correlationId,
      // The counts are those of the pass that finished the deletion.
      metadata: {
        conversationCount: result.conversationCount,
        fileCount: result.fileCount,
        memberCount: result.memberCount
      }
    });
    await stores.jobs.withdraw(deleteWorkspaceJob, {
      clientInstanceId: options.clientInstanceId,
      dedupeKey: deletionDedupeKey(deleteWorkspaceJob, collaborationWorkspaceId)
    });
    return result;
  });
}

/**
 * Records that the job of a workspace deletion used up its attempts. The workspace stays
 * closed. Runs in the transaction that marks the job dead.
 */
export async function recordWorkspaceDeletionStalled(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  input: { collaborationWorkspaceId: CollaborationWorkspaceId; correlationId: string }
): Promise<void> {
  await stores.audit.appendAuditEvent({
    clientInstanceId: options.clientInstanceId,
    type: "collaboration_workspace.deletion_stalled",
    status: "failed",
    subject: input.collaborationWorkspaceId,
    correlationId: input.correlationId,
    metadata: {
      pendingCleanupCount: await countPendingCleanup(
        stores,
        options,
        input.collaborationWorkspaceId
      )
    }
  });
}
