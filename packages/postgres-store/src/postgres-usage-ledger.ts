import { and, eq, sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  type AdmittedModelCall,
  type ClientInstanceId,
  type JsonObject,
  type ModelUsageCounterLimits,
  type ModelUsageEvent,
  type ModelUsageEventRecordInput,
  type ModelUsageEventStatus,
  type ModelUsageEventStore,
  type ModelUsageHistory,
  type ModelUsageRefusal,
  type ModelUsageTotals,
  type RecentModelUsage,
  AppError,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { mapModelUsageEvent } from "./rows";
import {
  modelUsageCounters,
  modelUsageDailyRollups,
  modelUsageEvents,
  modelUsageMaintenance
} from "./schema";

type Store = ModelUsageEventStore;

/** How often admission starts missing counters and asks again before it gives up. */
const COUNTER_START_ATTEMPTS = 3;

// The day and the month of the database clock, in UTC as the windows of the limits are.
const TODAY = drizzleSql`(now() at time zone 'UTC')::date`;
const THIS_MONTH = drizzleSql`date_trunc('month', now() at time zone 'UTC')::date`;
const dayOf = (createdAt: SQL): SQL => drizzleSql`(${createdAt} at time zone 'UTC')::date`;
const monthOf = (createdAt: SQL): SQL =>
  drizzleSql`date_trunc('month', ${createdAt} at time zone 'UTC')::date`;

/** The counters of the instance for a day and a month. `c` names the counter table. */
const instanceCounters = (clientInstanceId: string, day: SQL, month: SQL): SQL => drizzleSql`
  c.client_instance_id = ${clientInstanceId} and c.scope_kind = 'instance' and c.scope_id = ''
  and ((c.period_kind = 'day' and c.period_start = ${day})
    or (c.period_kind = 'month' and c.period_start = ${month}))`;

// What an event holds on its counters. An event written before the counters holds its tokens
// and its settled cost.
const countedTokens = (row: SQL): SQL =>
  drizzleSql`coalesce(${row}.counted_tokens, ${row}.total_tokens)`;
const countedCost = (row: SQL): SQL => drizzleSql`coalesce(
  ${row}.counted_cost_micros,
  case when ${row}.customer_billable_cost->>'status' = 'settled'
    then (${row}.customer_billable_cost->>'totalCostMicros')::bigint end,
  0)`;

const within = (
  limits: ModelUsageCounterLimits,
  reservation: { tokens: number; costMicros: number }
): SQL => {
  const checks: SQL[] = [drizzleSql`true`];
  if (limits.modelCallCount !== undefined)
    checks.push(drizzleSql`c.model_call_count + 1 <= ${limits.modelCallCount}::bigint`);
  if (limits.tokens !== undefined)
    checks.push(drizzleSql`c.tokens + ${reservation.tokens}::bigint <= ${limits.tokens}::bigint`);
  if (limits.costMicros !== undefined)
    checks.push(
      drizzleSql`c.cost_micros + ${reservation.costMicros}::bigint <= ${limits.costMicros}::bigint`
    );
  return drizzleSql.join(checks, drizzleSql` and `);
};

/**
 * The user and the workspace an event may name: those that exist and are not being deleted.
 * Each row is locked for the statement, so a deletion either sees the event or the event names
 * nobody: the mark of a deletion waits for the statement, and a statement that waited for a
 * mark or a delete reads the row again. `attributed_user` holds the user's row with whether
 * it is open, `attributed_workspace` the workspace while it is open.
 */
function attribution(event: ModelUsageEventRecordInput): SQL {
  const workspace =
    event.collaborationWorkspaceId === undefined
      ? drizzleSql`(
          select collaboration_workspace_id from conversations
          where client_instance_id = ${event.clientInstanceId}
            and id = ${event.conversationId ?? null}
        )`
      : drizzleSql`${event.collaborationWorkspaceId}`;
  return drizzleSql`
    attributed_user as (
      select id, deletion_requested_at is null as open from product_users
      where client_instance_id = ${event.clientInstanceId} and id = ${event.userId ?? null}
      for share
    ),
    attributed_workspace as (
      select id from collaboration_workspaces
      where client_instance_id = ${event.clientInstanceId} and id = ${workspace}
        and deletion_requested_at is null
      for share
    )`;
}

/**
 * The insert of an event. It reads `attributed_user` and `attributed_workspace`. The event of a
 * user whose account is being deleted names nothing that leads back to them: the deletion has
 * taken that off the user's events already and does not come back for this one.
 */
function insertEvent(input: {
  id: string;
  event: ModelUsageEventRecordInput;
  status: ModelUsageEventStatus;
  counted: { tokens: number; costMicros: number };
  when: SQL;
}): SQL {
  const { event } = input;
  const personal = (value: string | undefined, absent: SQL = drizzleSql`null`): SQL =>
    event.userId === undefined
      ? drizzleSql`${value ?? null}`
      : drizzleSql`case when exists (select 1 from attributed_user where not open) then ${absent} else ${value ?? null} end`;
  return drizzleSql`
    insert into model_usage_events (
      id, client_instance_id, conversation_id, agent_run_id, agent_name, purpose, provider_id,
      model, region, binding_id, input_tokens, cached_input_tokens, output_tokens, total_tokens,
      web_search_call_count, fast_mode, provider_service_tier, source, customer_billable_cost,
      user_id, collaboration_workspace_id, operation_run_id, correlation_id, status,
      counted_tokens, counted_cost_micros, created_at
    )
    select
      ${input.id}, ${event.clientInstanceId}, ${personal(event.conversationId)},
      ${personal(event.agentRunId)}, ${event.agentName ?? null}, ${event.purpose ?? null},
      ${event.providerId}, ${event.model}, ${event.region ?? null}, ${event.bindingId ?? null},
      ${event.inputTokens}::int, ${event.cachedInputTokens ?? null}::int,
      ${event.outputTokens}::int, ${event.totalTokens}::int, ${event.webSearchCallCount}::int,
      ${event.fastMode}::boolean, ${event.providerServiceTier ?? null}, ${event.source},
      ${JSON.stringify(event.customerBillableCost)}::jsonb,
      (select id from attributed_user where open), (select id from attributed_workspace),
      ${personal(event.operationRunId)}, ${personal(event.correlationId, drizzleSql`''`)},
      ${input.status}, ${input.counted.tokens}::bigint, ${input.counted.costMicros}::bigint, now()
    where ${input.when}
    returning *`;
}

const ROLLUP_KEYS = ["day", "provider_id", "model", "region", "purpose", "agent_name", "currency"];
const ROLLUP_SUMS = [
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
const names = (columns: readonly string[], prefix = ""): SQL =>
  drizzleSql.raw(columns.map((column) => `${prefix}${column}`).join(", "));
const ROLLUP_COLUMNS = drizzleSql`client_instance_id, ${names(ROLLUP_KEYS)}, ${names(ROLLUP_SUMS)}`;
const ADD_TO_ROLLUP = drizzleSql.raw(
  ROLLUP_SUMS.map((column) => `${column} = r.${column} + excluded.${column}`).join(", ")
);

/** What one event adds to the sums of its day: the key of its row there, and its amounts. */
function rollupContribution(row: SQL): SQL {
  const settled = drizzleSql`(${row}.customer_billable_cost->>'status' = 'settled')`;
  const component = (name: string): SQL =>
    drizzleSql`case when ${settled} then coalesce((${row}.customer_billable_cost->'components'->>${name})::bigint, 0) else 0 end`;
  return drizzleSql`
    ${dayOf(drizzleSql`${row}.created_at`)} as day,
    ${row}.provider_id as provider_id,
    ${row}.model as model,
    coalesce(${row}.region, '') as region,
    coalesce(${row}.purpose, '') as purpose,
    -- A call the product made for itself carries its purpose as agent name for one release.
    case when ${row}.purpose is null then coalesce(${row}.agent_name, '') else '' end as agent_name,
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

/**
 * Adds signed contributions to the sums of their days. `changes` yields the rollup columns and
 * a `sign`. Rows are written in the order of their key, so two statements never wait for each
 * other's rows in opposite order.
 */
function addToRollups(clientInstanceId: string, changes: SQL): SQL {
  const summed = drizzleSql.raw(
    ROLLUP_SUMS.map((column) => `sum(sign * ${column})::bigint`).join(", ")
  );
  return drizzleSql`
    insert into ${modelUsageDailyRollups} as r (${ROLLUP_COLUMNS})
    select ${clientInstanceId}, ${names(ROLLUP_KEYS)}, ${summed}
    from (${changes}) change
    group by ${names(ROLLUP_KEYS)}
    order by ${names(ROLLUP_KEYS)}
    on conflict on constraint model_usage_daily_rollups_pk do update set ${ADD_TO_ROLLUP}
    returning 1`;
}

type AdmissionRow = {
  present: boolean;
  admitted: boolean;
  day_calls: number | null;
  day_tokens: number | null;
  day_cost: number | null;
  month_calls: number | null;
  month_tokens: number | null;
  month_cost: number | null;
};

/**
 * The statement of admission and of an event nobody admitted. It locks the two counters of the
 * instance in a fixed order, adds to both when both exist and every limit holds, and writes
 * the event with them. The locks are held for this statement alone.
 */
async function countAndInsert(
  db: PostgresConnection,
  input: {
    id: string;
    event: ModelUsageEventRecordInput;
    status: ModelUsageEventStatus;
    counted: { tokens: number; costMicros: number };
    limits: { day: ModelUsageCounterLimits; month: ModelUsageCounterLimits };
  }
): Promise<AdmissionRow> {
  const { event, counted } = input;
  const counters = instanceCounters(event.clientInstanceId, TODAY, THIS_MONTH);
  const ended = input.status !== "pending";
  const rows = await db.execute<AdmissionRow>(drizzleSql`
    with ${attribution(event)},
    locked as (
      select c.period_kind, c.model_call_count, c.tokens, c.cost_micros,
        case c.period_kind
          when 'day' then ${within(input.limits.day, counted)}
          else ${within(input.limits.month, counted)}
        end as within
      from ${modelUsageCounters} c
      where ${counters}
        -- The rows of the user and the workspace are locked first: nothing that holds one of
        -- them may keep the counters of the instance waiting.
        and (select count(*) from attributed_user) >= 0
        and (select count(*) from attributed_workspace) >= 0
      order by c.period_kind
      for update
    ),
    verdict as (
      select count(*) = 2 as present, count(*) = 2 and coalesce(bool_and(within), false) as admitted
      from locked
    ),
    counted as (
      update ${modelUsageCounters} c set
        model_call_count = c.model_call_count + 1,
        tokens = c.tokens + ${counted.tokens}::bigint,
        cost_micros = c.cost_micros + ${counted.costMicros}::bigint
      where ${counters} and (select admitted from verdict)
      returning 1
    ),
    inserted as (
      ${insertEvent({ ...input, when: drizzleSql`(select admitted from verdict)` })}
    )
    ${
      ended
        ? drizzleSql`, rolled as (${addToRollups(
            event.clientInstanceId,
            drizzleSql`select 1 as sign, ${rollupContribution(drizzleSql`inserted`)}
              from inserted, (select count(*) from counted) after_counters`
          )})`
        : drizzleSql``
    }
    select verdict.present, verdict.admitted,
      (select model_call_count::float8 from locked where period_kind = 'day') as day_calls,
      (select tokens::float8 from locked where period_kind = 'day') as day_tokens,
      (select cost_micros::float8 from locked where period_kind = 'day') as day_cost,
      (select model_call_count::float8 from locked where period_kind = 'month') as month_calls,
      (select tokens::float8 from locked where period_kind = 'month') as month_tokens,
      (select cost_micros::float8 from locked where period_kind = 'month') as month_cost
    from verdict
  `);
  const [row] = rows;
  if (!row) throw new AppError("INTERNAL", "The database returned no admission");
  return row;
}

/**
 * Starts the counters of the current day and month that do not exist, each from the events its
 * period already has. An event of this release is written by a statement that found both
 * counters, so while one is missing no such event of its period exists, and every process
 * that starts it reads the same events: those of a previous release. The first insert stands
 * and the others change nothing. What a previous release writes after that is found by
 * reconciliation.
 */
async function startCounters(db: PostgresConnection, clientInstanceId: string): Promise<void> {
  const e = drizzleSql`e`;
  await db.execute(drizzleSql`
    insert into ${modelUsageCounters} (
      client_instance_id, scope_kind, scope_id, period_kind, period_start,
      model_call_count, tokens, cost_micros
    )
    select ${clientInstanceId}, 'instance', '', period.kind, period.first_day,
      count(${e}.id), coalesce(sum(${countedTokens(e)}), 0), coalesce(sum(${countedCost(e)}), 0)
    from (values
      ('day', ${TODAY}, ${TODAY} + 1),
      ('month', ${THIS_MONTH}, (${THIS_MONTH} + interval '1 month')::date)
    ) period(kind, first_day, next_day)
    left join model_usage_events ${e}
      on ${e}.client_instance_id = ${clientInstanceId}
      and ${e}.created_at >= period.first_day::timestamp at time zone 'UTC'
      and ${e}.created_at < period.next_day::timestamp at time zone 'UTC'
    where not exists (
      select 1 from ${modelUsageCounters} c
      where c.client_instance_id = ${clientInstanceId} and c.scope_kind = 'instance'
        and c.scope_id = '' and c.period_kind = period.kind and c.period_start = period.first_day
    )
    group by period.kind, period.first_day
    on conflict do nothing
  `);
}

async function countedInsert(
  db: PostgresConnection,
  input: Parameters<typeof countAndInsert>[1]
): Promise<AdmissionRow> {
  for (let attempt = 0; attempt < COUNTER_START_ATTEMPTS; attempt += 1) {
    const row = await countAndInsert(db, input);
    if (row.present) return row;
    await startCounters(db, input.event.clientInstanceId);
  }
  throw new AppError("INTERNAL", "The usage counters of the period could not be started");
}

export async function admitModelUsageEvent(
  db: PostgresConnection,
  input: Parameters<Store["admitModelUsageEvent"]>[0]
): ReturnType<Store["admitModelUsageEvent"]> {
  const id = createPlatformId<"ModelUsageEventId">("usage");
  const row = await countedInsert(db, {
    id,
    event: input.event,
    status: "pending",
    counted: input.reservation,
    limits: input.limits
  });
  if (row.admitted) return { id };
  return { refused: refusalOf(row, input) };
}

/** The limit that refused, in the order the limits are named in: the day first, calls first. */
function refusalOf(
  row: AdmissionRow,
  input: Parameters<Store["admitModelUsageEvent"]>[0]
): ModelUsageRefusal {
  const { limits, reservation } = input;
  const over = (held: number | null, added: number, limit: number | undefined): boolean =>
    limit !== undefined && (held ?? 0) + added > limit;
  const checks: [ModelUsageRefusal, boolean][] = [
    [
      { period: "day", metric: "modelCallCount" },
      over(row.day_calls, 1, limits.day.modelCallCount)
    ],
    [
      { period: "day", metric: "tokens" },
      over(row.day_tokens, reservation.tokens, limits.day.tokens)
    ],
    [
      { period: "day", metric: "costMicros" },
      over(row.day_cost, reservation.costMicros, limits.day.costMicros)
    ],
    [
      { period: "month", metric: "modelCallCount" },
      over(row.month_calls, 1, limits.month.modelCallCount)
    ],
    [
      { period: "month", metric: "tokens" },
      over(row.month_tokens, reservation.tokens, limits.month.tokens)
    ],
    [
      { period: "month", metric: "costMicros" },
      over(row.month_cost, reservation.costMicros, limits.month.costMicros)
    ]
  ];
  const refusal = checks.find(([, reached]) => reached)?.[0];
  if (!refusal) throw new AppError("INTERNAL", "Admission refused a call within every limit");
  return refusal;
}

export async function appendModelUsageEvent(
  db: PostgresConnection,
  event: ModelUsageEventRecordInput,
  counted?: { tokens: number; costMicros: number }
): Promise<ModelUsageEvent> {
  const id = createPlatformId<"ModelUsageEventId">("usage");
  const cost = event.customerBillableCost;
  await countedInsert(db, {
    id,
    event,
    status: "settled",
    // What it used, and what that cost where the cost is settled.
    counted: counted ?? {
      tokens: event.totalTokens,
      costMicros: cost.status === "settled" ? cost.totalCostMicros : 0
    },
    limits: { day: {}, month: {} }
  });
  const [row] = await db
    .select()
    .from(modelUsageEvents)
    .where(
      and(
        eq(modelUsageEvents.clientInstanceId, event.clientInstanceId),
        eq(modelUsageEvents.id, id)
      )
    );
  return mapModelUsageEvent(row);
}

/**
 * One statement. It locks the event, then the counters of the event's day and month in the
 * order admission locks them, then writes: the event, the difference on the counters, and the
 * event's part in the sums of its day. An event that was `abandoned` is in those sums already
 * as a call that used nothing, so that part is taken out again.
 */
export async function settleModelUsageEvent(
  db: PostgresConnection,
  input: Parameters<Store["settleModelUsageEvent"]>[0]
): Promise<boolean> {
  const { settlement, counted } = input;
  const old = drizzleSql`old`;
  const counters = instanceCounters(
    input.clientInstanceId,
    dayOf(drizzleSql`old.created_at`),
    monthOf(drizzleSql`old.created_at`)
  );
  const from = drizzleSql.join(
    input.from.map((status) => drizzleSql`${status}`),
    drizzleSql`, `
  );
  const rows = await db.execute<{ changed: number }>(drizzleSql`
    with old as (
      select * from model_usage_events
      where client_instance_id = ${input.clientInstanceId} and id = ${input.id}
        and status in (${from})
      for update
    ),
    locked as (
      select 1 from ${modelUsageCounters} c, old
      where ${counters}
      order by c.period_kind
      for update of c
    ),
    settled as (
      update model_usage_events e set
        input_tokens = ${settlement.inputTokens}::int,
        cached_input_tokens = ${settlement.cachedInputTokens ?? null}::int,
        output_tokens = ${settlement.outputTokens}::int,
        total_tokens = ${settlement.totalTokens}::int,
        web_search_call_count = ${settlement.webSearchCallCount}::int,
        provider_service_tier = ${settlement.providerServiceTier ?? null},
        source = ${settlement.source},
        customer_billable_cost = ${JSON.stringify(settlement.customerBillableCost)}::jsonb,
        status = ${input.status},
        counted_tokens = ${counted.tokens}::bigint,
        counted_cost_micros = ${counted.costMicros}::bigint
      from old
      where e.id = old.id and (select count(*) from locked) >= 0
      returning e.*
    ),
    counted as (
      update ${modelUsageCounters} c set
        tokens = c.tokens + ${counted.tokens}::bigint - ${countedTokens(old)},
        cost_micros = c.cost_micros + ${counted.costMicros}::bigint - ${countedCost(old)}
      from old
      where ${counters} and (select count(*) from settled) >= 0
      returning 1
    ),
    rolled as (${addToRollups(
      input.clientInstanceId,
      drizzleSql`
        select -1 as sign, ${rollupContribution(old)}
        from old, (select count(*) from counted) after_counters
        where old.status <> 'pending'
        union all
        select 1 as sign, ${rollupContribution(drizzleSql`settled`)}
        from settled, (select count(*) from counted) after_counters`
    )})
    select count(*)::int as changed from settled
  `);
  return (rows[0]?.changed ?? 0) > 0;
}

export async function listPendingModelUsageEvents(
  db: PostgresConnection,
  input: Parameters<Store["listPendingModelUsageEvents"]>[0]
): Promise<AdmittedModelCall[]> {
  const rows = await db
    .select()
    .from(modelUsageEvents)
    .where(
      and(
        eq(modelUsageEvents.clientInstanceId, input.clientInstanceId),
        eq(modelUsageEvents.status, "pending"),
        drizzleSql`${modelUsageEvents.createdAt} < now() - make_interval(secs => ${input.olderThanMs / 1000}::float8)`
      )
    )
    .orderBy(modelUsageEvents.createdAt)
    .limit(input.limit);
  return rows.map((row) => {
    const event = mapModelUsageEvent(row);
    return {
      id: event.id,
      clientInstanceId: event.clientInstanceId,
      providerId: event.providerId,
      model: event.model,
      fastMode: event.fastMode,
      reserved: { tokens: row.countedTokens ?? 0, costMicros: row.countedCostMicros ?? 0 }
    };
  });
}

type TotalsRow = {
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
const TOTALS = drizzleSql`
  ${drizzleSql.raw(ROLLUP_SUMS.map((column) => `coalesce(sum(${column}), 0)::float8 as ${column}`).join(", "))},
  (count(distinct currency) filter (where currency <> '' and settled_model_call_count > 0))::float8
    as settled_currency_count,
  min(currency) filter (where currency <> '' and settled_model_call_count > 0) as settled_currency`;

function toTotals(row: TotalsRow): ModelUsageTotals {
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

/** The months and the total of the instance, from the sums of its days. */
export async function summarizeModelUsageHistory(
  db: PostgresConnection,
  input: Parameters<Store["summarizeModelUsageHistory"]>[0]
): Promise<ModelUsageHistory> {
  const rows = await db.execute<TotalsRow & { month: string | null; is_total: number }>(drizzleSql`
    select to_char(day, 'YYYY-MM') as month, grouping(to_char(day, 'YYYY-MM')) as is_total, ${TOTALS}
    from ${modelUsageDailyRollups}
    where client_instance_id = ${input.clientInstanceId}
    group by grouping sets ((), (to_char(day, 'YYYY-MM')))
    order by 1
  `);
  const total = rows.find((row) => row.is_total === 1);
  if (!total) throw new AppError("INTERNAL", "The database returned no usage total");
  return {
    allTime: toTotals(total),
    months: rows.flatMap((row) =>
      row.is_total === 0 && row.month !== null && row.model_call_count > 0
        ? [{ month: row.month, ...toTotals(row) }]
        : []
    )
  };
}

type RecentRow = TotalsRow & {
  date: string;
  model: string | null;
  provider_id: string | null;
  region: string | null;
  purpose: string | null;
  agent_name: string | null;
  is_day: number;
};

/** The days from `from` on: each in total, and split by model, provider, region and caller. */
export async function summarizeRecentModelUsage(
  db: PostgresConnection,
  input: Parameters<Store["summarizeRecentModelUsage"]>[0]
): Promise<RecentModelUsage> {
  const rows = await db.execute<RecentRow>(drizzleSql`
    select to_char(day, 'YYYY-MM-DD') as date, model, provider_id, region, purpose, agent_name,
      grouping(model) as is_day, ${TOTALS}
    from ${modelUsageDailyRollups}
    where client_instance_id = ${input.clientInstanceId}
      and day >= (${input.from}::timestamptz at time zone 'UTC')::date
    group by grouping sets ((day), (day, model, provider_id, region, purpose, agent_name))
    order by day, model, provider_id, region, purpose, agent_name
  `);
  const used = rows.filter((row) => row.model_call_count > 0);
  return {
    days: used
      .filter((row) => row.is_day === 1)
      .map((row) => ({ date: row.date, ...toTotals(row) })),
    byAttribution: used.flatMap((row) =>
      row.is_day === 0 && row.model !== null && row.provider_id !== null
        ? [
            {
              date: row.date,
              model: row.model,
              providerId: row.provider_id,
              ...(row.region ? { region: row.region } : {}),
              ...(row.purpose ? { purpose: row.purpose } : {}),
              ...(row.agent_name ? { agentName: row.agent_name } : {}),
              ...toTotals(row)
            }
          ]
        : []
    )
  };
}

/**
 * One reconciliation at a time per instance. A correction is the difference a reconciler read,
 * added: two that read the same difference would add it twice. Each takes this lock before it
 * reads and holds it until its transaction ends, so the next reads what the one before wrote.
 * Only reconcilers take it. Admission and settlement never do, and wait for no reconciler
 * longer than the one statement in which it updates a counter or a sum.
 */
const reconciliationLock = (clientInstanceId: string): SQL =>
  drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`model_usage_reconciliation:${clientInstanceId}`}, 0))`;

export function reconcileModelUsage(
  db: PostgresConnection,
  input: Parameters<Store["reconcileModelUsage"]>[0]
): ReturnType<Store["reconcileModelUsage"]> {
  // Inside the caller's transaction this is a savepoint, and the lock lasts until the caller
  // commits: the correction and what the caller records about it become visible together.
  return db.transaction(async (tx) => {
    await tx.execute(reconciliationLock(input.clientInstanceId));
    return reconcileLocked(tx, input);
  });
}

async function reconcileLocked(
  db: PostgresConnection,
  input: Parameters<Store["reconcileModelUsage"]>[0]
): ReturnType<Store["reconcileModelUsage"]> {
  const e = drizzleSql`e`;
  // What each counter holds beyond its events. One statement, so one snapshot: a call writes
  // its event and its counters in one transaction, and the snapshot has both or neither.
  const drifts = await db.execute<{
    period_kind: string;
    period_start: string;
    calls: number;
    tokens: number;
    cost: number;
  }>(drizzleSql`
    select c.period_kind, c.period_start::text as period_start,
      (c.model_call_count - ledger.calls)::float8 as calls,
      (c.tokens - ledger.tokens)::float8 as tokens,
      (c.cost_micros - ledger.cost)::float8 as cost
    from ${modelUsageCounters} c
    cross join lateral (
      select count(*) as calls,
        coalesce(sum(${countedTokens(e)}), 0) as tokens,
        coalesce(sum(${countedCost(e)}), 0) as cost
      from model_usage_events ${e}
      where ${e}.client_instance_id = c.client_instance_id
        and ${e}.created_at >= c.period_start::timestamp at time zone 'UTC'
        and ${e}.created_at < (c.period_start
          + case c.period_kind when 'day' then interval '1 day' else interval '1 month' end
        )::timestamp at time zone 'UTC'
    ) ledger
    where ${instanceCounters(input.clientInstanceId, TODAY, THIS_MONTH)}
    order by c.period_kind
  `);
  let correctedCounters = 0;
  for (const drift of drifts) {
    if (drift.calls === 0 && drift.tokens === 0 && drift.cost === 0) continue;
    // Added, not set: what was admitted or ended since the snapshot stays counted.
    await db.execute(drizzleSql`
      update ${modelUsageCounters} set
        model_call_count = model_call_count - ${drift.calls}::bigint,
        tokens = tokens - ${drift.tokens}::bigint,
        cost_micros = cost_micros - ${drift.cost}::bigint
      where client_instance_id = ${input.clientInstanceId} and scope_kind = 'instance'
        and scope_id = '' and period_kind = ${drift.period_kind}
        and period_start = ${drift.period_start}::date
    `);
    correctedCounters += 1;
  }

  // From the month of yesterday, or of `since` where that is earlier: what a process of the
  // previous release wrote while no reconciliation ran lies after the last one.
  const since =
    input.since === undefined
      ? drizzleSql`now()`
      : drizzleSql`least(now(), ${input.since}::timestamptz)`;
  const from = drizzleSql`date_trunc('month', (${since} - interval '1 day') at time zone 'UTC')`;
  const eventsFrom =
    input.scope === "all"
      ? drizzleSql``
      : drizzleSql`and ${e}.created_at >= ${from}::timestamp at time zone 'UTC'`;
  const rollupsFrom = input.scope === "all" ? drizzleSql`` : drizzleSql`and day >= ${from}::date`;
  const same = drizzleSql.raw(
    ROLLUP_KEYS.map((key) => `ledger.${key} = kept.${key}`).join(" and ")
  );
  const keys = drizzleSql.raw(
    ROLLUP_KEYS.map((key) => `coalesce(ledger.${key}, kept.${key}) as ${key}`).join(", ")
  );
  const differences = drizzleSql.raw(
    ROLLUP_SUMS.map(
      (column) => `coalesce(ledger.${column}, 0) - coalesce(kept.${column}, 0) as ${column}`
    ).join(", ")
  );
  const differs = drizzleSql.raw(
    ROLLUP_SUMS.map(
      (column) => `coalesce(ledger.${column}, 0) <> coalesce(kept.${column}, 0)`
    ).join(" or ")
  );
  const ledgerSums = drizzleSql.raw(
    ROLLUP_SUMS.map((column) => `sum(${column})::bigint as ${column}`).join(", ")
  );
  // The same on the sums of the days: the events and the sums are read on one snapshot, and
  // the difference is added.
  const corrected = await db.execute(
    addToRollups(
      input.clientInstanceId,
      drizzleSql`
        select 1 as sign, ${keys}, ${differences}
        from (
          select ${names(ROLLUP_KEYS)}, ${ledgerSums}
          from (
            select ${rollupContribution(e)} from model_usage_events ${e}
            where ${e}.client_instance_id = ${input.clientInstanceId}
              and ${e}.status <> 'pending' ${eventsFrom}
          ) contribution
          group by ${names(ROLLUP_KEYS)}
        ) ledger
        full join (
          select * from ${modelUsageDailyRollups}
          where client_instance_id = ${input.clientInstanceId} ${rollupsFrom}
        ) kept on ${same}
        where ${differs}`
    )
  );
  return { correctedCounters, correctedSums: corrected.count };
}

export async function readModelUsageMaintenance(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; task: string }
): Promise<JsonObject | undefined> {
  const [row] = await db
    .select({ state: modelUsageMaintenance.state })
    .from(modelUsageMaintenance)
    .where(
      and(
        eq(modelUsageMaintenance.clientInstanceId, input.clientInstanceId),
        eq(modelUsageMaintenance.task, input.task)
      )
    );
  return row?.state;
}

export async function writeModelUsageMaintenance(
  db: PostgresConnection,
  input: { clientInstanceId: ClientInstanceId; task: string; state: JsonObject }
): Promise<void> {
  await db
    .insert(modelUsageMaintenance)
    .values({ ...input, updatedAt: drizzleSql`now()` })
    .onConflictDoUpdate({
      target: [modelUsageMaintenance.clientInstanceId, modelUsageMaintenance.task],
      set: { state: input.state, updatedAt: drizzleSql`now()` }
    });
}
