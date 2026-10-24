import { sql as drizzleSql } from "drizzle-orm";
import type {
  UsageSpendAmounts,
  UsageSpendCounter,
  UsageSpendLimitLevel,
  UsageSpendLimitRecord,
  UsageSpendLimitStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { THIS_MONTH, TODAY } from "./postgres-usage-counters";
import { modelUsageCounters, usageSpendLimits } from "./schema";

type Store = UsageSpendLimitStore;

type LimitRow = {
  level: UsageSpendLimitLevel;
  user_id: string | null;
  collaboration_workspace_id: string | null;
  daily_limit_micros: string | number | null;
  monthly_limit_micros: string | number | null;
  updated_at: string | Date;
  updated_by: string | null;
};

function amountsOf(row: Pick<LimitRow, "daily_limit_micros" | "monthly_limit_micros">) {
  const amounts: UsageSpendAmounts = {};
  if (row.daily_limit_micros !== null) amounts.dailyMicros = Number(row.daily_limit_micros);
  if (row.monthly_limit_micros !== null) amounts.monthlyMicros = Number(row.monthly_limit_micros);
  return amounts;
}

/**
 * The limits one call is held against, in one statement: the instance's, the shared workspace
 * the call names or its conversation lies in, and the user's, each with its own value before
 * the default. A workspace that is being deleted or is personal has no limit.
 */
async function readSpendLimits(
  db: PostgresConnection,
  input: Parameters<Store["readSpendLimits"]>[0]
): ReturnType<Store["readSpendLimits"]> {
  const named =
    input.workspaceId === undefined
      ? drizzleSql`(
          select collaboration_workspace_id from conversations
          where client_instance_id = ${input.clientInstanceId}
            and id = ${input.conversationId ?? null}
        )`
      : drizzleSql`${input.workspaceId}`;
  const rows = await db.execute<
    Pick<LimitRow, "level" | "daily_limit_micros" | "monthly_limit_micros"> & {
      workspace_id: string | null;
    }
  >(drizzleSql`
    with workspace as (
      select id from collaboration_workspaces
      where client_instance_id = ${input.clientInstanceId} and id = ${named}
        and kind = 'shared' and deletion_requested_at is null
    )
    select l.level, l.daily_limit_micros, l.monthly_limit_micros,
      (select id from workspace) as workspace_id
    from ${usageSpendLimits} l
    where l.client_instance_id = ${input.clientInstanceId}
      and (l.level = 'instance'
        or (l.level = 'workspace_default' and exists (select 1 from workspace))
        or (l.level = 'workspace' and l.collaboration_workspace_id = (select id from workspace))
        or (l.level = 'user_default' and ${input.userId ?? null}::text is not null)
        or (l.level = 'user' and l.user_id = ${input.userId ?? null}))
    union all
    -- The workspace alone, so it is named where no limit of it is set.
    select null, null, null, id from workspace
  `);
  const of = (level: UsageSpendLimitLevel) => {
    const row = rows.find((candidate) => candidate.level === level);
    return row ? amountsOf(row) : undefined;
  };
  const workspaceId = rows.find((row) => row.workspace_id !== null)?.workspace_id ?? undefined;
  const instance = of("instance");
  const workspace = of("workspace") ?? of("workspace_default");
  const user = input.userId === undefined ? undefined : (of("user") ?? of("user_default"));
  return {
    ...(instance ? { instance } : {}),
    ...(workspaceId === undefined
      ? {}
      : { workspace: { id: workspaceId, ...(workspace ? { limits: workspace } : {}) } }),
    ...(user ? { user } : {})
  };
}

async function listSpendLimits(
  db: PostgresConnection,
  input: Parameters<Store["listSpendLimits"]>[0]
): Promise<UsageSpendLimitRecord[]> {
  const rows = await db.execute<LimitRow>(drizzleSql`
    select level, user_id, collaboration_workspace_id, daily_limit_micros, monthly_limit_micros,
      updated_at, updated_by
    from ${usageSpendLimits}
    where client_instance_id = ${input.clientInstanceId}
    order by level, coalesce(user_id, collaboration_workspace_id, '')
  `);
  return rows.map((row) => {
    const targetId = row.user_id ?? row.collaboration_workspace_id ?? undefined;
    return {
      level: row.level,
      ...(targetId === undefined ? {} : { targetId }),
      ...amountsOf(row),
      updatedAt: new Date(row.updated_at).toISOString(),
      ...(row.updated_by ? { updatedBy: row.updated_by } : {})
    };
  });
}

/**
 * Sets or removes the limit of one level in one statement and answers what it held before. The
 * row of the level is locked while it is read, so two changes of one level are told apart in
 * the audit: each names the value the other left.
 */
async function setSpendLimit(
  db: PostgresConnection,
  input: Parameters<Store["setSpendLimit"]>[0]
): ReturnType<Store["setSpendLimit"]> {
  const userId = input.level === "user" ? (input.targetId ?? null) : null;
  const workspaceId = input.level === "workspace" ? (input.targetId ?? null) : null;
  const target = drizzleSql`coalesce(user_id, collaboration_workspace_id, '') = ${
    userId ?? workspaceId ?? ""
  }`;
  return db.transaction(async (tx) => {
    const [before] = await tx.execute<
      Pick<LimitRow, "daily_limit_micros" | "monthly_limit_micros">
    >(drizzleSql`
      select daily_limit_micros, monthly_limit_micros from ${usageSpendLimits}
      where client_instance_id = ${input.clientInstanceId} and level = ${input.level} and ${target}
      for update
    `);
    if (input.limits === null) {
      await tx.execute(drizzleSql`
        delete from ${usageSpendLimits}
        where client_instance_id = ${input.clientInstanceId} and level = ${input.level}
          and ${target}
      `);
    } else {
      await tx.execute(drizzleSql`
        insert into ${usageSpendLimits} (
          client_instance_id, level, user_id, collaboration_workspace_id,
          daily_limit_micros, monthly_limit_micros, updated_at, updated_by
        ) values (
          ${input.clientInstanceId}, ${input.level}, ${userId}, ${workspaceId},
          ${input.limits.dailyMicros ?? null}::bigint, ${input.limits.monthlyMicros ?? null}::bigint,
          now(), ${input.updatedBy ?? null}
        )
        on conflict (client_instance_id, level, (coalesce(user_id, collaboration_workspace_id, '')))
        do update set
          daily_limit_micros = excluded.daily_limit_micros,
          monthly_limit_micros = excluded.monthly_limit_micros,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `);
    }
    return before ? { previous: amountsOf(before) } : {};
  });
}

/** What the counters of the current UTC day and month hold in money. */
async function readSpendCounters(
  db: PostgresConnection,
  input: Parameters<Store["readSpendCounters"]>[0]
): Promise<UsageSpendCounter[]> {
  const list = (ids: readonly string[] | undefined) =>
    ids && ids.length > 0
      ? drizzleSql.join(
          ids.map((id) => drizzleSql`${id}`),
          drizzleSql`, `
        )
      : undefined;
  const users = list(input.users);
  const workspaces = list(input.workspaces);
  const scopes = [
    drizzleSql`(c.scope_kind = 'instance' and c.scope_id = '')`,
    ...(input.all
      ? [drizzleSql`c.scope_kind in ('user', 'workspace')`]
      : [
          ...(users ? [drizzleSql`(c.scope_kind = 'user' and c.scope_id in (${users}))`] : []),
          ...(workspaces
            ? [drizzleSql`(c.scope_kind = 'workspace' and c.scope_id in (${workspaces}))`]
            : [])
        ])
  ];
  const rows = await db.execute<{
    scope_kind: UsageSpendCounter["scopeKind"];
    scope_id: string;
    period_kind: UsageSpendCounter["period"];
    cost_micros: string | number;
  }>(drizzleSql`
    select c.scope_kind, c.scope_id, c.period_kind, c.cost_micros
    from ${modelUsageCounters} c
    where c.client_instance_id = ${input.clientInstanceId}
      and ((c.period_kind = 'day' and c.period_start = ${TODAY})
        or (c.period_kind = 'month' and c.period_start = ${THIS_MONTH}))
      and (${drizzleSql.join(scopes, drizzleSql` or `)})
  `);
  return rows.map((row) => ({
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    period: row.period_kind,
    costMicros: Number(row.cost_micros)
  }));
}

export function createPostgresSpendLimitStore(db: PostgresConnection): UsageSpendLimitStore {
  return {
    readSpendLimits: (input) => readSpendLimits(db, input),
    listSpendLimits: (input) => listSpendLimits(db, input),
    setSpendLimit: (input) => setSpendLimit(db, input),
    readSpendCounters: (input) => readSpendCounters(db, input)
  };
}
