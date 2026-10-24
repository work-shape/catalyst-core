import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  KNOWLEDGE_INGESTION_PURPOSES,
  USAGE_BREAKDOWN_DIMENSIONS,
  type ModelUsageEventStore,
  type UsageActivityCounts,
  type UsageBreakdownDimension,
  type UsageBreakdownGroup,
  type UserMonthSpend,
  type WorkspaceMemberUsage
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { modelUsageCounters, modelUsageDailyRollups } from "./schema";
import { rollupContribution, TOTALS, toTotals, type TotalsRow } from "./postgres-usage-sums";

// The reads of the Usage page (LU-3). The Overview and the Breakdown sum the daily sums and
// read no usage event; only an owner's figures per member sum the events of one workspace.

type Store = ModelUsageEventStore;

const list = (values: readonly string[]): SQL =>
  drizzleSql.join(
    values.map((value) => drizzleSql`${value}`),
    drizzleSql`, `
  );

/**
 * Where a row of the daily sums came from (limits spec 3.2), from its keys: ingestion of a
 * Knowledge Base, a call the product made for itself, a Workflow, an App, or a conversation. The
 * query of a Knowledge Base search is chat.
 */
const ORIGIN = drizzleSql`case
  when purpose in (${list(KNOWLEDGE_INGESTION_PURPOSES)}) then 'knowledge_base'
  when workflow_name <> '' or purpose = 'workflow_step' then 'workflow'
  when app_name <> '' then 'app'
  when purpose not in ('', 'knowledge_query') then 'system'
  else 'conversation'
end`;

/** The value of each dimension on a row of the daily sums. */
const DIMENSION: Record<UsageBreakdownDimension | "day" | "all", SQL> = {
  workspace: drizzleSql`workspace_key`,
  agent: drizzleSql`agent_name`,
  app: drizzleSql`app_name`,
  workflow: drizzleSql`workflow_name`,
  model: drizzleSql`model`,
  origin: ORIGIN,
  day: drizzleSql`to_char(day, 'YYYY-MM-DD')`,
  all: drizzleSql`''::text`
};

async function summarizeModelUsageBreakdown(
  db: PostgresConnection,
  input: Parameters<Store["summarizeModelUsageBreakdown"]>[0]
): Promise<UsageBreakdownGroup[]> {
  const narrowed = USAGE_BREAKDOWN_DIMENSIONS.flatMap((dimension) => {
    const value = input.filter?.[dimension];
    return value === undefined ? [] : [drizzleSql`${DIMENSION[dimension]} = ${value}`];
  });
  const key = DIMENSION[input.groupBy];
  const rows = await db.execute<TotalsRow & { key: string }>(drizzleSql`
    select ${key} as key, ${TOTALS}
    from ${modelUsageDailyRollups}
    where client_instance_id = ${input.clientInstanceId}
      and day >= ${input.from}::date and day < ${input.to}::date
      ${narrowed.length > 0 ? drizzleSql`and ${drizzleSql.join(narrowed, drizzleSql` and `)}` : drizzleSql``}
    group by 1
    order by 1
  `);
  return rows
    .filter((row) => row.model_call_count > 0)
    .map((row) => ({ key: row.key, ...toTotals(row) }));
}

async function summarizeWorkspaceMemberUsage(
  db: PostgresConnection,
  input: Parameters<Store["summarizeWorkspaceMemberUsage"]>[0]
): Promise<WorkspaceMemberUsage[]> {
  const e = drizzleSql`e`;
  // Summed as the daily sums sum them: the same contribution of each event, so a member's
  // figures add up to the workspace's row of the Breakdown.
  const rows = await db.execute<TotalsRow & { user_id: string | null }>(drizzleSql`
    select user_id, ${TOTALS}
    from (
      select ${e}.user_id, ${rollupContribution(e)}
      from model_usage_events ${e}
      where ${e}.collaboration_workspace_id = ${input.collaborationWorkspaceId}
        and ${e}.client_instance_id = ${input.clientInstanceId}
        and ${e}.created_at >= ${input.from}::timestamptz
        and ${e}.created_at < ${input.to}::timestamptz
        and ${e}.status <> 'pending'
    ) contribution
    group by user_id
    order by user_id nulls last
  `);
  return rows.map((row) => ({
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    ...toTotals(row)
  }));
}

async function countUsageActivity(
  db: PostgresConnection,
  input: Parameters<Store["countUsageActivity"]>[0]
): Promise<UsageActivityCounts> {
  const from = drizzleSql`${input.from}::timestamptz`;
  const to = drizzleSql`${input.to}::timestamptz`;
  const rows =
    input.collaborationWorkspaceId === undefined
      ? await db.execute<Record<keyof UsageActivityCounts, number>>(drizzleSql`
          select
            (select count(distinct owner_user_id) from agent_runs
              where client_instance_id = ${input.clientInstanceId}
                and started_at >= ${from} and started_at < ${to})::float8 as "activeUsers",
            (select count(*) from conversations
              where client_instance_id = ${input.clientInstanceId} and kind = 'chat'
                and created_at >= ${from} and created_at < ${to})::float8 as conversations,
            (select count(*) from agent_runs
              where client_instance_id = ${input.clientInstanceId}
                and started_at >= ${from} and started_at < ${to})::float8 as "agentRuns",
            (select count(*) from operation_runs
              where client_instance_id = ${input.clientInstanceId} and origin_kind = 'app'
                and created_at >= ${from} and created_at < ${to})::float8 as "appActionRuns",
            (select count(*) from workflow_runs
              where client_instance_id = ${input.clientInstanceId}
                and created_at >= ${from} and created_at < ${to})::float8 as "workflowRuns"
        `)
      : // A shared workspace: who and what used a model there, from its own usage events, and
        // the App actions run there from its Operation Runs.
        await db.execute<Record<keyof UsageActivityCounts, number>>(drizzleSql`
          select
            count(distinct e.user_id)::float8 as "activeUsers",
            count(distinct e.conversation_id)::float8 as conversations,
            count(distinct e.agent_run_id)::float8 as "agentRuns",
            (select count(*) from operation_runs
              where client_instance_id = ${input.clientInstanceId}
                and collaboration_workspace_id = ${input.collaborationWorkspaceId}
                and origin_kind = 'app'
                and created_at >= ${from} and created_at < ${to})::float8 as "appActionRuns",
            count(distinct e.workflow_run_id)::float8 as "workflowRuns"
          from model_usage_events e
          where e.collaboration_workspace_id = ${input.collaborationWorkspaceId}
            and e.client_instance_id = ${input.clientInstanceId}
            and e.created_at >= ${from} and e.created_at < ${to}
        `);
  const row = rows[0];
  return {
    activeUsers: row?.activeUsers ?? 0,
    conversations: row?.conversations ?? 0,
    agentRuns: row?.agentRuns ?? 0,
    appActionRuns: row?.appActionRuns ?? 0,
    workflowRuns: row?.workflowRuns ?? 0
  };
}

async function listUserMonthSpend(
  db: PostgresConnection,
  input: Parameters<Store["listUserMonthSpend"]>[0]
): Promise<UserMonthSpend[]> {
  const rows = await db.execute<{
    scope_id: string;
    cost_micros: number;
    model_call_count: number;
    tokens: number;
  }>(drizzleSql`
    select scope_id, cost_micros::float8 as cost_micros,
      model_call_count::float8 as model_call_count, tokens::float8 as tokens
    from ${modelUsageCounters}
    where client_instance_id = ${input.clientInstanceId}
      and scope_kind = 'user' and period_kind = 'month'
      and period_start = ${`${input.month}-01`}::date
      and model_call_count > 0
    order by scope_id
  `);
  return rows.map((row) => ({
    userId: row.scope_id,
    costMicros: row.cost_micros,
    modelCallCount: row.model_call_count,
    tokens: row.tokens
  }));
}

export function createPostgresUsageReports(
  db: PostgresConnection
): Pick<
  Store,
  | "summarizeModelUsageBreakdown"
  | "summarizeWorkspaceMemberUsage"
  | "countUsageActivity"
  | "listUserMonthSpend"
> {
  return {
    summarizeModelUsageBreakdown: (input) => summarizeModelUsageBreakdown(db, input),
    summarizeWorkspaceMemberUsage: (input) => summarizeWorkspaceMemberUsage(db, input),
    countUsageActivity: (input) => countUsageActivity(db, input),
    listUserMonthSpend: (input) => listUserMonthSpend(db, input)
  };
}
