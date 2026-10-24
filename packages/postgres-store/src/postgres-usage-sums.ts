import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PERSONAL_WORKSPACES_KEY, type ModelUsageTotals } from "@work-shape/catalyst-core";
import { dayOf } from "./postgres-usage-counters";

// The daily sums of the usage ledger: their key, what one event adds to them, and how a read
// sums them. The ledger writes them; the reports of the Usage page read them.

export const ROLLUP_KEYS = [
  "day",
  "provider_id",
  "model",
  "region",
  "purpose",
  "agent_name",
  "workspace_key",
  "app_name",
  "workflow_name",
  "currency"
];
export const ROLLUP_SUMS = [
  "model_call_count",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "total_tokens",
  "web_search_call_count",
  "settled_model_call_count",
  "uncached_input_cost_micros",
  "cached_input_cost_micros",
  "output_cost_micros",
  "web_search_cost_micros",
  "settled_web_search_call_count"
];
export const names = (columns: readonly string[], prefix = ""): SQL =>
  drizzleSql.raw(columns.map((column) => `${prefix}${column}`).join(", "));
export const ROLLUP_COLUMNS = drizzleSql`client_instance_id, ${names(ROLLUP_KEYS)}, ${names(ROLLUP_SUMS)}`;
export const ADD_TO_ROLLUP = drizzleSql.raw(
  ROLLUP_SUMS.map((column) => `${column} = r.${column} + excluded.${column}`).join(", ")
);

/**
 * The workspace an event counts to in the sums: a shared workspace by its id, every Personal
 * Workspace as the one key `personal`, so no sum names a person (limits spec 3.4), and the
 * empty key for an event of no workspace.
 */
const workspaceKeyOf = (row: SQL): SQL => drizzleSql`coalesce((
  select case when uw.kind = 'personal' then ${PERSONAL_WORKSPACES_KEY}::text else uw.id end
  from collaboration_workspaces uw where uw.id = ${row}.collaboration_workspace_id), '')`;

/**
 * The App an event counts to: the App whose action made the call, or whose action started the
 * run the call belongs to. A Page of a conversation names no App.
 */
const appNameOf = (row: SQL): SQL => drizzleSql`coalesce(
  (select uo.origin->>'appName' from operation_runs uo
    where uo.id = ${row}.operation_run_id and uo.origin_kind = 'app'),
  (select uo.origin->>'appName' from agent_runs ur
    join agent_runs uroot on uroot.id = coalesce(ur.root_run_id, ur.id)
    join operation_runs uo on uo.id = uroot.parent_operation_run_id
    where ur.id = ${row}.agent_run_id and uo.origin_kind = 'app'),
  '')`;

/** What one event adds to the sums of its day: the key of its row there, and its amounts. */
export function rollupContribution(row: SQL): SQL {
  const settled = drizzleSql`(${row}.customer_billable_cost->>'status' = 'settled')`;
  const component = (name: string): SQL =>
    drizzleSql`case when ${settled} then coalesce((${row}.customer_billable_cost->'components'->>${name})::bigint, 0) else 0 end`;
  return drizzleSql`
    ${dayOf(drizzleSql`${row}.created_at`)} as day,
    ${row}.provider_id as provider_id,
    ${row}.model as model,
    coalesce(${row}.region, '') as region,
    coalesce(${row}.purpose, '') as purpose,
    -- A call the product made for itself carries its purpose as agent name for one release. The
    -- call of a Workflow's agent step names its agent.
    case when ${row}.purpose is null or ${row}.purpose = 'workflow_step'
      then coalesce(${row}.agent_name, '') else '' end as agent_name,
    ${workspaceKeyOf(row)} as workspace_key,
    ${appNameOf(row)} as app_name,
    coalesce((select wr.workflow from workflow_runs wr where wr.id = ${row}.workflow_run_id), '')
      as workflow_name,
    case when ${settled} then coalesce(${row}.customer_billable_cost->>'currency', '') else '' end as currency,
    1::bigint as model_call_count,
    ${row}.input_tokens::bigint as input_tokens,
    coalesce(${row}.cached_input_tokens, 0)::bigint as cached_input_tokens,
    ${row}.output_tokens::bigint as output_tokens,
    ${row}.total_tokens::bigint as total_tokens,
    ${row}.web_search_call_count::bigint as web_search_call_count,
    case when ${settled} then 1 else 0 end::bigint as settled_model_call_count,
    ${component("uncachedInputCostMicros")} as uncached_input_cost_micros,
    ${component("cachedInputCostMicros")} as cached_input_cost_micros,
    ${component("outputCostMicros")} as output_cost_micros,
    ${component("webSearchCostMicros")} as web_search_cost_micros,
    case when ${settled} then ${row}.web_search_call_count else 0 end::bigint as settled_web_search_call_count`;
}

export type TotalsRow = {
  model_call_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  web_search_call_count: number;
  settled_model_call_count: number;
  uncached_input_cost_micros: number;
  cached_input_cost_micros: number;
  output_cost_micros: number;
  web_search_cost_micros: number;
  settled_web_search_call_count: number;
  settled_currency_count: number;
  settled_currency: string | null;
};

// Sums leave the database as double precision: exact up to 2^53, and a number in JavaScript.
export const TOTALS = drizzleSql`
  ${drizzleSql.raw(ROLLUP_SUMS.map((column) => `coalesce(sum(${column}), 0)::float8 as ${column}`).join(", "))},
  (count(distinct currency) filter (where currency <> '' and settled_model_call_count > 0))::float8
    as settled_currency_count,
  min(currency) filter (where currency <> '' and settled_model_call_count > 0) as settled_currency`;

export function toTotals(row: TotalsRow): ModelUsageTotals {
  return {
    modelCallCount: row.model_call_count,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    webSearchCallCount: row.web_search_call_count,
    settledModelCallCount: row.settled_model_call_count,
    settledCost: {
      uncachedInputCostMicros: row.uncached_input_cost_micros,
      cachedInputCostMicros: row.cached_input_cost_micros,
      outputCostMicros: row.output_cost_micros,
      webSearchCostMicros: row.web_search_cost_micros
    },
    settledCurrencyCount: row.settled_currency_count,
    ...(row.settled_currency === null ? {} : { settledCurrency: row.settled_currency }),
    settledWebSearchCallCount: row.settled_web_search_call_count
  };
}
