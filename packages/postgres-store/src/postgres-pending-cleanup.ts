import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  pendingConversationCleanupError,
  type ClientInstanceId,
  type CollaborationWorkspace,
  type CollaborationWorkspaceId
} from "@vivd-catalyst/core";
import type { PostgresTransaction } from "./postgres-database";

/**
 * The Conversations that are deleted or expired and still have data to remove, as rows of
 * `id` and `deleted_at`. This is the one definition of "cleanup pending": the retry of the
 * retention job lists from it, and the functions that remove Conversation rows for good refuse
 * while it returns any.
 *
 * One branch per kind of leftover, each starting from the rows that are left, so the planner
 * can join instead of probing every Conversation that was ever deleted. The file branch follows
 * the sharing rule of the deletion collector: a file with a live attachment in another
 * Conversation is not this Conversation's to remove.
 *
 * Execution workspace data is cleaned by its own job, so the retry list leaves it out. A
 * caller that is about to remove the rows asks for it with `executionWorkspaces`, because the
 * workspace rows are what leads that job to the stored objects.
 */
export function conversationsPendingCleanup(input: {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId?: CollaborationWorkspaceId;
  executionWorkspaces?: boolean;
}): SQL {
  const notActive = input.collaborationWorkspaceId
    ? drizzleSql`c.status <> 'active' and c.collaboration_workspace_id = ${input.collaborationWorkspaceId}`
    : drizzleSql`c.status <> 'active'`;
  // The condition of `listExecutionWorkspaceCleanupTargets` without its command rows: a command
  // row holds no object key, and its cleanup keeps a cancelled command for one more pass.
  const executionWorkspaces = input.executionWorkspaces
    ? drizzleSql`
      union
      select c.id, c.deleted_at
      from execution_workspaces ew
      join conversations c
        on c.id = ew.conversation_id
       and c.client_instance_id = ew.client_instance_id
      where ew.client_instance_id = ${input.clientInstanceId}
        and ${notActive}
        and (
          ew.status <> 'deleted'
          or exists (
            select 1
            from execution_workspace_files ewf
            where ewf.workspace_id = ew.id
              and ewf.client_instance_id = ew.client_instance_id
          )
        )`
    : drizzleSql``;
  return drizzleSql`
    select c.id, c.deleted_at
    from managed_artifacts ma
    join conversations c
      on c.id = ma.conversation_id
     and c.client_instance_id = ma.client_instance_id
    where ma.client_instance_id = ${input.clientInstanceId}
      and ma.status <> 'deleted'
      and ${notActive}
    union
    select c.id, c.deleted_at
    from artifact_preview_jobs apj
    join conversations c
      on c.id = apj.conversation_id
     and c.client_instance_id = apj.client_instance_id
    where apj.client_instance_id = ${input.clientInstanceId}
      and ${notActive}
    union
    select c.id, c.deleted_at
    from artifact_preview_manifests apm
    join conversations c
      on c.id = apm.conversation_id
     and c.client_instance_id = apm.client_instance_id
    where apm.client_instance_id = ${input.clientInstanceId}
      and ${notActive}
    union
    select c.id, c.deleted_at
    from managed_files mf
    join conversation_attachments ca
      on ca.file_id = mf.id
     and ca.client_instance_id = mf.client_instance_id
    join conversations c
      on c.id = ca.conversation_id
     and c.client_instance_id = ca.client_instance_id
    where mf.client_instance_id = ${input.clientInstanceId}
      and mf.status <> 'deleted'
      and ${notActive}
      and not exists (
        select 1
        from conversation_attachments shared
        where shared.client_instance_id = ca.client_instance_id
          and shared.file_id = ca.file_id
          and shared.conversation_id <> ca.conversation_id
          and shared.status <> 'deleted'
      )
    ${executionWorkspaces}
  `;
}

/**
 * Refuses to go on while a Conversation of the workspace still has data to remove. Removing
 * its row now would take the records that lead to that data with it. Call it in the
 * transaction that removes the rows.
 */
export async function requireNoPendingConversationCleanup(
  tx: PostgresTransaction,
  workspace: Pick<CollaborationWorkspace, "clientInstanceId" | "id" | "kind">
): Promise<void> {
  const [row] = await tx.select({ count: drizzleSql<number>`count(*)::int` }).from(
    drizzleSql`(${conversationsPendingCleanup({
      clientInstanceId: workspace.clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      executionWorkspaces: true
    })}) pending`
  );
  const pendingCleanupCount = row?.count ?? 0;
  if (pendingCleanupCount > 0) {
    throw pendingConversationCleanupError(workspace.kind, pendingCleanupCount);
  }
}
