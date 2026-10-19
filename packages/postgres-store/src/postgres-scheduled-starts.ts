import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  AppError,
  ACTIVE_AGENT_RUN_STATUSES,
  asAgentRunId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  type ScheduledStart,
  type ScheduledStartRun,
  type ScheduledStartsStore,
  type ClientInstanceId,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { keysetFilter } from "./paging";
import { agentRuns } from "./schema/agentRuns";
import { scheduledStarts, scheduledStartRuns } from "./schema/scheduledStarts";

function mapStart(row: typeof scheduledStarts.$inferSelect): ScheduledStart {
  return {
    ...row,
    clientInstanceId: asClientInstanceId(row.clientInstanceId),
    collaborationWorkspaceId: asCollaborationWorkspaceId(row.collaborationWorkspaceId),
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapRun(row: typeof scheduledStartRuns.$inferSelect): ScheduledStartRun {
  return {
    ...row,
    conversationId: row.conversationId === null ? null : asConversationId(row.conversationId),
    agentRunId: row.agentRunId === null ? null : asAgentRunId(row.agentRunId),
    scheduledFor: row.scheduledFor.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

const runColumns = {
  ...getTableColumns(scheduledStartRuns),
  status: sql<string>`coalesce(${agentRuns.status}, ${scheduledStartRuns.status})`
};
const joinRun = and(
  eq(agentRuns.clientInstanceId, scheduledStartRuns.clientInstanceId),
  eq(agentRuns.id, scheduledStartRuns.agentRunId)
);

/** Runless history has no conversation to own its retention once the workspace is gone. */
export async function deleteWorkspaceScheduledStartHistory(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; collaborationWorkspaceId: CollaborationWorkspaceId }
): Promise<void> {
  await db.delete(scheduledStartRuns).where(
    and(
      eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
      isNull(scheduledStartRuns.agentRunId),
      inArray(
        scheduledStartRuns.scheduledStartId,
        db
          .select({ id: scheduledStarts.id })
          .from(scheduledStarts)
          .where(
            and(
              eq(scheduledStarts.clientInstanceId, input.clientInstanceId),
              eq(scheduledStarts.collaborationWorkspaceId, input.collaborationWorkspaceId)
            )
          )
      )
    )
  );
}

export function createPostgresScheduledStartsStore(db: PostgresConnection): ScheduledStartsStore {
  return {
    async list(input) {
      const rows = await db
        .select()
        .from(scheduledStarts)
        .where(
          and(
            eq(scheduledStarts.clientInstanceId, input.clientInstanceId),
            eq(scheduledStarts.ownerUserId, input.ownerUserId),
            input.collaborationWorkspaceId === undefined
              ? undefined
              : eq(scheduledStarts.collaborationWorkspaceId, input.collaborationWorkspaceId),
            keysetFilter(input.page, [scheduledStarts.createdAt, scheduledStarts.id], true)
          )
        )
        .orderBy(desc(scheduledStarts.createdAt), desc(scheduledStarts.id))
        .limit(input.page.limit);
      return rows.map(mapStart);
    },
    async get(input) {
      const query = db
        .select()
        .from(scheduledStarts)
        .where(
          and(
            eq(scheduledStarts.clientInstanceId, input.clientInstanceId),
            eq(scheduledStarts.id, input.id)
          )
        )
        .limit(1);
      const [row] = await (input.forUpdate ? query.for("update") : query);
      return row && mapStart(row);
    },
    async create({ start }) {
      const [row] = await db
        .insert(scheduledStarts)
        .values({
          ...start,
          nextRunAt: start.nextRunAt === null ? null : new Date(start.nextRunAt),
          createdAt: new Date(start.createdAt),
          updatedAt: new Date(start.updatedAt)
        })
        .returning();
      if (!row) throw new AppError("INTERNAL", "Scheduled start was not created");
      return mapStart(row);
    },
    async update(input) {
      const { nextRunAt, ...patch } = input.patch;
      const [row] = await db
        .update(scheduledStarts)
        .set({
          ...patch,
          ...(nextRunAt === undefined
            ? {}
            : { nextRunAt: nextRunAt === null ? null : new Date(nextRunAt) }),
          updatedAt: new Date(input.now)
        })
        .where(
          and(
            eq(scheduledStarts.clientInstanceId, input.clientInstanceId),
            eq(scheduledStarts.id, input.id),
            eq(scheduledStarts.ownerUserId, input.ownerUserId)
          )
        )
        .returning();
      if (!row) throw new AppError("NOT_FOUND", "Scheduled start is not available");
      return mapStart(row);
    },
    async delete(input) {
      await db.transaction(async (tx) => {
        const [start] = await tx
          .select({ id: scheduledStarts.id })
          .from(scheduledStarts)
          .where(
            and(
              eq(scheduledStarts.clientInstanceId, input.clientInstanceId),
              eq(scheduledStarts.id, input.id),
              eq(scheduledStarts.ownerUserId, input.ownerUserId)
            )
          )
          .for("update");
        if (!start) throw new AppError("NOT_FOUND", "Scheduled start is not available");
        // Started runs keep their immutable consent until their conversation/run is removed.
        await tx
          .delete(scheduledStartRuns)
          .where(
            and(
              eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
              eq(scheduledStartRuns.scheduledStartId, input.id),
              isNull(scheduledStartRuns.agentRunId)
            )
          );
        await tx.delete(scheduledStarts).where(eq(scheduledStarts.id, start.id));
      });
    },
    async listRuns(input) {
      const rows = await db
        .select(runColumns)
        .from(scheduledStartRuns)
        .leftJoin(agentRuns, joinRun)
        .where(
          and(
            eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
            eq(scheduledStartRuns.scheduledStartId, input.scheduledStartId),
            keysetFilter(input.page, [scheduledStartRuns.createdAt, scheduledStartRuns.id], true)
          )
        )
        .orderBy(desc(scheduledStartRuns.createdAt), desc(scheduledStartRuns.id))
        .limit(input.page.limit);
      return rows.map(mapRun);
    },
    async addRun({ clientInstanceId, run }) {
      await db.insert(scheduledStartRuns).values({
        ...run,
        clientInstanceId,
        scheduledFor: new Date(run.scheduledFor),
        createdAt: new Date(run.createdAt)
      });
    },
    async getRun(input) {
      const [row] = await db
        .select(runColumns)
        .from(scheduledStartRuns)
        .leftJoin(agentRuns, joinRun)
        .where(
          and(
            eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
            eq(scheduledStartRuns.scheduledStartId, input.scheduledStartId),
            eq(scheduledStartRuns.scheduledFor, new Date(input.scheduledFor))
          )
        )
        .limit(1);
      return row && mapRun(row);
    },
    async hasOpenRun(input) {
      // Serialized ticks start no successor while its predecessor is open. Runless skipped
      // ticks never participate, and only the latest started run can still block a tick.
      const latest = db
        .select({ agentRunId: scheduledStartRuns.agentRunId })
        .from(scheduledStartRuns)
        .where(
          and(
            eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
            eq(scheduledStartRuns.scheduledStartId, input.scheduledStartId),
            isNotNull(scheduledStartRuns.agentRunId)
          )
        )
        .orderBy(desc(scheduledStartRuns.createdAt), desc(scheduledStartRuns.id))
        .limit(1)
        .as("latest_scheduled_run");
      const [row] = await db
        .select({ status: agentRuns.status })
        .from(latest)
        .innerJoin(
          agentRuns,
          and(
            eq(agentRuns.id, latest.agentRunId),
            eq(agentRuns.clientInstanceId, input.clientInstanceId)
          )
        )
        .where(inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]))
        .limit(1);
      return row
        ? row.status === "waiting_for_decision"
          ? "waiting_for_decision"
          : "active"
        : undefined;
    },
    async detachRuns(input) {
      await db.transaction(async (tx) => {
        const ofStart = and(
          eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
          eq(scheduledStartRuns.scheduledStartId, input.scheduledStartId)
        );
        await tx
          .delete(scheduledStartRuns)
          .where(and(ofStart, isNull(scheduledStartRuns.agentRunId)));
        await tx.update(scheduledStartRuns).set({ scheduledStartId: null }).where(ofStart);
      });
    },
    async pruneRunless(input) {
      await db
        .delete(scheduledStartRuns)
        .where(
          and(
            eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
            eq(scheduledStartRuns.scheduledStartId, input.scheduledStartId),
            isNull(scheduledStartRuns.agentRunId),
            lt(scheduledStartRuns.createdAt, new Date(input.keepAfter))
          )
        );
    },
    async isScheduledAgentRun(input) {
      const [row] = await db
        .select({ personalConnectionsAllowed: scheduledStartRuns.personalConnectionsAllowed })
        .from(scheduledStartRuns)
        .where(
          and(
            eq(scheduledStartRuns.clientInstanceId, input.clientInstanceId),
            eq(scheduledStartRuns.agentRunId, input.runId)
          )
        )
        .limit(1);
      return row;
    }
  };
}
