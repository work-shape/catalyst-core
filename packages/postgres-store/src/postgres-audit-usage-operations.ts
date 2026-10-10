import { keysetFilter } from "./paging";
import type { StorePage } from "@vivd-catalyst/core";
import { and, desc, eq, gte, lt, sql as drizzleSql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  type AuditEvent,
  type AuditEventInput,
  type ClientInstanceId,
  type ModelUsageBudgetUsage,
  type ModelUsageBudgetWindow,
  type ModelUsageEvent,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStore,
  type ModelUsageHistory,
  type ModelUsageTotals,
  type RecentModelUsage,
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

export async function appendModelUsageEvent(
  db: PostgresConnection,
  input: ModelUsageEventRecordInput
): Promise<ModelUsageEvent> {
  const id = createPlatformId<"ModelUsageEventId">("usage");
  const [row] = await db
    .insert(modelUsageEvents)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId ?? null,
      agentRunId: input.agentRunId ?? null,
      agentName: input.agentName ?? null,
      purpose: input.purpose ?? null,
      providerId: input.providerId,
      model: input.model,
      region: input.region ?? null,
      bindingId: input.bindingId ?? null,
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens ?? null,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      webSearchCallCount: input.webSearchCallCount,
      fastMode: input.fastMode,
      providerServiceTier: input.providerServiceTier ?? null,
      source: input.source,
      customerBillableCost: input.customerBillableCost,
      userId: attributableUser(input),
      collaborationWorkspaceId: attributableWorkspace(input),
      operationRunId: input.operationRunId ?? null,
      correlationId: input.correlationId,
      createdAt: new Date()
    })
    .returning();
  return mapModelUsageEvent(row);
}

/**
 * The user an event may name: one who exists and whose account is not being deleted. Read by
 * the statement that writes the event, so no event names a user once their deletion is marked.
 */
function attributableUser(input: ModelUsageEventRecordInput): SQL {
  if (input.userId === undefined) return drizzleSql`null`;
  return drizzleSql`(
    select ${productUsers.id} from ${productUsers}
    where ${productUsers.clientInstanceId} = ${input.clientInstanceId}
      and ${productUsers.id} = ${input.userId}
      and ${productUsers.deletionRequestedAt} is null
  )`;
}

/**
 * The workspace an event may name: the one given, else the one of the event's conversation,
 * while it exists and is not being deleted.
 */
function attributableWorkspace(input: ModelUsageEventRecordInput): SQL {
  if (input.collaborationWorkspaceId === undefined && input.conversationId === undefined)
    return drizzleSql`null`;
  const named =
    input.collaborationWorkspaceId === undefined
      ? drizzleSql`(
          select ${conversations.collaborationWorkspaceId} from ${conversations}
          where ${conversations.clientInstanceId} = ${input.clientInstanceId}
            and ${conversations.id} = ${input.conversationId}
        )`
      : drizzleSql`${input.collaborationWorkspaceId}`;
  return drizzleSql`(
    select ${collaborationWorkspaces.id} from ${collaborationWorkspaces}
    where ${collaborationWorkspaces.clientInstanceId} = ${input.clientInstanceId}
      and ${collaborationWorkspaces.id} = ${named}
      and ${collaborationWorkspaces.deletionRequestedAt} is null
  )`;
}

export async function reserveModelUsageEvent(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["reserveModelUsageEvent"]>[0]
): Promise<ModelUsageEvent> {
  const { admission, event } = input;
  if (!admission) return appendModelUsageEvent(db, event);
  return db.transaction(async (tx) => {
    // Held until the transaction ends: the next call for this budget reads this one's event.
    await tx.execute(drizzleSql`
      select pg_advisory_xact_lock(
        hashtextextended(${`model_usage_budget:${event.clientInstanceId}:${admission.budgetKey}`}, 0)
      )
    `);
    admission.decide(
      await readModelUsageBudgetUsage(tx, event.clientInstanceId, admission.windows)
    );
    return appendModelUsageEvent(tx, event);
  });
}

const costStatus = drizzleSql`${modelUsageEvents.customerBillableCost}->>'status'`;
const settled = drizzleSql`${costStatus} = 'settled'`;
const costComponent = (name: string): SQL =>
  drizzleSql`(${modelUsageEvents.customerBillableCost}->'components'->>${name})::bigint`;
// Sums leave the database as double precision: exact up to 2^53, and a number in JavaScript.
const sumOf = (value: SQL | AnyPgColumn, filter?: SQL): SQL<number> =>
  filter
    ? drizzleSql<number>`coalesce(sum(${value}) filter (where ${filter}), 0)::float8`
    : drizzleSql<number>`coalesce(sum(${value}), 0)::float8`;

/** One statement over the current month: what admission holds against the instance limits. */
async function readModelUsageBudgetUsage(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  windows: { todayStart: string; currentMonthStart?: string }
): Promise<ModelUsageBudgetUsage> {
  const today = drizzleSql`${modelUsageEvents.createdAt} >= ${windows.todayStart}::timestamptz`;
  const settledCost = drizzleSql`(${modelUsageEvents.customerBillableCost}->>'totalCostMicros')::bigint`;
  // One scan of the index on instance and creation time, from the start of the widest window.
  const [row] = await db
    .select({
      calls: drizzleSql<number>`count(*)::float8`,
      tokens: sumOf(modelUsageEvents.totalTokens),
      unsettled: drizzleSql<number>`(count(*) filter (where ${costStatus} is distinct from 'settled'))::float8`,
      cost: sumOf(settledCost, settled),
      todayCalls: drizzleSql<number>`(count(*) filter (where ${today}))::float8`,
      todayTokens: sumOf(modelUsageEvents.totalTokens, today),
      todayUnsettled: drizzleSql<number>`(count(*) filter (where ${today} and ${costStatus} is distinct from 'settled'))::float8`,
      todayCost: sumOf(settledCost, drizzleSql`${today} and ${settled}`)
    })
    .from(modelUsageEvents)
    .where(
      and(
        eq(modelUsageEvents.clientInstanceId, clientInstanceId),
        gte(modelUsageEvents.createdAt, new Date(windows.currentMonthStart ?? windows.todayStart))
      )
    );
  if (!row) throw new AppError("INTERNAL", "The database returned no usage sums");
  const window = (
    modelCallCount: number,
    totalTokens: number,
    unsettledModelCallCount: number,
    settledCostMicros: number
  ): ModelUsageBudgetWindow => ({
    modelCallCount,
    totalTokens,
    unsettledModelCallCount,
    settledCostMicros
  });
  return {
    today: window(row.todayCalls, row.todayTokens, row.todayUnsettled, row.todayCost),
    ...(windows.currentMonthStart === undefined
      ? {}
      : { currentMonth: window(row.calls, row.tokens, row.unsettled, row.cost) })
  };
}

export async function settleModelUsageEvent(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["settleModelUsageEvent"]>[0]
): Promise<ModelUsageEvent> {
  const { settlement } = input;
  const [row] = await db
    .update(modelUsageEvents)
    .set({
      inputTokens: settlement.inputTokens,
      cachedInputTokens: settlement.cachedInputTokens ?? null,
      outputTokens: settlement.outputTokens,
      totalTokens: settlement.totalTokens,
      webSearchCallCount: settlement.webSearchCallCount,
      providerServiceTier: settlement.providerServiceTier ?? null,
      source: settlement.source,
      customerBillableCost: settlement.customerBillableCost
    })
    .where(
      and(
        eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
        eq(modelUsageEvents.id, input.id)
      )
    )
    .returning();
  return mapModelUsageEvent(row);
}

const totalsColumns = {
  modelCallCount: drizzleSql<number>`count(*)::float8`,
  inputTokens: sumOf(modelUsageEvents.inputTokens),
  cachedInputTokens: sumOf(modelUsageEvents.cachedInputTokens),
  outputTokens: sumOf(modelUsageEvents.outputTokens),
  totalTokens: sumOf(modelUsageEvents.totalTokens),
  webSearchCallCount: sumOf(modelUsageEvents.webSearchCallCount),
  settledModelCallCount: drizzleSql<number>`(count(*) filter (where ${settled}))::float8`,
  uncachedInputCostMicros: sumOf(costComponent("uncachedInputCostMicros"), settled),
  cachedInputCostMicros: sumOf(costComponent("cachedInputCostMicros"), settled),
  outputCostMicros: sumOf(costComponent("outputCostMicros"), settled),
  webSearchCostMicros: sumOf(costComponent("webSearchCostMicros"), settled),
  settledCurrencyCount: drizzleSql<number>`(count(distinct ${modelUsageEvents.customerBillableCost}->>'currency') filter (where ${settled}))::float8`,
  settledCurrency: drizzleSql<
    string | null
  >`min(${modelUsageEvents.customerBillableCost}->>'currency') filter (where ${settled})`,
  settledWebSearchCallCount: sumOf(modelUsageEvents.webSearchCallCount, settled)
};

interface TotalsRow {
  modelCallCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  webSearchCallCount: number;
  settledModelCallCount: number;
  uncachedInputCostMicros: number;
  cachedInputCostMicros: number;
  outputCostMicros: number;
  webSearchCostMicros: number;
  settledCurrencyCount: number;
  settledCurrency: string | null;
  settledWebSearchCallCount: number;
}

function toTotals(row: TotalsRow): ModelUsageTotals {
  return {
    modelCallCount: row.modelCallCount,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    webSearchCallCount: row.webSearchCallCount,
    settledModelCallCount: row.settledModelCallCount,
    settledCost: {
      uncachedInputCostMicros: row.uncachedInputCostMicros,
      cachedInputCostMicros: row.cachedInputCostMicros,
      outputCostMicros: row.outputCostMicros,
      webSearchCostMicros: row.webSearchCostMicros
    },
    settledCurrencyCount: row.settledCurrencyCount,
    ...(row.settledCurrency === null ? {} : { settledCurrency: row.settledCurrency }),
    settledWebSearchCallCount: row.settledWebSearchCallCount
  };
}

// Days and months are those of UTC, as the windows of the limits are.
const utcDay = drizzleSql<string>`to_char(${modelUsageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
const utcMonth = drizzleSql<string>`to_char(${modelUsageEvents.createdAt} at time zone 'UTC', 'YYYY-MM')`;

/** Every event of the instance, read once and grouped by the database: the months and the total. */
export async function summarizeModelUsageHistory(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["summarizeModelUsageHistory"]>[0]
): Promise<ModelUsageHistory> {
  const periods = await db
    .select({
      ...totalsColumns,
      month: utcMonth,
      isTotal: drizzleSql<number>`grouping(${utcMonth})`
    })
    .from(modelUsageEvents)
    .where(eq(modelUsageEvents.clientInstanceId, input.clientInstanceId))
    .groupBy(drizzleSql`grouping sets ((), (${utcMonth}))`)
    .orderBy(utcMonth);
  const total = periods.find((row) => row.isTotal === 1);
  if (!total) throw new AppError("INTERNAL", "The database returned no usage total");
  return {
    allTime: toTotals(total),
    months: periods
      .filter((row) => row.isTotal === 0)
      .map((row) => ({ month: row.month, ...toTotals(row) }))
  };
}

/**
 * The events from `from` on, read through `model_usage_events_client_created_idx` and grouped
 * by the database: by day, and by day, model, provider, region and purpose or agent.
 */
export async function summarizeRecentModelUsage(
  db: PostgresConnection,
  input: Parameters<ModelUsageEventStore["summarizeRecentModelUsage"]>[0]
): Promise<RecentModelUsage> {
  // For one release the purpose of a call written before the column is its agent name.
  const purpose = drizzleSql<
    string | null
  >`coalesce(${modelUsageEvents.purpose}, case when ${modelUsageEvents.agentRunId} is null then ${modelUsageEvents.agentName} end)`;
  const agentName = drizzleSql<
    string | null
  >`case when ${modelUsageEvents.purpose} is null and ${modelUsageEvents.agentRunId} is not null then ${modelUsageEvents.agentName} end`;
  const attribution = [
    modelUsageEvents.model,
    modelUsageEvents.providerId,
    modelUsageEvents.region,
    purpose,
    agentName
  ];
  const groups = await db
    .select({
      ...totalsColumns,
      date: utcDay,
      model: modelUsageEvents.model,
      providerId: modelUsageEvents.providerId,
      region: modelUsageEvents.region,
      purpose,
      agentName,
      isDay: drizzleSql<number>`grouping(${modelUsageEvents.model})`
    })
    .from(modelUsageEvents)
    .where(
      and(
        eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
        gte(modelUsageEvents.createdAt, new Date(input.from))
      )
    )
    .groupBy(
      drizzleSql`grouping sets ((${utcDay}), (${utcDay}, ${drizzleSql.join(attribution, drizzleSql`, `)}))`
    )
    .orderBy(utcDay, ...attribution);
  return {
    days: groups
      .filter((row) => row.isDay === 1)
      .map((row) => ({ date: row.date, ...toTotals(row) })),
    byAttribution: groups
      .filter((row) => row.isDay === 0)
      .map((row) => ({
        date: row.date,
        model: row.model,
        providerId: row.providerId,
        ...(row.region === null ? {} : { region: row.region }),
        ...(row.purpose === null ? {} : { purpose: row.purpose }),
        ...(row.agentName === null ? {} : { agentName: row.agentName }),
        ...toTotals(row)
      }))
  };
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
    .orderBy(desc(modelUsageEvents.createdAt), desc(modelUsageEvents.id));
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
    update ${modelUsageEvents} set user_id = null
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
          when ${e}.agent_name = 'conversation_title' or ${e}.agent_run_id is null then ${e}.agent_name
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
