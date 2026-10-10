import { keysetFilter } from "./paging";
import type { StorePage } from "@vivd-catalyst/core";
import { and, desc, eq, gte, lt, sql as drizzleSql } from "drizzle-orm";
import {
  type AuditEvent,
  type AuditEventInput,
  type ClientInstanceId,
  type ModelUsageEvent,
  type ModelUsageEventStore,
  AppError,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapAuditEvent, mapModelUsageEvent } from "./rows";
import {
  agentRuns,
  auditEvents,
  collaborationWorkspaces,
  conversations,
  modelUsageEvents,
  productUsers
} from "./schema";

export async function appendAuditEvent(
  db: PostgresConnection,
  input: AuditEventInput
): Promise<AuditEvent> {
  const id = createPlatformId<"AuditEventId">("audit");
  const [row] = await db
    .insert(auditEvents)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      type: input.type,
      status: input.status,
      actor: input.actor ?? null,
      subject: input.subject ?? null,
      reason: input.reason ?? null,
      correlationId: input.correlationId,
      createdAt: new Date(),
      metadata: input.metadata ?? {}
    })
    .returning();
  return mapAuditEvent(row);
}

export async function listAuditEvents(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    limit?: number;
    type?: string;
    page?: StorePage;
  }
): Promise<AuditEvent[]> {
  const limit = input.limit ?? 100;
  const filters = input.type
    ? and(
        eq(auditEvents.clientInstanceId, input.clientInstanceId),
        eq(auditEvents.type, input.type)
      )
    : eq(auditEvents.clientInstanceId, input.clientInstanceId);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(filters, keysetFilter(input.page, [auditEvents.createdAt, auditEvents.id], true)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(input.page?.limit ?? limit);
  return rows.map(mapAuditEvent);
}

export async function deleteAuditEventsOlderThan(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; days: number }
): Promise<{ deletedCount: number; createdBefore: string }> {
  // The cutoff is the database's: its clock stamped the events, a worker's clock may differ.
  const [cutoff] = await db.execute(drizzleSql`
    select to_char(
      (now() - make_interval(days => ${input.days})) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) as created_before
  `);
  const createdBeforeText = cutoff?.created_before;
  if (typeof createdBeforeText !== "string")
    throw new AppError("INTERNAL", "The database returned no time");
  const createdBefore = new Date(createdBeforeText);
  const removed = await db
    .delete(auditEvents)
    .where(
      and(
        eq(auditEvents.clientInstanceId, input.clientInstanceId),
        lt(auditEvents.createdAt, createdBefore)
      )
    );
  return { deletedCount: removed.count, createdBefore: createdBefore.toISOString() };
}

export async function listModelUsageEvents(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    start?: string;
    end?: string;
    limit?: number;
    page?: StorePage;
  }
): Promise<ModelUsageEvent[]> {
  const query = db
    .select()
    .from(modelUsageEvents)
    .where(
      and(
        ...modelUsageFilters(input),
        keysetFilter(input.page, [modelUsageEvents.createdAt, modelUsageEvents.id], true)
      )
    )
    // The order of the index on instance and creation time, so the newest are read from it.
    .orderBy(drizzleSql`${modelUsageEvents.createdAt} desc nulls last`, desc(modelUsageEvents.id));
  const rows = await query.limit(input.page?.limit ?? input.limit ?? 2147483647);
  return rows.map(mapModelUsageEvent);
}

function modelUsageFilters(input: {
  clientInstanceId: ClientInstanceId;
  start?: string;
  end?: string;
}) {
  return [
    eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
    ...(input.start ? [gte(modelUsageEvents.createdAt, new Date(input.start))] : []),
    ...(input.end ? [lt(modelUsageEvents.createdAt, new Date(input.end))] : [])
  ];
}

export async function clearUserFromModelUsageEvents(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["clearUserFromModelUsageEvents"]>[0]
): Promise<number> {
  const cleared = await db.execute(drizzleSql`
    update ${modelUsageEvents} set
      user_id = null,
      conversation_id = null,
      agent_run_id = null,
      operation_run_id = null,
      correlation_id = ''
    where ${modelUsageEvents.id} in (
      select ${modelUsageEvents.id} from ${modelUsageEvents}
      where ${modelUsageEvents.userId} = ${input.userId}
        and ${modelUsageEvents.clientInstanceId} = ${input.clientInstanceId}
      limit ${input.limit}
    )
  `);
  return cleared.count;
}

export async function clearWorkspaceFromModelUsageEvents(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["clearWorkspaceFromModelUsageEvents"]>[0]
): Promise<number> {
  const cleared = await db.execute(drizzleSql`
    update ${modelUsageEvents} set collaboration_workspace_id = null
    where ${modelUsageEvents.id} in (
      select ${modelUsageEvents.id} from ${modelUsageEvents}
      where ${modelUsageEvents.collaborationWorkspaceId} = ${input.collaborationWorkspaceId}
        and ${modelUsageEvents.clientInstanceId} = ${input.clientInstanceId}
      limit ${input.limit}
    )
  `);
  return cleared.count;
}

/**
 * One batch of the attribution backfill. The batch is the next `limit` events of the instance
 * after `after` in the order of creation time and id, which is the order the table holds them
 * in, so a batch reads and writes neighbouring pages. One statement rewrites those of them that gain a value and
 * leaves the rest untouched, so a second run over the same events writes nothing. It locks only
 * the rows it rewrites, for the length of the statement, and never waits for a row that a
 * settlement holds longer than that settlement's own statement.
 */
export async function backfillModelUsageAttribution(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["backfillModelUsageAttribution"]>[0]
): Promise<Awaited<ReturnType<ModelUsageEventStore["backfillModelUsageAttribution"]>>> {
  const e = drizzleSql`e`;
  const targets = JSON.stringify(
    input.targets.map((target) => ({
      provider_id: target.providerId,
      model: target.model,
      region: target.region ?? null,
      binding_id: target.bindingId ?? null
    }))
  );
  // The row comparison alone is no index condition, because the id is not in the index on
  // instance and creation time. The bound on the creation time is.
  const after = input.after
    ? drizzleSql`and created_at >= ${input.after.createdAt}::timestamptz
        and (created_at, id) > (${input.after.createdAt}::timestamptz, ${input.after.id})`
    : drizzleSql``;
  const rows = (await db.execute(drizzleSql`
    with batch as (
      select id, created_at from ${modelUsageEvents}
      where client_instance_id = ${input.clientInstanceId} ${after}
      -- The order the index on instance and creation time gives when it is read backward.
      order by created_at asc nulls first, id asc
      limit ${input.limit}
    ),
    filled as (
      select
        ${e}.id,
        coalesce(${e}.purpose, case
          when ${e}.agent_name = 'approval_check' then 'guardrail_judge'
          when ${e}.agent_name = 'conversation_title' then ${e}.agent_name
          -- By name, not by the missing run alone: the deletion of an account takes the run
          -- off the events of an agent too.
          when ${e}.agent_run_id is null
            and ${e}.agent_name in ('guardrail_judge', 'document_extraction')
            then ${e}.agent_name
        end) as purpose,
        coalesce(${e}.region, target.region) as region,
        coalesce(${e}.binding_id, target.binding_id) as binding_id,
        coalesce(${e}.user_id, attributed_user.id) as user_id,
        coalesce(${e}.collaboration_workspace_id, attributed_workspace.id) as collaboration_workspace_id
      from batch
      join ${modelUsageEvents} ${e} on ${e}.id = batch.id
      left join jsonb_to_recordset(${targets}::jsonb)
        as target(provider_id text, model text, region text, binding_id text)
        on target.provider_id = ${e}.provider_id and target.model = ${e}.model
      left join ${agentRuns} run
        on run.id = ${e}.agent_run_id and run.client_instance_id = ${e}.client_instance_id
      left join ${conversations} conversation
        on conversation.id = ${e}.conversation_id
        and conversation.client_instance_id = ${e}.client_instance_id
      left join ${productUsers} attributed_user
        on attributed_user.id = coalesce(run.owner_user_id, conversation.created_by_user_id)
        and attributed_user.client_instance_id = ${e}.client_instance_id
        and attributed_user.deletion_requested_at is null
      left join ${collaborationWorkspaces} attributed_workspace
        on attributed_workspace.id = conversation.collaboration_workspace_id
        and attributed_workspace.client_instance_id = ${e}.client_instance_id
        and attributed_workspace.deletion_requested_at is null
    ),
    changed as (
      update ${modelUsageEvents} ${e} set
        purpose = filled.purpose,
        region = filled.region,
        binding_id = filled.binding_id,
        user_id = filled.user_id,
        collaboration_workspace_id = filled.collaboration_workspace_id
      from filled
      where ${e}.id = filled.id
        and (${e}.purpose, ${e}.region, ${e}.binding_id, ${e}.user_id, ${e}.collaboration_workspace_id)
          is distinct from
          (filled.purpose, filled.region, filled.binding_id, filled.user_id, filled.collaboration_workspace_id)
      returning 1
    )
    select
      last.id as last_id,
      to_char(last.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_created_at,
      (select count(*)::int from changed) as changed_count
    from (select 1) one
    left join lateral (
      select id, created_at from batch order by created_at desc, id desc limit 1
    ) last on true
  `)) as { last_id: string | null; last_created_at: string | null; changed_count: number }[];
  const [row] = rows;
  return {
    ...(row?.last_id && row.last_created_at
      ? { next: { createdAt: row.last_created_at, id: row.last_id } }
      : {}),
    changedCount: row?.changed_count ?? 0
  };
}
