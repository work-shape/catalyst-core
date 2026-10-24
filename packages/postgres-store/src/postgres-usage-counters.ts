import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  KNOWLEDGE_INGESTION_PURPOSES,
  type ModelSystemPurpose,
  type ModelUsageCounterLimits,
  type ModelUsageLimits,
  type ModelUsagePeriodLimits,
  type ModelUsageRefusal
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { modelUsageCounters } from "./schema";

/**
 * The counters a chat usage event is held on. Knowledge Base ingestion counts on none
 * (KB-ISO, limits spec section 3.1). Every chat event counts on the instance (`instance`, '').
 * An event of a person counts on that person: their own calls on (`user`, their id), the calls
 * the product made for them on (`system`, their id). An event of no person counts on the shared
 * (`system`, ''): a call of a service principal or of a person whose account is being deleted.
 * An event the deletion of an account has erased, no person and an empty correlation id, counts
 * on the instance only: what a person used never becomes the shared bucket's. No new event is
 * written with an empty correlation id, so a fresh call cannot pass for an erased one.
 *
 * The scope is read from the event row each time, by admission from what it writes and by
 * settlement, recovery and reconciliation from what is stored, so all of them name the same
 * counters. The deletion of an account removes the person's counters in the statement that
 * takes the person off their events.
 */
export type CounterScope = { kind: "user" | "system"; id: string };

/** The purposes a person's own call carries: the query of a Knowledge Base search is chat. */
const PERSON_OWN_PURPOSES: readonly ModelSystemPurpose[] = ["knowledge_query"];

// The day and the month of the database clock, in UTC as the windows of the limits are.
export const TODAY = drizzleSql`(now() at time zone 'UTC')::date`;
export const THIS_MONTH = drizzleSql`date_trunc('month', now() at time zone 'UTC')::date`;
export const dayOf = (createdAt: SQL): SQL => drizzleSql`(${createdAt} at time zone 'UTC')::date`;
export const monthOf = (createdAt: SQL): SQL =>
  drizzleSql`date_trunc('month', ${createdAt} at time zone 'UTC')::date`;

/**
 * The kind of the scope counter of an event row with `user_id`, `purpose` and `correlation_id`;
 * null for an erased event, which has none.
 */
export const scopeKindOf = (row: SQL): SQL => drizzleSql`case
  when ${row}.user_id is not null and (${row}.purpose is null or ${row}.purpose in (${drizzleSql.join(
    PERSON_OWN_PURPOSES.map((purpose) => drizzleSql`${purpose}`),
    drizzleSql`, `
  )})) then 'user'
  when ${row}.user_id is not null or ${row}.correlation_id <> '' then 'system'
end`;
export const scopeIdOf = (row: SQL): SQL => drizzleSql`coalesce(${row}.user_id, '')`;

/** Ingestion is recorded separately from chat counters, including while history is rebuilt. */
const countsAsChat = (purpose: SQL): SQL => drizzleSql`(
  ${purpose} is null or ${purpose} not in (${drizzleSql.join(
    KNOWLEDGE_INGESTION_PURPOSES.map((value) => drizzleSql`${value}`),
    drizzleSql`, `
  )})
)`;

/**
 * The counters of the instance, of one scope and of the event's workspace for a day and a
 * month. `c` names the counter table. Only a shared workspace has counters (`workspace`, its
 * id), so `workspace` may name any workspace or none: a Personal Workspace matches no row.
 */
export const countersOf = (
  clientInstanceId: string,
  scope: { kind: SQL; id: SQL; purpose: SQL; workspace: SQL },
  day: SQL,
  month: SQL
): SQL => drizzleSql`
  c.client_instance_id = ${clientInstanceId}
  and ${countsAsChat(scope.purpose)}
  and ((c.scope_kind = 'instance' and c.scope_id = '')
    or (c.scope_kind = ${scope.kind} and c.scope_id = ${scope.id})
    or (c.scope_kind = 'workspace' and c.scope_id = ${scope.workspace}))
  and ((c.period_kind = 'day' and c.period_start = ${day})
    or (c.period_kind = 'month' and c.period_start = ${month}))`;

/** The order every statement locks counters in, so two never wait for each other. */
export const COUNTER_LOCK_ORDER = drizzleSql`c.scope_kind, c.scope_id, c.period_kind`;

// What an event holds on its counters. An event written before the counters holds its tokens
// and its settled cost.
export const countedTokens = (row: SQL): SQL =>
  drizzleSql`coalesce(${row}.counted_tokens, ${row}.total_tokens)`;
export const countedCost = (row: SQL): SQL => drizzleSql`coalesce(
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

const NO_PERIOD_LIMITS: ModelUsagePeriodLimits = { day: {}, month: {} };

/**
 * Whether counter `c` still holds once the reservation is added, by the limits of its scope.
 * `continuing` is true for a call of an agent run that already made one: the spend limits of
 * the person and the workspace do not stop it (`ModelUsageLimits.own`).
 */
export function withinLimits(
  limits: ModelUsageLimits,
  reservation: { tokens: number; costMicros: number },
  continuing: SQL = drizzleSql`false`
): SQL {
  const byPeriod = (scope: ModelUsagePeriodLimits): SQL => drizzleSql`
    case c.period_kind when 'day' then ${within(scope.day, reservation)}
      else ${within(scope.month, reservation)} end`;
  return drizzleSql`case
    when c.scope_kind = 'instance' then ${byPeriod(limits.instance)}
    when c.scope_kind = 'system' and c.scope_id = '' then ${byPeriod(limits.unattended)}
    when c.scope_kind = 'workspace'
      then (${continuing} or ${byPeriod(limits.workspace ?? NO_PERIOD_LIMITS)})
    when c.scope_kind = 'user' then ${byPeriod(limits.person)}
      and (${continuing} or ${byPeriod(limits.own ?? NO_PERIOD_LIMITS)})
    else ${byPeriod(limits.person)}
  end`;
}

/** What a counter held when admission looked at it. Its kind is the scope a refusal names. */
export interface LockedCounter {
  scope_kind: ModelUsageRefusal["scope"];
  scope_id: string;
  period_kind: ModelUsageRefusal["period"];
  model_call_count: number;
  tokens: number;
  cost_micros: number;
}

/**
 * The limit that refused, in the order the limits are named in: the day first, calls first,
 * and of one metric the scope's counter before the instance's.
 */
export function refusalOf(
  counters: readonly LockedCounter[],
  limits: ModelUsageLimits,
  reservation: { tokens: number; costMicros: number },
  continuing = false
): ModelUsageRefusal | undefined {
  const scoped = [...counters].sort(
    (a, b) => Number(a.scope_kind === "instance") - Number(b.scope_kind === "instance")
  );
  const added = { modelCallCount: 1, ...reservation };
  for (const period of ["day", "month"] as const) {
    for (const metric of ["modelCallCount", "tokens", "costMicros"] as const) {
      for (const counter of scoped) {
        if (counter.period_kind !== period) continue;
        const held = {
          modelCallCount: counter.model_call_count,
          tokens: counter.tokens,
          costMicros: counter.cost_micros
        }[metric];
        for (const scope of limitsOf(limits, counter, continuing)) {
          const limit = scope[period][metric];
          if (limit !== undefined && held + added[metric] > limit)
            return { period, metric, scope: counter.scope_kind };
        }
      }
    }
  }
  return undefined;
}

/** The limits a counter is held against, as `withinLimits` holds it. */
function limitsOf(
  limits: ModelUsageLimits,
  counter: LockedCounter,
  continuing: boolean
): ModelUsagePeriodLimits[] {
  if (counter.scope_kind === "instance") return [limits.instance];
  if (counter.scope_kind === "system" && counter.scope_id === "") return [limits.unattended];
  if (counter.scope_kind === "workspace")
    return continuing || !limits.workspace ? [] : [limits.workspace];
  if (counter.scope_kind === "user")
    return continuing || !limits.own ? [limits.person] : [limits.person, limits.own];
  return [limits.person];
}

/**
 * Starts the counters of the current day and month that do not exist. Those of the instance
 * and the shared ones start from the events their period already has: an event of this
 * release is written by a statement that found its counters, so while one is missing no such
 * event of its period exists, and every process that starts it reads the same events, those of
 * a previous release. The first insert stands and the others change nothing.
 *
 * A person's counters start at zero, so starting one never reads a person's events. The only
 * events they miss are those a previous release wrote in the period, before it counted by
 * scope; reconciliation adds them. A shared workspace's counters start from the events its
 * period already has, as the instance's do: it has no counter before this release.
 */
export async function startCounters(
  db: PostgresConnection,
  clientInstanceId: string,
  scope: CounterScope,
  workspaceId?: string
): Promise<void> {
  const e = drizzleSql`e`;
  const periods = drizzleSql`(values
    ('day', ${TODAY}, ${TODAY} + 1),
    ('month', ${THIS_MONTH}, (${THIS_MONTH} + interval '1 month')::date)
  ) period(kind, first_day, next_day)`;
  const missing = (kind: string, id: string): SQL => drizzleSql`not exists (
    select 1 from ${modelUsageCounters} c
    where c.client_instance_id = ${clientInstanceId} and c.scope_kind = ${kind}
      and c.scope_id = ${id} and c.period_kind = period.kind and c.period_start = period.first_day
  )`;
  const fromEvents = (kind: string, events: SQL, id = ""): SQL => drizzleSql`
    select ${clientInstanceId}, ${kind}, ${id}, period.kind, period.first_day,
      count(${e}.id), coalesce(sum(${countedTokens(e)}), 0), coalesce(sum(${countedCost(e)}), 0)
    from ${periods}
    left join model_usage_events ${e}
      on ${e}.client_instance_id = ${clientInstanceId}
      and ${e}.created_at >= period.first_day::timestamp at time zone 'UTC'
      and ${e}.created_at < period.next_day::timestamp at time zone 'UTC'
      and ${countsAsChat(drizzleSql`${e}.purpose`)}
      and ${events}
    where ${missing(kind, id)}
    group by period.kind, period.first_day`;
  const scoped =
    scope.id === ""
      ? fromEvents(scope.kind, drizzleSql`${e}.user_id is null and ${e}.correlation_id <> ''`)
      : drizzleSql`
        select ${clientInstanceId}, ${scope.kind}, ${scope.id}, period.kind, period.first_day,
          0, 0, 0
        from ${periods}
        where ${missing(scope.kind, scope.id)}`;
  await db.execute(drizzleSql`
    insert into ${modelUsageCounters} (
      client_instance_id, scope_kind, scope_id, period_kind, period_start,
      model_call_count, tokens, cost_micros
    )
    ${fromEvents("instance", drizzleSql`true`)}
    union all
    ${scoped}
    ${
      workspaceId === undefined
        ? drizzleSql``
        : drizzleSql`union all ${fromEvents(
            "workspace",
            drizzleSql`${e}.collaboration_workspace_id = ${workspaceId}`,
            workspaceId
          )}`
    }
    on conflict do nothing
  `);
}

/**
 * Compares every counter of the current day and month with the usage events of its scope, in
 * one statement on one snapshot, and adds the difference, so calls that are admitted or end
 * meanwhile stay counted. It reads the events of the month once. A counter of a scope is
 * needed for its own period only: those of earlier periods are removed, so no row says how
 * much one person used on a day past. Resolves with how many counters it corrected.
 *
 * The counters it changes or removes are locked first, in `COUNTER_LOCK_ORDER` and then by
 * period, the order admission and settlement lock theirs in, so it never holds one counter
 * while it waits for an earlier one. The difference is read from the snapshot, not from the
 * locked rows: a call admitted while it waited is in the locked row but not in the events it
 * read, and is kept because the update adds the difference to the row as it is then.
 */
export async function reconcileCounters(
  db: PostgresConnection,
  clientInstanceId: string
): Promise<number> {
  const e = drizzleSql`e`;
  const thisPeriod = drizzleSql`((c.period_kind = 'day' and c.period_start = ${TODAY})
    or (c.period_kind = 'month' and c.period_start = ${THIS_MONTH}))`;
  const pastPeriod = drizzleSql`c.scope_kind <> 'instance'
    and ((c.period_kind = 'day' and c.period_start < ${TODAY})
      or (c.period_kind = 'month' and c.period_start < ${THIS_MONTH}))`;
  const sameCounter = drizzleSql`c.scope_kind = drift.scope_kind and c.scope_id = drift.scope_id
    and c.period_kind = drift.period_kind and c.period_start = drift.period_start`;
  const rows = await db.execute<{ corrected: number }>(drizzleSql`
    with ledger as (
      select scope.kind, scope.id, period.kind as period_kind, period.first_day,
        count(*) as calls,
        coalesce(sum(${countedTokens(e)}), 0) as tokens,
        coalesce(sum(${countedCost(e)}), 0) as cost
      from model_usage_events ${e}
      cross join lateral (values ('instance', ''), (${scopeKindOf(e)}, ${scopeIdOf(e)}),
        -- Only a shared workspace has counters; the events of any other match none.
        (case when ${e}.collaboration_workspace_id is not null then 'workspace' end,
          coalesce(${e}.collaboration_workspace_id, '')))
        scope(kind, id)
      cross join lateral (values ('month', ${THIS_MONTH}), ('day', ${TODAY}))
        period(kind, first_day)
      where ${e}.client_instance_id = ${clientInstanceId}
        and ${countsAsChat(drizzleSql`${e}.purpose`)}
        and ${e}.created_at >= ${THIS_MONTH}::timestamp at time zone 'UTC'
        and (period.kind = 'month' or ${dayOf(drizzleSql`${e}.created_at`)} = ${TODAY})
        -- An erased event has no scope of its own.
        and scope.kind is not null
      group by scope.kind, scope.id, period.kind, period.first_day
    ),
    drift as (
      select c.scope_kind, c.scope_id, c.period_kind, c.period_start,
        c.model_call_count - coalesce(ledger.calls, 0) as calls,
        c.tokens - coalesce(ledger.tokens, 0) as tokens,
        c.cost_micros - coalesce(ledger.cost, 0) as cost
      from ${modelUsageCounters} c
      left join ledger on ledger.kind = c.scope_kind and ledger.id = c.scope_id
        and ledger.period_kind = c.period_kind and ledger.first_day = c.period_start
      where c.client_instance_id = ${clientInstanceId} and ${thisPeriod}
    ),
    locked as (
      select 1 from ${modelUsageCounters} c
      left join drift on ${sameCounter}
      where c.client_instance_id = ${clientInstanceId}
        and ((${thisPeriod} and (drift.calls <> 0 or drift.tokens <> 0 or drift.cost <> 0))
          or (${pastPeriod}))
      order by ${COUNTER_LOCK_ORDER}, c.period_start
      for update of c
    ),
    corrected as (
      -- Added, not set: what was admitted or ended since the snapshot stays counted.
      update ${modelUsageCounters} c set
        model_call_count = c.model_call_count - drift.calls,
        tokens = c.tokens - drift.tokens,
        cost_micros = c.cost_micros - drift.cost
      from drift
      where c.client_instance_id = ${clientInstanceId} and ${sameCounter}
        and (drift.calls <> 0 or drift.tokens <> 0 or drift.cost <> 0)
        and (select count(*) from locked) >= 0
      returning 1
    ),
    removed as (
      delete from ${modelUsageCounters} c
      where c.client_instance_id = ${clientInstanceId} and ${pastPeriod}
        and (select count(*) from locked) >= 0
      returning 1
    )
    select (select count(*) from corrected)::int as corrected, (select count(*) from removed)
  `);
  return rows[0]?.corrected ?? 0;
}

/**
 * The part of a statement that takes a person off their usage events: after the events
 * `cleared` yields are locked and changed, it locks the person's counters in
 * `COUNTER_LOCK_ORDER` and removes them. What the events held stays on the instance's
 * counters; it is no longer any person's, and it is not the shared bucket's either, since
 * those calls were not made for nobody.
 */
export const removePersonCounters = (clientInstanceId: string, userId: string): SQL => {
  const person = drizzleSql`c.client_instance_id = ${clientInstanceId}
    and c.scope_kind in ('user', 'system') and c.scope_id = ${userId}`;
  return drizzleSql`
    person_counters as (
      select 1 from ${modelUsageCounters} c
      where ${person} and (select count(*) from cleared) >= 0
      order by ${COUNTER_LOCK_ORDER}, c.period_start
      for update of c
    ),
    removed as (
      delete from ${modelUsageCounters} c
      where ${person} and (select count(*) from person_counters) >= 0
    )`;
};
