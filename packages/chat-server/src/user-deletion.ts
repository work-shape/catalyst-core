import {
  AppError,
  auditActorFromUser,
  type AuthenticatedUser,
  type ConversationId,
  type RuntimeCallContext,
  type UserId
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import {
  cleanupExecutionWorkspaceForConversation,
  executionWorkspaceCleanupAuditMetadata
} from "./workspace-cleanup";

export interface UserDeletionTotals {
  conversationCount: number;
  attachmentCount: number;
  fileCount: number;
  artifactCount: number;
  workspaceCount: number;
  workspaceFileCount: number;
  workspaceCommandCount: number;
  workspaceObjectCount: number;
  accessRequestCount: number;
  sharedMembershipCount: number;
}

export type ConversationDataDeletionTotals = Omit<
  UserDeletionTotals,
  "conversationCount" | "accessRequestCount" | "sharedMembershipCount"
>;

export async function cleanupProductUserData(input: {
  options: ChatServerOptions;
  actor: AuthenticatedUser;
  context: RuntimeCallContext;
  userId: UserId;
}): Promise<UserDeletionTotals> {
  const { options } = input;
  const workspaces = await options.userStore.listWorkspacesForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  const personalWorkspace = workspaces.find(
    (workspace) => workspace.kind === "personal" && workspace.personalUserId === input.userId
  );
  if (!personalWorkspace) {
    throw new AppError("INTERNAL", "User has no Personal Workspace");
  }

  const users = await options.userStore.listUsers({
    clientInstanceId: options.clientInstanceId
  });
  const activeUserIds = new Set(
    users.filter((user) => user.status === "active").map((user) => user.id)
  );
  let blockingWorkspaceCount = 0;
  for (const workspace of workspaces) {
    if (workspace.kind !== "shared" || workspace.role !== "owner") continue;
    const memberships = await options.userStore.listMemberships({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    const hasAnotherActiveOwner = memberships.some(
      (membership) =>
        membership.role === "owner" &&
        membership.userId !== input.userId &&
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

  const conversations = await options.conversationStore.listConversationsForWorkspace({
    clientInstanceId: options.clientInstanceId,
    collaborationWorkspaceId: personalWorkspace.id
  });
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
    sharedMembershipCount: 0
  };

  for (const conversation of conversations) {
    const deletedAt = new Date().toISOString();
    const deletion = await deleteConversationAggregate(options, conversation.id, deletedAt);
    totals.conversationCount += 1;
    totals.attachmentCount += deletion.attachmentCount;
    totals.fileCount += deletion.fileCount;
    totals.artifactCount += deletion.artifactCount;
    totals.workspaceCount += deletion.workspaceCount;
    totals.workspaceFileCount += deletion.workspaceFileCount;
    totals.workspaceCommandCount += deletion.workspaceCommandCount;
    totals.workspaceObjectCount += deletion.workspaceObjectCount;

    await options.auditRecorder.record({
      type: "conversation.deleted",
      status: "success",
      actor: auditActorFromUser(input.actor),
      subject: conversation.id,
      correlationId: input.context.correlationId,
      metadata: {
        requestedBy: "account_deletion",
        ...deletion
      }
    });
  }

  totals.accessRequestCount = await options.userStore.deleteAccessRequestsForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  totals.sharedMembershipCount = await options.userStore.removeMembershipsForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  await options.userStore.deletePersonalWorkspaceForUser({
    clientInstanceId: options.clientInstanceId,
    userId: input.userId
  });
  return totals;
}

export async function deleteConversationAggregate(
  options: ChatServerOptions,
  conversationId: ConversationId,
  deletedAt: string
): Promise<ConversationDataDeletionTotals> {
  const attachmentDeletion = options.attachments
    ? await options.attachments.deleteConversationAttachments({ conversationId, deletedAt })
    : undefined;
  const executionWorkspaceDeletion = await cleanupExecutionWorkspaceForConversation(options, {
    conversationId,
    deletedAt
  });
  await options.conversationStore.deleteConversation({
    clientInstanceId: options.clientInstanceId,
    conversationId,
    deletedAt
  });
  const workspaceMetadata = executionWorkspaceCleanupAuditMetadata(executionWorkspaceDeletion);
  return {
    attachmentCount: attachmentDeletion?.attachmentCount ?? 0,
    fileCount: attachmentDeletion?.fileObjectKeys.length ?? 0,
    artifactCount: attachmentDeletion?.artifactObjectKeys.length ?? 0,
    workspaceCount: Number(workspaceMetadata.workspaceCount ?? 0),
    workspaceFileCount: Number(workspaceMetadata.workspaceFileCount ?? 0),
    workspaceCommandCount: Number(workspaceMetadata.workspaceCommandCount ?? 0),
    workspaceObjectCount: Number(workspaceMetadata.workspaceObjectCount ?? 0)
  };
}
