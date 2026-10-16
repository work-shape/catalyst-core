import {
  asConversationId,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type ConversationId,
  type ManagedObjectDeletionResult,
  type UserId
} from "@work-shape/catalyst-core";
import { and, sql as drizzleSql, eq, inArray, ne } from "drizzle-orm";
import { type PostgresFileStoreDatabase } from "./postgres-file-store";
import { type PostgresConnection } from "./postgres-file-store-types";
import { conversationsPendingCleanup } from "./postgres-pending-cleanup";
import {
  artifactPreviewJobs,
  artifactPreviewManifests,
  conversationAttachments,
  conversations,
  managedArtifacts,
  managedFiles
} from "./schema";

async function collectConversationManagedObjectsForDeletion(
  db: PostgresFileStoreDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<{
  attachments: Array<typeof conversationAttachments.$inferSelect>;
  files: Array<typeof managedFiles.$inferSelect>;
  artifacts: Array<typeof managedArtifacts.$inferSelect>;
}> {
  const attachments = await db
    .select()
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId)
      )
    );
  const fileIds = [...new Set(attachments.map((attachment) => attachment.fileId))];
  const artifacts = await db
    .select()
    .from(managedArtifacts)
    .where(
      and(
        eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
        eq(managedArtifacts.conversationId, input.conversationId),
        ne(managedArtifacts.status, "deleted")
      )
    );

  let files: Array<typeof managedFiles.$inferSelect> = [];
  if (fileIds.length > 0) {
    const sharedAttachmentRows = await db
      .select({ fileId: conversationAttachments.fileId })
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          inArray(conversationAttachments.fileId, fileIds),
          ne(conversationAttachments.conversationId, input.conversationId),
          ne(conversationAttachments.status, "deleted")
        )
      );
    const sharedFileIds = new Set(sharedAttachmentRows.map((attachment) => attachment.fileId));
    const deletableFileIds = fileIds.filter((fileId) => !sharedFileIds.has(fileId));
    if (deletableFileIds.length > 0) {
      files = await db
        .select()
        .from(managedFiles)
        .where(
          and(
            eq(managedFiles.clientInstanceId, input.clientInstanceId),
            inArray(managedFiles.id, deletableFileIds),
            ne(managedFiles.status, "deleted")
          )
        );
    }
  }

  return { attachments, files, artifacts };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export async function markConversationManagedObjectsDeleted(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }
): Promise<ManagedObjectDeletionResult> {
  const deletedAt = new Date(input.deletedAt);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      )
      .for("update")
      .limit(1);
    const deletion = await collectConversationManagedObjectsForDeletion(tx, input);
    const fileIds = deletion.files.map((file) => file.id);

    await tx
      .update(conversationAttachments)
      .set({
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt
      })
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          ne(conversationAttachments.status, "deleted")
        )
      );
    if (fileIds.length > 0) {
      await tx
        .update(managedFiles)
        .set({
          status: "deleted",
          deletedAt
        })
        .where(
          and(
            eq(managedFiles.clientInstanceId, input.clientInstanceId),
            inArray(managedFiles.id, fileIds)
          )
        );
    }
    await tx
      .delete(artifactPreviewJobs)
      .where(
        and(
          eq(artifactPreviewJobs.clientInstanceId, input.clientInstanceId),
          eq(artifactPreviewJobs.conversationId, input.conversationId)
        )
      );
    await tx
      .delete(artifactPreviewManifests)
      .where(
        and(
          eq(artifactPreviewManifests.clientInstanceId, input.clientInstanceId),
          eq(artifactPreviewManifests.conversationId, input.conversationId)
        )
      );
    await tx
      .update(managedArtifacts)
      .set({
        status: "deleted",
        deletedAt
      })
      .where(
        and(
          eq(managedArtifacts.clientInstanceId, input.clientInstanceId),
          eq(managedArtifacts.conversationId, input.conversationId),
          ne(managedArtifacts.status, "deleted")
        )
      );

    return {
      attachmentCount: deletion.attachments.length,
      fileObjectKeys: uniqueStrings(deletion.files.map((file) => file.objectKey)),
      artifactObjectKeys: uniqueStrings(deletion.artifacts.map((artifact) => artifact.objectKey))
    };
  });
}

export async function listConversationManagedObjectsForDeletion(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ManagedObjectDeletionResult> {
  const deletion = await collectConversationManagedObjectsForDeletion(db, input);
  return {
    attachmentCount: deletion.attachments.length,
    fileObjectKeys: uniqueStrings(deletion.files.map((file) => file.objectKey)),
    artifactObjectKeys: uniqueStrings(deletion.artifacts.map((artifact) => artifact.objectKey))
  };
}

export async function listConversationsPendingObjectCleanup(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    createdByUserId?: UserId;
    limit: number;
  }
): Promise<ConversationId[]> {
  if (input.limit <= 0) {
    return [];
  }
  const rows = await db
    .select({ id: drizzleSql<string>`pending.id` })
    .from(
      drizzleSql`(${conversationsPendingCleanup({
        clientInstanceId: input.clientInstanceId,
        collaborationWorkspaceId: input.collaborationWorkspaceId,
        createdByUserId: input.createdByUserId,
        executionWorkspaces:
          input.collaborationWorkspaceId !== undefined || input.createdByUserId !== undefined
      })}) pending`
    )
    .orderBy(drizzleSql`pending.deleted_at asc`, drizzleSql`pending.id asc`)
    .limit(input.limit);
  return rows.map((row) => asConversationId(row.id));
}
