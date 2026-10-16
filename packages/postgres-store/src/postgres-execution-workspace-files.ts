import {
  type ClientInstanceId,
  type DeleteWorkspaceFileInput,
  type ExecutionWorkspaceId,
  type UpsertWorkspaceFileInput,
  type WorkspaceFile
} from "@work-shape/catalyst-core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireActiveConversationLock } from "./postgres-conversation-operations";
import { type PostgresConnection } from "./postgres-database";
import { requireActiveWorkspace } from "./postgres-execution-workspace-metadata";
import {
  workspaceFileMetadataForUpsert,
  workspaceFileMetadataWithRetainedObjectKey
} from "./postgres-workspace-file-metadata";
import { mapWorkspaceFile } from "./rows";
import { executionWorkspaceFiles, executionWorkspaces } from "./schema";

export async function upsertWorkspaceFile(
  db: PostgresConnection,
  input: UpsertWorkspaceFileInput
): Promise<WorkspaceFile> {
  return db.transaction(async (tx) => {
    // The Conversation lock comes first, as in deletion and cleanup; the Workspace is read again
    // under it because cleanup may have marked it deleted while this write waited.
    const requested = await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId
    });
    await requireActiveConversationLock(tx, input.clientInstanceId, requested.conversationId);
    const workspace = await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId
    });
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
    const [existing] = await tx
      .select()
      .from(executionWorkspaceFiles)
      .where(
        and(
          eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
          eq(executionWorkspaceFiles.workspaceId, input.workspaceId),
          eq(executionWorkspaceFiles.path, input.path)
        )
      )
      .limit(1);
    const metadata = workspaceFileMetadataForUpsert(
      input.metadata ?? {},
      existing ? mapWorkspaceFile(existing) : undefined,
      input.objectKey
    );
    const [row] = await tx
      .insert(executionWorkspaceFiles)
      .values({
        workspaceId: input.workspaceId,
        clientInstanceId: input.clientInstanceId,
        conversationId: workspace.conversationId,
        path: input.path,
        objectKey: input.objectKey,
        byteSize: input.byteSize,
        checksum: input.checksum,
        mimeType: input.mimeType ?? null,
        metadata,
        lastCommandId: input.lastCommandId ?? null,
        deletedAt: null,
        createdAt: updatedAt,
        updatedAt
      })
      .onConflictDoUpdate({
        target: [executionWorkspaceFiles.workspaceId, executionWorkspaceFiles.path],
        set: {
          objectKey: input.objectKey,
          byteSize: input.byteSize,
          checksum: input.checksum,
          mimeType: input.mimeType ?? null,
          metadata,
          lastCommandId: input.lastCommandId ?? null,
          deletedAt: null,
          updatedAt
        }
      })
      .returning();

    await tx
      .update(executionWorkspaces)
      .set({ updatedAt })
      .where(eq(executionWorkspaces.id, input.workspaceId));
    return mapWorkspaceFile(row);
  });
}

export async function deleteWorkspaceFile(
  db: PostgresConnection,
  input: DeleteWorkspaceFileInput
): Promise<WorkspaceFile | undefined> {
  return db.transaction(async (tx) => {
    await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId
    });
    const deletedAt = input.deletedAt ? new Date(input.deletedAt) : new Date();
    const [existing] = await tx
      .select()
      .from(executionWorkspaceFiles)
      .where(
        and(
          eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
          eq(executionWorkspaceFiles.workspaceId, input.workspaceId),
          eq(executionWorkspaceFiles.path, input.path),
          isNull(executionWorkspaceFiles.deletedAt)
        )
      )
      .limit(1);
    if (!existing) {
      return undefined;
    }
    const existingFile = mapWorkspaceFile(existing);
    const [row] = await tx
      .update(executionWorkspaceFiles)
      .set({
        metadata: workspaceFileMetadataWithRetainedObjectKey(
          existingFile.metadata,
          existingFile.objectKey
        ),
        lastCommandId: input.lastCommandId ?? existingFile.lastCommandId ?? null,
        deletedAt,
        updatedAt: deletedAt
      })
      .where(
        and(
          eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
          eq(executionWorkspaceFiles.workspaceId, input.workspaceId),
          eq(executionWorkspaceFiles.path, input.path),
          isNull(executionWorkspaceFiles.deletedAt)
        )
      )
      .returning();
    if (!row) {
      return undefined;
    }
    await tx
      .update(executionWorkspaces)
      .set({ updatedAt: deletedAt })
      .where(eq(executionWorkspaces.id, input.workspaceId));
    return mapWorkspaceFile(row);
  });
}

export async function listWorkspaceFiles(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<WorkspaceFile[]> {
  const rows = await db
    .select()
    .from(executionWorkspaceFiles)
    .where(
      and(
        eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaceFiles.workspaceId, input.workspaceId),
        isNull(executionWorkspaceFiles.deletedAt)
      )
    )
    .orderBy(asc(executionWorkspaceFiles.path));
  return rows.map(mapWorkspaceFile);
}

/** Served by the primary key of the table, (workspace_id, path): one row is read. */
export async function getWorkspaceFile(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
    path: string;
  }
): Promise<WorkspaceFile | undefined> {
  const [row] = await db
    .select()
    .from(executionWorkspaceFiles)
    .where(
      and(
        eq(executionWorkspaceFiles.workspaceId, input.workspaceId),
        eq(executionWorkspaceFiles.path, input.path),
        eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
        isNull(executionWorkspaceFiles.deletedAt)
      )
    )
    .limit(1);
  return row ? mapWorkspaceFile(row) : undefined;
}
