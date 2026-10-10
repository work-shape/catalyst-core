import { and, asc, eq, inArray, isNotNull, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type CollaborationWorkspace,
  type CollaborationWorkspaceStore,
  type WorkspaceInDeletion
} from "@vivd-catalyst/core";
import {
  lockWorkspaceForHardDelete,
  notInDeletion,
  workspaceRowWhere
} from "./postgres-collaboration-workspace-operations";
import type { PostgresConnection } from "./postgres-database";
import { requireNoPendingConversationCleanup } from "./postgres-pending-cleanup";
import { mapCollaborationWorkspace, mapWorkspaceMembership } from "./rows";
import {
  collaborationWorkspaceAccessRequests,
  collaborationWorkspaceMemberships,
  collaborationWorkspaces,
  conversations
} from "./schema";

export async function markWorkspaceDeletionRequested(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["markWorkspaceDeletionRequested"]>[0]
): Promise<boolean> {
  const workspace = workspaceRowWhere(input);
  const marked = await db
    .update(collaborationWorkspaces)
    .set({ deletionRequestedAt: drizzleSql`now()` })
    .where(and(workspace, eq(collaborationWorkspaces.kind, "shared"), notInDeletion))
    .returning({ id: collaborationWorkspaces.id });
  if (marked.length > 0) return true;
  const [existing] = await db
    .select({ kind: collaborationWorkspaces.kind })
    .from(collaborationWorkspaces)
    .where(workspace)
    .limit(1);
  if (!existing) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
  if (existing.kind === "personal") {
    throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be deleted");
  }
  return false;
}

export async function lockOwnedSharedWorkspaces(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["lockOwnedSharedWorkspaces"]>[0]
): Promise<void> {
  const owned = db
    .select({ id: collaborationWorkspaceMemberships.collaborationWorkspaceId })
    .from(collaborationWorkspaceMemberships)
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaceMemberships.userId, input.userId),
        eq(collaborationWorkspaceMemberships.role, "owner")
      )
    );
  // In the order of the ids, so two transactions never wait for each other.
  await db
    .select({ id: collaborationWorkspaces.id })
    .from(collaborationWorkspaces)
    .where(
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.kind, "shared"),
        inArray(collaborationWorkspaces.id, owned)
      )
    )
    .orderBy(asc(collaborationWorkspaces.id))
    .for("update");
}

export async function getWorkspaceInDeletion(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["getWorkspaceInDeletion"]>[0]
): Promise<WorkspaceInDeletion | undefined> {
  const [row] = await db
    .select()
    .from(collaborationWorkspaces)
    .where(and(workspaceRowWhere(input), isNotNull(collaborationWorkspaces.deletionRequestedAt)))
    .limit(1);
  if (!row) return undefined;
  const memberships = await db
    .select()
    .from(collaborationWorkspaceMemberships)
    .where(
      and(
        eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
        eq(
          collaborationWorkspaceMemberships.collaborationWorkspaceId,
          input.collaborationWorkspaceId
        )
      )
    )
    .orderBy(asc(collaborationWorkspaceMemberships.createdAt));
  return {
    workspace: mapCollaborationWorkspace(row),
    memberships: memberships.map(mapWorkspaceMembership)
  };
}

export async function deleteWorkspace(
  db: PostgresConnection,
  input: Parameters<CollaborationWorkspaceStore["deleteWorkspace"]>[0]
): Promise<CollaborationWorkspace> {
  return db.transaction(async (tx) => {
    await lockWorkspaceForHardDelete(
      tx,
      and(
        eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
      )
    );
    // The one read that also finds a workspace whose deletion was requested.
    const [locked] = await tx
      .select()
      .from(collaborationWorkspaces)
      .where(workspaceRowWhere(input))
      .limit(1);
    if (!locked) throw new AppError("NOT_FOUND", "Collaboration Workspace is not available");
    const workspace = mapCollaborationWorkspace(locked);
    if (workspace.kind === "personal") {
      throw new AppError("VALIDATION_FAILED", "A Personal Workspace cannot be deleted");
    }
    const [activeConversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId),
          eq(conversations.status, "active")
        )
      )
      .limit(1);
    if (activeConversation) {
      throw new AppError("CONFLICT", "Workspace still contains conversations");
    }
    await requireNoPendingConversationCleanup(tx, workspace);
    await tx
      .delete(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId)
        )
      );
    await tx
      .delete(collaborationWorkspaceAccessRequests)
      .where(
        and(
          eq(collaborationWorkspaceAccessRequests.clientInstanceId, input.clientInstanceId),
          eq(
            collaborationWorkspaceAccessRequests.collaborationWorkspaceId,
            input.collaborationWorkspaceId
          )
        )
      );
    await tx
      .delete(collaborationWorkspaceMemberships)
      .where(
        and(
          eq(collaborationWorkspaceMemberships.clientInstanceId, input.clientInstanceId),
          eq(
            collaborationWorkspaceMemberships.collaborationWorkspaceId,
            input.collaborationWorkspaceId
          )
        )
      );
    const [row] = await tx
      .delete(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(collaborationWorkspaces.id, input.collaborationWorkspaceId)
        )
      )
      .returning();
    return mapCollaborationWorkspace(row);
  });
}
