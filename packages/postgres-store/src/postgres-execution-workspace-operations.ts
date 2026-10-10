import { and, asc, eq, inArray, isNull, ne, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type ActiveWorkspaceCommandCounts,
  type CancelClaimedWorkspaceCommandInput,
  type ClaimWorkspaceCommandInput,
  type ClientInstanceId,
  type CompleteWorkspaceCommandInput,
  type CountActiveWorkspaceCommandsInput,
  type ConversationId,
  type DeleteWorkspaceFileInput,
  type EnqueueWorkspaceCommandInput,
  type EnsureExecutionWorkspaceInput,
  type ExecutionWorkspace,
  type ExecutionWorkspaceId,
  type FailWorkspaceCommandInput,
  type ExecutionWorkspaceCleanupTarget,
  type ExecutionWorkspaceDeletionSummary,
  type ListExecutionWorkspaceCleanupTargetsInput,
  type ListExecutionWorkspaceObjectsForDeletionInput,
  type MarkExecutionWorkspaceDeletedInput,
  type RenewClaimedWorkspaceCommandLeaseInput,
  type RequestWorkspaceCommandCancellationInput,
  type SubjectRowClaim,
  type UpsertWorkspaceFileInput,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceFile,
  asExecutionWorkspaceId,
  asWorkspaceCommandId,
  createPlatformId
} from "@vivd-catalyst/core";
import { requireActiveConversationLock } from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapExecutionWorkspace, mapWorkspaceCommand, mapWorkspaceFile } from "./rows";
import {
  conversations,
  executionWorkspaceFiles,
  executionWorkspaces,
  workspaceCommands
} from "./schema";

export async function ensureExecutionWorkspace(
  db: PostgresConnection,
  input: EnsureExecutionWorkspaceInput
): Promise<ExecutionWorkspace> {
  const now = input.now ? new Date(input.now) : new Date();
  await requireActiveConversation(db, {
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId
  });

  const [inserted] = await db
    .insert(executionWorkspaces)
    .values({
      id: createPlatformId<"ExecutionWorkspaceId">("ews"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      status: "active",
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return mapExecutionWorkspace(inserted);
  }

  const [existing] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.conversationId, input.conversationId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  if (!existing) {
    throw new AppError("NOT_FOUND", "Execution workspace is not available");
  }
  return mapExecutionWorkspace(existing);
}

export async function getExecutionWorkspace(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<ExecutionWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.id, input.workspaceId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  return row ? mapExecutionWorkspace(row) : undefined;
}

export async function getExecutionWorkspaceForConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ExecutionWorkspace | undefined> {
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
        eq(executionWorkspaces.conversationId, input.conversationId),
        ne(executionWorkspaces.status, "deleted")
      )
    )
    .limit(1);
  return row ? mapExecutionWorkspace(row) : undefined;
}

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

export async function enqueueWorkspaceCommand(
  db: PostgresConnection,
  input: EnqueueWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  return db.transaction(async (tx) => {
    const workspace = await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId
    });
    const queuedAt = input.queuedAt ? new Date(input.queuedAt) : new Date();
    const [row] = await tx
      .insert(workspaceCommands)
      .values({
        id: createPlatformId<"WorkspaceCommandId">("wcmd"),
        workspaceId: workspace.id,
        clientInstanceId: input.clientInstanceId,
        conversationId: workspace.conversationId,
        ownerUserId: input.ownerUserId,
        agentRunId: input.agentRunId ?? null,
        toolCallId: input.toolCallId ?? null,
        command: input.command,
        cwd: input.cwd ?? null,
        status: "queued",
        limits: input.limits,
        expectedOutputs: input.expectedOutputs ?? [],
        attempts: 0,
        queuedAt,
        updatedAt: queuedAt
      })
      .returning();
    await tx
      .update(executionWorkspaces)
      .set({ updatedAt: queuedAt })
      .where(eq(executionWorkspaces.id, workspace.id));
    return mapWorkspaceCommand(row);
  });
}

export async function getWorkspaceCommand(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    commandId: WorkspaceCommandId;
  }
): Promise<WorkspaceCommand | undefined> {
  const [row] = await db
    .select()
    .from(workspaceCommands)
    .where(
      and(
        eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
        eq(workspaceCommands.id, input.commandId)
      )
    )
    .limit(1);
  return row ? mapWorkspaceCommand(row) : undefined;
}

export async function countActiveWorkspaceCommands(
  db: PostgresConnection,
  input: CountActiveWorkspaceCommandsInput
): Promise<ActiveWorkspaceCommandCounts> {
  const filters = [
    drizzleSql`wc.client_instance_id = ${input.clientInstanceId}`,
    drizzleSql`wc.status in ('queued', 'running', 'cancelling')`,
    drizzleSql`ew.status = 'active'`
  ];
  if (input.conversationId !== undefined) {
    filters.push(drizzleSql`wc.conversation_id = ${input.conversationId}`);
  }
  if (input.ownerUserId !== undefined) {
    filters.push(drizzleSql`wc.owner_user_id = ${input.ownerUserId}`);
  }

  const rows = (await db.execute(drizzleSql<{ status: string; count: number }>`
    select wc.status, count(*)::int as count
    from workspace_commands wc
    join execution_workspaces ew on ew.id = wc.workspace_id
    where ${drizzleSql.join(filters, drizzleSql` and `)}
    group by wc.status
  `)) as unknown as Array<{ status: string; count: number | string }>;

  const counts: ActiveWorkspaceCommandCounts = {
    queued: 0,
    running: 0,
    cancelling: 0,
    total: 0
  };
  for (const row of rows) {
    const count = Number(row.count);
    if (row.status === "queued" || row.status === "running" || row.status === "cancelling") {
      counts[row.status] = count;
      counts.total += count;
    }
  }
  return counts;
}

/**
 * Takes a command by id for the executor job that drives it and writes the job's lease onto the
 * row's lease columns, which a worker of the previous release reads. A queued row is taken, and
 * a running one that nobody holds: its lease ran out, or `leaseOwnerId` already holds it, which
 * is an earlier attempt of the same job. `attempts` counts every claim, so a row that comes back
 * with more than one ran before.
 */
export async function claimWorkspaceCommand(
  db: PostgresConnection,
  input: ClaimWorkspaceCommandInput
): Promise<SubjectRowClaim<WorkspaceCommand>> {
  const ofRow = and(
    eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
    eq(workspaceCommands.id, input.commandId)
  );
  const [claimed] = await db
    .update(workspaceCommands)
    .set({
      status: "running",
      leaseOwner: input.leaseOwnerId,
      leaseToken: input.leaseToken,
      leaseExpiresAt: leaseExpiry(input.leaseMs),
      heartbeatAt: drizzleSql`now()`,
      startedAt: drizzleSql`coalesce(${workspaceCommands.startedAt}, now())`,
      attempts: drizzleSql`${workspaceCommands.attempts} + 1`,
      error: null,
      updatedAt: drizzleSql`now()`
    })
    .where(
      and(
        ofRow,
        drizzleSql`(
          ${workspaceCommands.status} = 'queued'
          or (
            ${workspaceCommands.status} in ('running', 'cancelling')
            and (
              ${workspaceCommands.leaseExpiresAt} is null
              or ${workspaceCommands.leaseExpiresAt} <= now()
              or ${workspaceCommands.leaseOwner} = ${input.leaseOwnerId}
            )
          )
        )`
      )
    )
    .returning();
  if (claimed) return { status: "claimed", row: mapWorkspaceCommand(claimed) };
  const [current] = await db
    .select({ status: workspaceCommands.status })
    .from(workspaceCommands)
    .where(ofRow)
    .limit(1);
  return current?.status === "running" || current?.status === "cancelling"
    ? { status: "held" }
    : { status: "finished" };
}

export async function renewClaimedWorkspaceCommandLease(
  db: PostgresConnection,
  input: RenewClaimedWorkspaceCommandLeaseInput
): Promise<boolean> {
  const rows = await db
    .update(workspaceCommands)
    .set({
      heartbeatAt: drizzleSql`now()`,
      leaseExpiresAt: leaseExpiry(input.leaseMs),
      updatedAt: drizzleSql`now()`
    })
    .where(claimedCommandWhere(input, "running", "cancelling"))
    .returning({ id: workspaceCommands.id });
  return rows.length > 0;
}

/**
 * Transition release only: the commands that are not finished and have no queued or running job
 * of `jobKind` under the command's dedupe key, oldest first.
 */
export async function listWorkspaceCommandsWithoutJob(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; jobKind: string; limit: number }
): Promise<Array<Pick<WorkspaceCommand, "id" | "workspaceId">>> {
  const rows = await db
    .select({ id: workspaceCommands.id, workspaceId: workspaceCommands.workspaceId })
    .from(workspaceCommands)
    .where(
      and(
        eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
        inArray(workspaceCommands.status, ["queued", "running", "cancelling"]),
        drizzleSql`not exists (
          select 1 from platform_jobs job
          where job.client_instance_id = ${workspaceCommands.clientInstanceId}
            and job.kind = ${input.jobKind}
            and job.dedupe_key = ${input.jobKind} || ':' || ${workspaceCommands.id}
            and job.status in ('queued', 'running')
        )`
      )
    )
    .orderBy(asc(workspaceCommands.queuedAt), asc(workspaceCommands.id))
    .limit(input.limit);
  return rows.map((row) => ({
    id: asWorkspaceCommandId(row.id),
    workspaceId: asExecutionWorkspaceId(row.workspaceId)
  }));
}

function leaseExpiry(leaseMs: number) {
  return drizzleSql`now() + make_interval(secs => ${leaseMs}::double precision / 1000)`;
}

export async function completeWorkspaceCommand(
  db: PostgresConnection,
  input: CompleteWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  const completedAt = new Date(input.completedAt);
  const [row] = await db
    .update(workspaceCommands)
    .set({
      status: "completed",
      output: input.output,
      error: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt,
      updatedAt: completedAt
    })
    .where(claimedCommandWhere(input, "running"))
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Workspace command lease is no longer active");
  }
  return mapWorkspaceCommand(row);
}

export async function failWorkspaceCommand(
  db: PostgresConnection,
  input: FailWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  const failedAt = new Date(input.failedAt);
  const [row] = await db
    .update(workspaceCommands)
    .set({
      status: "failed",
      output: input.output ?? null,
      error: input.error,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: failedAt,
      updatedAt: failedAt
    })
    .where(claimedCommandWhere(input, "running", "cancelling"))
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Workspace command lease is no longer active");
  }
  return mapWorkspaceCommand(row);
}

export async function requestWorkspaceCommandCancellation(
  db: PostgresConnection,
  input: RequestWorkspaceCommandCancellationInput
): Promise<WorkspaceCommand> {
  const requestedAt = input.requestedAt;
  return db.transaction(async (tx) => {
    const updated = (await tx.execute(drizzleSql<{ id: string }>`
      update workspace_commands
      set status = case
            when status = 'queued' then 'cancelled'
            else 'cancelling'
          end,
          cancellation_reason = ${input.reason ?? null},
          cancellation_requested_at = ${requestedAt}::timestamptz,
          lease_owner = case when status = 'queued' then null else lease_owner end,
          lease_token = case when status = 'queued' then null else lease_token end,
          lease_expires_at = case when status = 'queued' then null else lease_expires_at end,
          heartbeat_at = case when status = 'queued' then null else heartbeat_at end,
          completed_at = case when status = 'queued' then ${requestedAt}::timestamptz else completed_at end,
          updated_at = ${requestedAt}::timestamptz
      where client_instance_id = ${input.clientInstanceId}
        and id = ${input.commandId}
        and status in ('queued', 'running', 'cancelling')
      returning id
    `)) as unknown as Array<{ id: string }>;
    const updatedId = updated[0]?.id;
    if (updatedId) {
      const [row] = await tx
        .select()
        .from(workspaceCommands)
        .where(
          and(
            eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
            eq(workspaceCommands.id, updatedId)
          )
        )
        .limit(1);
      return mapWorkspaceCommand(row);
    }

    const [existing] = await tx
      .select()
      .from(workspaceCommands)
      .where(
        and(
          eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
          eq(workspaceCommands.id, input.commandId)
        )
      )
      .limit(1);
    if (!existing) {
      throw new AppError("NOT_FOUND", "Workspace command is not available");
    }
    throw new AppError("CONFLICT", "Workspace command is already terminal");
  });
}

export async function cancelClaimedWorkspaceCommand(
  db: PostgresConnection,
  input: CancelClaimedWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  const cancelledAt = new Date(input.cancelledAt);
  const [row] = await db
    .update(workspaceCommands)
    .set({
      status: "cancelled",
      output: input.output ?? null,
      cancellationReason: input.reason ?? null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      completedAt: cancelledAt,
      updatedAt: cancelledAt
    })
    .where(claimedCommandWhere(input, "running", "cancelling"))
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Workspace command lease is no longer active");
  }
  return mapWorkspaceCommand(row);
}

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

async function requireActiveConversation(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<void> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
}

async function requireActiveWorkspace(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
  }
): Promise<ExecutionWorkspace> {
  const where = [
    eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
    eq(executionWorkspaces.id, input.workspaceId),
    eq(executionWorkspaces.status, "active")
  ];
  const [row] = await db
    .select()
    .from(executionWorkspaces)
    .where(and(...where))
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Execution workspace is not available");
  }
  return mapExecutionWorkspace(row);
}

function claimedCommandWhere(
  input: {
    clientInstanceId: ClientInstanceId;
    commandId: WorkspaceCommandId;
    leaseToken: string;
  },
  ...statuses: Array<WorkspaceCommand["status"]>
) {
  return and(
    eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
    eq(workspaceCommands.id, input.commandId),
    eq(workspaceCommands.leaseToken, input.leaseToken),
    statuses.length === 1 && statuses[0] !== undefined
      ? eq(workspaceCommands.status, statuses[0])
      : drizzleSql`${workspaceCommands.status} in (${drizzleSql.join(
          statuses.map((status) => drizzleSql`${status}`),
          drizzleSql`, `
        )})`
  );
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function workspaceFileMetadataForUpsert(
  metadata: WorkspaceFile["metadata"],
  existing: WorkspaceFile | undefined,
  nextObjectKey: string
): WorkspaceFile["metadata"] {
  if (!existing || existing.objectKey === nextObjectKey) {
    return preserveRetainedObjectKeys(metadata, existing?.metadata);
  }
  return workspaceFileMetadataWithRetainedObjectKey(
    preserveRetainedObjectKeys(metadata, existing.metadata),
    existing.objectKey
  );
}

function workspaceFileMetadataWithRetainedObjectKey(
  metadata: WorkspaceFile["metadata"],
  objectKey: string
): WorkspaceFile["metadata"] {
  return {
    ...metadata,
    retainedObjectKeys: uniqueStrings([...retainedObjectKeys(metadata), objectKey])
  };
}

function preserveRetainedObjectKeys(
  metadata: WorkspaceFile["metadata"],
  existingMetadata: WorkspaceFile["metadata"] | undefined
): WorkspaceFile["metadata"] {
  const retained = retainedObjectKeys(existingMetadata);
  return retained.length > 0
    ? {
        ...metadata,
        retainedObjectKeys: uniqueStrings([...retainedObjectKeys(metadata), ...retained])
      }
    : metadata;
}

function retainedObjectKeys(metadata: WorkspaceFile["metadata"] | undefined): string[] {
  const value = metadata?.retainedObjectKeys;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
