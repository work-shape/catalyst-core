import { and, asc, eq, inArray, ne, sql as drizzleSql } from "drizzle-orm";
import {
  AppError,
  type CancelClaimedWorkspaceCommandInput,
  type ClaimWorkspaceCommandInput,
  type ClientInstanceId,
  type CompleteWorkspaceCommandInput,
  type ConversationId,
  type EnqueueWorkspaceCommandInput,
  type EnsureExecutionWorkspaceInput,
  type ExecutionWorkspace,
  type ExecutionWorkspaceId,
  type FailWorkspaceCommandInput,
  type RecoverStaleWorkspaceCommandsInput,
  type RequestWorkspaceCommandCancellationInput,
  type UpsertWorkspaceFileInput,
  type WorkspaceCommand,
  type WorkspaceCommandId,
  type WorkspaceFile,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
import { mapExecutionWorkspace, mapWorkspaceCommand, mapWorkspaceFile } from "./rows";
import { conversations, executionWorkspaceFiles, executionWorkspaces, workspaceCommands } from "./schema";

export async function ensureExecutionWorkspace(
  db: PostgresDatabase,
  input: EnsureExecutionWorkspaceInput
): Promise<ExecutionWorkspace> {
  const now = input.now ? new Date(input.now) : new Date();
  await requireOwnedActiveConversation(db, {
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId,
    ownerUserId: input.ownerUserId
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
  input: UpsertWorkspaceFileInput
): Promise<WorkspaceFile> {
  return db.transaction(async (tx) => {
    const workspace = await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId
    });
    const updatedAt = input.updatedAt ? new Date(input.updatedAt) : new Date();
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
        metadata: input.metadata ?? {},
        lastCommandId: input.lastCommandId ?? null,
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
          metadata: input.metadata ?? {},
          lastCommandId: input.lastCommandId ?? null,
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

export async function listWorkspaceFiles(
  db: PostgresDatabase,
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
        eq(executionWorkspaceFiles.workspaceId, input.workspaceId)
      )
    )
    .orderBy(asc(executionWorkspaceFiles.path));
  return rows.map(mapWorkspaceFile);
}

export async function enqueueWorkspaceCommand(
  db: PostgresDatabase,
  input: EnqueueWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  return db.transaction(async (tx) => {
    const workspace = await requireActiveWorkspace(tx, {
      clientInstanceId: input.clientInstanceId,
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId
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
  db: PostgresDatabase,
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

export async function claimNextWorkspaceCommand(
  db: PostgresDatabase,
  input: ClaimWorkspaceCommandInput
): Promise<WorkspaceCommand | undefined> {
  const claimed = await db.transaction(async (tx) => {
    const rows = (await tx.execute(drizzleSql<{ id: string }>`
      with candidate as (
        select wc.id
        from workspace_commands wc
        join execution_workspaces ew on ew.id = wc.workspace_id
        where wc.client_instance_id = ${input.clientInstanceId}
          and wc.status = 'queued'
          and ew.status = 'active'
        order by wc.queued_at asc, wc.id asc
        limit 1
        for update skip locked
      )
      update workspace_commands wc
      set status = 'running',
          lease_owner = ${input.workerId},
          lease_token = ${input.leaseToken},
          lease_expires_at = ${input.leaseExpiresAt}::timestamptz,
          heartbeat_at = ${input.now}::timestamptz,
          started_at = coalesce(wc.started_at, ${input.now}::timestamptz),
          attempts = wc.attempts + 1,
          error = null,
          updated_at = ${input.now}::timestamptz
      from candidate
      where wc.id = candidate.id
      returning wc.id
    `)) as unknown as Array<{ id: string }>;
    const commandId = rows[0]?.id;
    if (!commandId) {
      return undefined;
    }
    const [row] = await tx
      .select()
      .from(workspaceCommands)
      .where(
        and(
          eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
          eq(workspaceCommands.id, commandId)
        )
      )
      .limit(1);
    return row;
  });
  return claimed ? mapWorkspaceCommand(claimed) : undefined;
}

export async function completeWorkspaceCommand(
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
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
  db: PostgresDatabase,
  input: CancelClaimedWorkspaceCommandInput
): Promise<WorkspaceCommand> {
  const cancelledAt = new Date(input.cancelledAt);
  const [row] = await db
    .update(workspaceCommands)
    .set({
      status: "cancelled",
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

export async function recoverStaleWorkspaceCommands(
  db: PostgresDatabase,
  input: RecoverStaleWorkspaceCommandsInput
): Promise<WorkspaceCommand[]> {
  if (input.limit <= 0) {
    return [];
  }
  const recoveredAt = new Date(input.recoveredAt);
  return db.transaction(async (tx) => {
    const staleRows = (await tx.execute(drizzleSql<{ id: string }>`
      select id
      from workspace_commands
      where client_instance_id = ${input.clientInstanceId}
        and status in ('running', 'cancelling')
        and lease_expires_at is not null
        and lease_expires_at < ${input.staleLeaseExpiredBefore}::timestamptz
      order by lease_expires_at asc, id asc
      limit ${input.limit}
      for update skip locked
    `)) as unknown as Array<{ id: string }>;
    const commandIds = staleRows.map((row) => row.id);
    if (commandIds.length === 0) {
      return [];
    }
    const rows = await tx
      .update(workspaceCommands)
      .set({
        status: "failed",
        error: input.error,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        completedAt: recoveredAt,
        updatedAt: recoveredAt
      })
      .where(
        and(
          eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
          inArray(workspaceCommands.id, commandIds)
        )
      )
      .returning();
    return rows.map(mapWorkspaceCommand);
  });
}

async function requireOwnedActiveConversation(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    ownerUserId: string;
  }
): Promise<void> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.ownerUserId, input.ownerUserId),
        eq(conversations.status, "active")
      )
    )
    .limit(1);
  if (!row) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
}

async function requireActiveWorkspace(
  db: PostgresDatabase | PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    workspaceId: ExecutionWorkspaceId;
    ownerUserId?: string;
  }
): Promise<ExecutionWorkspace> {
  const where = [
    eq(executionWorkspaces.clientInstanceId, input.clientInstanceId),
    eq(executionWorkspaces.id, input.workspaceId),
    eq(executionWorkspaces.status, "active")
  ];
  if (input.ownerUserId !== undefined) {
    where.push(eq(executionWorkspaces.ownerUserId, input.ownerUserId));
  }
  const [row] = await db.select().from(executionWorkspaces).where(and(...where)).limit(1);
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
    statuses.length === 1
      ? eq(workspaceCommands.status, statuses[0]!)
      : drizzleSql`${workspaceCommands.status} in (${drizzleSql.join(
          statuses.map((status) => drizzleSql`${status}`),
          drizzleSql`, `
        )})`
  );
}
