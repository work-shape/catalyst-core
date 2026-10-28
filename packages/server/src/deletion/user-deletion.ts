import {
  AppError,
  isAppError,
  type AuditActor,
  type CollaborationWorkspaceId,
  type ConversationId,
  type PlatformStores,
  type UserId
} from "@work-shape/catalyst-core";
import {
  attemptConversationDataCleanup,
  type ConversationDataCleanupOutcome,
  type ConversationDataDeletionTotals
} from "./conversation-cleanup";
import type { ChatServerOptions } from "../types";
import { removeFeedbackOfAuthor } from "../feedback/feedback-jobs";
import {
  deletePrivateProjectsOfUser,
  deleteWorkspaceProjectObjects
} from "../projects/project-cleanup";

export interface UserDeletionTotals extends ConversationDataDeletionTotals {
  conversationCount: number;
  accessRequestCount: number;
  sharedMembershipCount: number;
  /** Private projects of the user, with their files (PRJ-2). */
  projectCount: number;
}

/**
 * Refuses while the user is the last active owner of a Shared Workspace: deleting the account
 * would leave that workspace to nobody. An owner whose own account is being deleted does not
 * count as active. It runs in the transaction that marks the user and locks the workspaces the
 * user owns first, so of two owners who ask at the same moment the second sees the first one's
 * mark. It is not checked again afterwards: an accepted deletion finishes.
 */
export async function requireNoSoleOwnedSharedWorkspace(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  userId: UserId
): Promise<void> {
  await stores.workspaces.lockWorkspacesForOwnerChange({
    clientInstanceId: options.clientInstanceId,
    ownedByUserId: userId
  });
  const workspaces = await stores.workspaces.listWorkspacesForUser({
    clientInstanceId: options.clientInstanceId,
    userId
  });
  const users = await stores.users.listUsers({
    clientInstanceId: options.clientInstanceId
  });
  const activeUserIds = new Set(
    users.filter((user) => user.status === "active").map((user) => user.id)
  );
  let blockingWorkspaceCount = 0;
  for (const workspace of workspaces) {
    if (workspace.kind !== "shared" || workspace.role !== "owner") continue;
    const memberships = await stores.workspaces.listMemberships({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    const hasAnotherActiveOwner = memberships.some(
      (membership) =>
        membership.role === "owner" &&
        membership.userId !== userId &&
        activeUserIds.has(membership.userId)
    );
    if (!hasAnotherActiveOwner) blockingWorkspaceCount += 1;
  }
  if (blockingWorkspaceCount > 0) {
    throw new AppError(
      "CONFLICT",
      `User is the last active owner of ${blockingWorkspaceCount} Shared Workspace${blockingWorkspaceCount === 1 ? "" : "s"}`,
      { blockingWorkspaceCount }
    );
  }
}

/**
 * Removes what belongs to the user alone: first their access requests and their memberships
 * of Shared Workspaces, then the Conversations of their Personal Workspace and their private
 * Conversations elsewhere, with stored data, then the Personal Workspace. Safe to repeat: a
 * pass that is refused because data is still being removed leaves the rest for the next.
 */
export async function cleanupProductUserData(input: {
  options: ChatServerOptions;
  actor: AuditActor;
  correlationId: string;
  userId: UserId;
}): Promise<UserDeletionTotals> {
  const { options } = input;
  const workspaces = await options.stores.workspaces.listWorkspacesForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  const personalWorkspace = workspaces.find(
    (workspace) => workspace.kind === "personal" && workspace.personalUserId === input.userId
  );

  // Private conversations in Shared Workspaces are readable only by their creator, so they
  // are part of the user's own data rather than a shared resource that outlives the account.
  const conversations = [
    ...(personalWorkspace
      ? await options.stores.conversations.listConversationsForWorkspace({
          clientInstanceId: options.clientInstanceId,
          collaborationWorkspaceId: personalWorkspace.id,
          scope: { kind: "lifecycle" }
        })
      : []),
    ...(
      await options.stores.conversations.listPrivateConversationsCreatedByUser({
        clientInstanceId: options.clientInstanceId,
        userId: input.userId
      })
    ).filter((conversation) => conversation.collaborationWorkspaceId !== personalWorkspace?.id)
  ];
  const totals: UserDeletionTotals = {
    conversationCount: 0,
    attachmentCount: 0,
    fileCount: 0,
    artifactCount: 0,
    workspaceCount: 0,
    workspaceFileCount: 0,
    workspaceCommandCount: 0,
    workspaceObjectCount: 0,
    accessRequestCount: 0,
    sharedMembershipCount: 0,
    projectCount: 0
  };

  // First what shows the person to others: while stored data is still being removed, a closed
  // account is no longer a listed member of a Shared Workspace and asks for no access. The
  // last-owner rule was settled when the deletion was accepted.
  totals.accessRequestCount = await options.stores.workspaces.deleteAccessRequestsForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  totals.sharedMembershipCount = await options.stores.workspaces.removeMembershipsForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });

  for (const conversation of conversations) {
    const deletedAt = new Date().toISOString();
    // A Try conversation listed after its Build conversation went with it.
    const deletion = await deleteConversationAggregate(options, conversation.id, deletedAt).catch(
      (error: unknown) => {
        if (isAppError(error) && error.code === "NOT_FOUND") return undefined;
        throw error;
      }
    );
    if (!deletion) continue;
    totals.conversationCount += 1;
    // A cleanup that is still pending is retried by the next pass and by the retention job.
    if (deletion.cleanup === "complete") {
      totals.attachmentCount += deletion.attachmentCount;
      totals.fileCount += deletion.fileCount;
      totals.artifactCount += deletion.artifactCount;
      totals.workspaceCount += deletion.workspaceCount;
      totals.workspaceFileCount += deletion.workspaceFileCount;
      totals.workspaceCommandCount += deletion.workspaceCommandCount;
      totals.workspaceObjectCount += deletion.workspaceObjectCount;
    }

    await options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: input.actor,
      subject: conversation.id,
      correlationId: input.correlationId,
      metadata: {
        requestedBy: "account_deletion",
        ...deletion
      }
    });
  }

  // The comments the person left on answers go with them, with their Inbox items (LU-4).
  await removeFeedbackOfAuthor(options, input.userId);

  // The user's private projects go with their files, also those in Shared Workspaces; chats
  // of the workspace that still name one leave it first (PRJ-2).
  totals.projectCount = await deletePrivateProjectsOfUser(options, input.userId);

  // The store refuses this while a cleanup is pending. The next pass goes on from here.
  if (personalWorkspace) {
    // The rows of the personal workspace's projects go with it; their bytes go first.
    await deleteWorkspaceProjectObjects(options, personalWorkspace.id);
    await options.stores.workspaces.deletePersonalWorkspaceForUser({
      clientInstanceId: options.clientInstanceId,
      userId: input.userId
    });
  }

  return totals;
}

/**
 * Deletes the Conversation, then cleans up its data. The deletion stands when the cleanup fails:
 * the outcome says `pending` and the retention job retries it.
 */
export async function deleteConversationAggregate(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string,
  inCollaborationWorkspaceId?: CollaborationWorkspaceId
): Promise<ConversationDataCleanupOutcome> {
  await options.stores.conversations.deleteConversation({
    clientInstanceId: options.clientInstanceId,
    conversationId,
    deletedAt,
    inCollaborationWorkspaceId
  });
  return attemptConversationDataCleanup(options, conversationId, deletedAt);
}
