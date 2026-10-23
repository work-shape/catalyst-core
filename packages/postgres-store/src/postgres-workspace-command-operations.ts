import {
  AppError,
  LIVE_JOB_STATUSES,
  WORKSPACE_COMMAND_JOB_KIND,
  asExecutionWorkspaceId,
  asWorkspaceCommandId,
  createPlatformId,
  subjectDedupeKey,
  type ActiveWorkspaceCommandCounts,
  type AgentRunId,
  type CancelClaimedWorkspaceCommandInput,
  type ClaimWorkspaceCommandInput,
  type ClientInstanceId,
  type CompleteWorkspaceCommandInput,
  type CountActiveWorkspaceCommandsInput,
  type EnqueueWorkspaceCommandInput,
  type FailWorkspaceCommandInput,
  type RenewClaimedWorkspaceCommandLeaseInput,
  type RequestWorkspaceCommandCancellationInput,
  type SubjectRowClaim,
  type WorkspaceCommand,
  type WorkspaceCommandId
} from "@work-shape/catalyst-core";
import { and, asc, sql as drizzleSql, eq, inArray } from "drizzle-orm";
import { withdrawQueuedJobs } from "./jobs/store";
import { type PostgresConnection } from "./postgres-database";
import { requireActiveWorkspace } from "./postgres-execution-workspace-metadata";
import { mapWorkspaceCommand } from "./rows";
import { executionWorkspaces, workspaceCommands } from "./schema";
import { platformJobs } from "./schema/jobs";

const ACTIVE_COMMAND_STATUSES = [
  "queued",
  "running",
  "cancelling"
] as const satisfies readonly WorkspaceCommand["status"][];

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
        skillMounts: input.skillMounts?.length ? input.skillMounts : null,
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
        inArray(workspaceCommands.status, ACTIVE_COMMAND_STATUSES),
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
    // A cancellation that was requested after the process had ended changes nothing about its
    // result: the command is recorded as it ended, and the request stays on the row.
    .where(claimedCommandWhere(input, "running", "cancelling"))
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
      const command = mapWorkspaceCommand(row);
      // Cancelled at once means no worker had claimed it: its job has nothing left to run.
      if (command.status === "cancelled")
        await withdrawCommandJobs(tx, input.clientInstanceId, [command.id]);
      return command;
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

export async function giveUpUnclaimedWorkspaceCommand(
  db: PostgresConnection,
  input: RequestWorkspaceCommandCancellationInput
): Promise<WorkspaceCommand | undefined> {
  return db.transaction(async (tx) => {
    // A worker claims the job before it claims the command. With the job locked while it is
    // queued, no worker starts the command between this decision and its commit.
    const jobs = await tx
      .select({ status: platformJobs.status })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.clientInstanceId, input.clientInstanceId),
          eq(platformJobs.kind, WORKSPACE_COMMAND_JOB_KIND),
          eq(platformJobs.dedupeKey, subjectDedupeKey(WORKSPACE_COMMAND_JOB_KIND, input.commandId)),
          inArray(platformJobs.status, LIVE_JOB_STATUSES)
        )
      )
      .for("update");
    if (jobs.some((job) => job.status === "running")) return undefined;
    const [row] = await tx
      .update(workspaceCommands)
      .set({
        status: "cancelled",
        cancellationReason: input.reason ?? null,
        cancellationRequestedAt: new Date(input.requestedAt),
        completedAt: new Date(input.requestedAt),
        updatedAt: new Date(input.requestedAt)
      })
      .where(
        and(
          eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
          eq(workspaceCommands.id, input.commandId),
          eq(workspaceCommands.status, "queued")
        )
      )
      .returning();
    if (!row) return undefined;
    await withdrawCommandJobs(tx, input.clientInstanceId, [row.id]);
    return mapWorkspaceCommand(row);
  });
}

/** What a command is cancelled with when its run ended before a worker claimed it. */
const RUN_ENDED_REASON =
  "Workspace command was withdrawn: its agent run ended before a worker took it";

/**
 * Cancels the commands of these runs that no worker claimed and withdraws their jobs. Called
 * in the transaction that ends a run, so nothing a run queued waits for a worker after it. A
 * command that runs is its worker's and ends by its own limits.
 */
export async function withdrawUnclaimedWorkspaceCommandsOfRuns(
  tx: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; runIds: readonly AgentRunId[] }
): Promise<void> {
  if (input.runIds.length === 0) return;
  const cancelled = await tx
    .update(workspaceCommands)
    .set({
      status: "cancelled",
      cancellationReason: RUN_ENDED_REASON,
      cancellationRequestedAt: drizzleSql`now()`,
      completedAt: drizzleSql`now()`,
      updatedAt: drizzleSql`now()`
    })
    .where(
      and(
        eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
        inArray(workspaceCommands.agentRunId, [...input.runIds]),
        eq(workspaceCommands.status, "queued")
      )
    )
    .returning({ id: workspaceCommands.id });
  await withdrawCommandJobs(
    tx,
    input.clientInstanceId,
    cancelled.map((command) => command.id)
  );
}

export async function hasUnclaimedWorkspaceCommand(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; agentRunId: AgentRunId }
): Promise<boolean> {
  const [queued] = await db
    .select({ id: workspaceCommands.id })
    .from(workspaceCommands)
    .where(
      and(
        eq(workspaceCommands.clientInstanceId, input.clientInstanceId),
        eq(workspaceCommands.agentRunId, input.agentRunId),
        eq(workspaceCommands.status, "queued")
      )
    )
    .limit(1);
  return queued !== undefined;
}

function withdrawCommandJobs(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  commandIds: readonly string[]
): Promise<void> {
  return withdrawQueuedJobs(tx, {
    clientInstanceId,
    kind: WORKSPACE_COMMAND_JOB_KIND,
    dedupeKeys: commandIds.map((id) => subjectDedupeKey(WORKSPACE_COMMAND_JOB_KIND, id))
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
