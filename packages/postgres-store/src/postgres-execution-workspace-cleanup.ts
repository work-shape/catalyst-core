import {
  type ClientInstanceId,
  type ConversationId,
  type ExecutionWorkspaceCleanupTarget,
  type ExecutionWorkspaceDeletionSummary,
  type ListExecutionWorkspaceCleanupTargetsInput,
  type ListExecutionWorkspaceObjectsForDeletionInput,
  type MarkExecutionWorkspaceDeletedInput
} from "@work-shape/catalyst-core";
import { and, sql as drizzleSql, eq } from "drizzle-orm";
import { type PostgresConnection } from "./postgres-database";
import { retainedObjectKeys, uniqueStrings } from "./postgres-workspace-file-metadata";
import { executionWorkspaceFiles, executionWorkspaces } from "./schema";

export async function listExecutionWorkspaceCleanupTargets(
  db: PostgresConnection,
  input: ListExecutionWorkspaceCleanupTargetsInput
): Promise<ExecutionWorkspaceCleanupTarget[]> {
  if (input.limit <= 0) {
    return [];
  }
  const rows = (await db.execute(drizzleSql<{ workspace_id: string; conversation_id: string }>`
    select ew.id as workspace_id, ew.conversation_id
    from execution_workspaces ew
    join conversations c
      on c.id = ew.conversation_id
     and c.client_instance_id = ew.client_instance_id
    where ew.client_instance_id = ${input.clientInstanceId}
      and c.status <> 'active'
      and (
        ew.status <> 'deleted'
        or exists (
          select 1
          from execution_workspace_files ewf
          where ewf.workspace_id = ew.id
            and ewf.client_instance_id = ew.client_instance_id
        )
        or exists (
          select 1
          from workspace_commands wc
          where wc.workspace_id = ew.id
            and wc.client_instance_id = ew.client_instance_id
        )
      )
    order by ew.updated_at asc, ew.id asc
    limit ${input.limit}
  `)) as unknown as Array<{ workspace_id: string; conversation_id: string }>;
  return rows.map((row) => ({
    workspaceId: row.workspace_id as ExecutionWorkspaceCleanupTarget["workspaceId"],
    conversationId: row.conversation_id as ExecutionWorkspaceCleanupTarget["conversationId"]
  }));
}

export async function listExecutionWorkspaceObjectsForDeletion(
  db: PostgresConnection,
  input: ListExecutionWorkspaceObjectsForDeletionInput
): Promise<ExecutionWorkspaceDeletionSummary> {
  return collectExecutionWorkspaceDeletionSummary(db, input);
}

export async function markExecutionWorkspaceDeleted(
  db: PostgresConnection,
  input: MarkExecutionWorkspaceDeletedInput
): Promise<ExecutionWorkspaceDeletionSummary> {
  const deletedAt = new Date(input.deletedAt);
  return db.transaction(async (tx) => {
    const summary = await collectExecutionWorkspaceDeletionSummary(tx, input);
    await tx.execute(drizzleSql`
      update workspace_commands
      set status = 'cancelled',
          cancellation_reason = coalesce(cancellation_reason, 'Conversation workspace was cleaned up'),
          cancellation_requested_at = coalesce(cancellation_requested_at, ${input.deletedAt}::timestamptz),
          lease_owner = null,
          lease_token = null,
          lease_expires_at = null,
          heartbeat_at = null,
          completed_at = ${input.deletedAt}::timestamptz,
          updated_at = ${input.deletedAt}::timestamptz
      where client_instance_id = ${input.clientInstanceId}
        and conversation_id = ${input.conversationId}
        and status = 'queued'
    `);
    await tx
      .delete(executionWorkspaceFiles)
      .where(
        and(
          eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
          eq(executionWorkspaceFiles.conversationId, input.conversationId)
        )
      );
    await tx.execute(drizzleSql`
      delete from workspace_commands
      where client_instance_id = ${input.clientInstanceId}
        and conversation_id = ${input.conversationId}
        and status in ('completed', 'failed', 'cancelled')
        and (completed_at is null or completed_at < ${input.deletedAt}::timestamptz)
    `);
    await tx
      .update(executionWorkspaces)
      .set({
        status: "deleted",
        deletedAt,
        updatedAt: deletedAt
      })
      .where(
        and(
          eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(executionWorkspaces.conversationId, input.conversationId)
        )
      );
    return summary;
  });
}

async function collectExecutionWorkspaceDeletionSummary(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ExecutionWorkspaceDeletionSummary> {
  const workspaceRows = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.conversationId, input.conversationId)
      )
    );
  const fileRows = await db
    .select({
      objectKey: executionWorkspaceFiles.objectKey,
      metadata: executionWorkspaceFiles.metadata
    })
    .from(executionWorkspaceFiles)
    .where(
      and(
        eq(executionWorkspaceFiles.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaceFiles.conversationId, input.conversationId)
      )
    );
  const commandRows = (await db.execute(drizzleSql<{ count: number }>`
    select count(*)::int as count
    from workspace_commands
    where client_instance_id = ${input.clientInstanceId}
      and conversation_id = ${input.conversationId}
  `)) as unknown as Array<{ count: number | string }>;

  return {
    workspaceCount: workspaceRows.length,
    fileCount: fileRows.length,
    commandCount: Number(commandRows[0]?.count ?? 0),
    fileObjectKeys: uniqueStrings(
      fileRows.flatMap((file) => [file.objectKey, ...retainedObjectKeys(file.metadata)])
    )
  };
}
