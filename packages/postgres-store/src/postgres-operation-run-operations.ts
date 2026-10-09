import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import {
  INTERRUPTED_RUN_ERROR,
  type OperationRun,
  type OperationRunStore
} from "@vivd-catalyst/core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { operationRuns } from "./schema/operationRuns";

type OperationRunRow = typeof operationRuns.$inferSelect;
type Input<Method extends keyof OperationRunStore> = Parameters<OperationRunStore[Method]>[0];

export async function createOperationRun(
  db: PostgresConnection,
  run: Input<"create">
): Promise<OperationRun | undefined> {
  const startedAt = new Date(run.startedAt);
  const [row] = await db
    .insert(operationRuns)
    .values({
      id: run.id,
      clientInstanceId: run.clientInstanceId,
      operation: run.operation,
      effect: run.effect,
      actorKind: run.actor.kind,
      actorId: run.actor.id,
      actor: run.actor,
      ownerUserId: run.ownerUserId,
      collaborationWorkspaceId: run.workspaceId,
      originKind: run.origin.kind,
      origin: run.origin,
      conversationId: run.conversationId,
      idempotencyKey: run.idempotencyKey,
      inputHash: run.inputHash,
      status: "running",
      correlationId: run.correlationId,
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt
    })
    // The key is taken. Only a failed run of the same call is handed out again, as its next
    // attempt; every other holder of the key leaves this statement without a row. So does an
    // interrupted run of a changing operation: its call may have changed something, and running
    // it again would repeat it.
    .onConflictDoUpdate({
      target: [
        operationRuns.clientInstanceId,
        operationRuns.actorKind,
        operationRuns.actorId,
        operationRuns.idempotencyKey
      ],
      targetWhere: sql`${operationRuns.idempotencyKey} is not null`,
      set: {
        status: "running",
        attempt: sql`${operationRuns.attempt} + 1`,
        error: null,
        correlationId: run.correlationId,
        startedAt,
        finishedAt: null,
        updatedAt: startedAt
      },
      setWhere: and(
        eq(operationRuns.status, "failed"),
        eq(operationRuns.operation, run.operation),
        eq(operationRuns.inputHash, run.inputHash),
        or(
          eq(operationRuns.effect, "reading"),
          sql`${operationRuns.error}->>'code' is distinct from ${INTERRUPTED_RUN_ERROR.code}`
        )
      )
    })
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

export async function finishOperationRun(
  db: PostgresConnection,
  input: Input<"finish">
): Promise<OperationRun | undefined> {
  const { end } = input;
  const finishedAt = new Date(end.finishedAt);
  const [row] = await db
    .update(operationRuns)
    .set({
      status: end.status,
      updatedAt: finishedAt,
      ...(end.status === "pending_approval"
        ? {
            approvalRequestId: end.approvalRequestId,
            inputRef: end.inputRef,
            expiresAt: new Date(end.expiresAt)
          }
        : { finishedAt }),
      ...(end.status === "done"
        ? { output: end.output, resultRef: end.resultRef, decision: end.decision }
        : {}),
      ...(end.status === "failed" ? { error: end.error } : {}),
      ...(end.status === "denied" ? { error: { ...end.error, denial: end.denial } } : {})
    })
    .where(and(identity(input), eq(operationRuns.status, "running")))
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

export async function findOperationRunByIdempotencyKey(
  db: PostgresConnection,
  input: Input<"findByIdempotencyKey">
): Promise<OperationRun | undefined> {
  const [row] = await db
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        eq(operationRuns.actorKind, input.actor.kind),
        eq(operationRuns.actorId, input.actor.id),
        eq(operationRuns.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  return row ? mapOperationRun(row) : undefined;
}

export async function getOperationRun(
  db: PostgresConnection,
  input: Input<"get">
): Promise<OperationRun | undefined> {
  const [row] = await db.select().from(operationRuns).where(identity(input)).limit(1);
  return row ? mapOperationRun(row) : undefined;
}

export async function listOperationRuns(
  db: PostgresConnection,
  input: Input<"list">
): Promise<OperationRun[]> {
  const { filters = {} } = input;
  const rows = await db
    .select()
    .from(operationRuns)
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        filters.operation === undefined
          ? undefined
          : eq(operationRuns.operation, filters.operation),
        filters.status === undefined ? undefined : eq(operationRuns.status, filters.status),
        filters.actorId === undefined ? undefined : eq(operationRuns.actorId, filters.actorId),
        filters.originKind === undefined
          ? undefined
          : eq(operationRuns.originKind, filters.originKind),
        filters.workspaceId === undefined
          ? undefined
          : eq(operationRuns.collaborationWorkspaceId, filters.workspaceId),
        filters.since === undefined
          ? undefined
          : gte(operationRuns.createdAt, new Date(filters.since)),
        keysetFilter(input.page, [operationRuns.createdAt, operationRuns.id], true)
      )
    )
    .orderBy(desc(operationRuns.createdAt), desc(operationRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapOperationRun);
}

export async function markOperationRunsExpired(
  db: PostgresConnection,
  input: Input<"markExpired">
): Promise<OperationRun[]> {
  const rows = await db
    .update(operationRuns)
    .set({ status: "expired", finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(operationRuns.clientInstanceId, input.clientInstanceId),
        inArray(operationRuns.status, ["pending_confirmation", "pending_approval"]),
        lte(operationRuns.expiresAt, sql`now()`)
      )
    )
    .returning();
  return rows.map(mapOperationRun);
}

export async function markOperationRunInterrupted(
  db: PostgresConnection,
  input: Input<"markInterrupted">
): Promise<OperationRun | undefined> {
  const [row] = await db
    .update(operationRuns)
    .set({
      status: "failed",
      error: INTERRUPTED_RUN_ERROR,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`
    })
    .where(and(identity(input), eq(operationRuns.status, "running")))
    .returning();
  return row ? mapOperationRun(row) : undefined;
}

function identity(input: Pick<Input<"get">, "clientInstanceId" | "id">) {
  return and(
    eq(operationRuns.clientInstanceId, input.clientInstanceId),
    // The id may be any text a caller named, so it is compared as text, not as a known id.
    eq(operationRuns.id, sql`${input.id}`)
  );
}

function mapOperationRun(row: OperationRunRow): OperationRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    operation: row.operation,
    effect: row.effect,
    actor: row.actor,
    ownerUserId: row.ownerUserId ?? undefined,
    workspaceId: row.collaborationWorkspaceId ?? undefined,
    origin: row.origin,
    conversationId: row.conversationId ?? undefined,
    idempotencyKey: row.idempotencyKey ?? undefined,
    inputHash: row.inputHash,
    inputRef: row.inputRef ?? undefined,
    status: row.status,
    attempt: row.attempt,
    decision: row.decision ?? undefined,
    approvalRequestId: row.approvalRequestId ?? undefined,
    output: row.output ?? undefined,
    resultRef: row.resultRef ?? undefined,
    error: row.error ? { code: row.error.code, message: row.error.message } : undefined,
    denial: row.error?.denial,
    usage: row.usage ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
    expiresAt: row.expiresAt?.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
