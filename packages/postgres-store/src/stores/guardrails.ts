import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import {
  createPlatformId,
  type GuardrailDryRunSubject,
  type GuardrailHit,
  type GuardrailStore,
  type ShippedGuardrailSwitch
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { guardrailHits, shippedGuardrailSwitches } from "../schema/guardrails";

/** The only code that reads or writes `guardrail_hits`. */
export function createPostgresGuardrailsStore(db: PostgresConnection): GuardrailStore {
  return {
    async lockReleaseSeed({ clientInstanceId }) {
      // Held until the transaction ends. Outside of one it would be released at once, which
      // the caller's use inside `transaction` rules out.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`guardrails_release_seed:${clientInstanceId}`}, 0))`
      );
    },
    async recordHits({ clientInstanceId, hits }) {
      if (hits.length === 0) return;
      await db.insert(guardrailHits).values(
        hits.map((hit) => ({
          id: createPlatformId("ghit"),
          clientInstanceId,
          guardrailName: hit.guardrailName,
          event: hit.event,
          outcome: hit.outcome,
          message: hit.message,
          subjectKind: hit.subjectKind,
          subjectId: hit.subjectId ?? null,
          subjectName: hit.subjectName ?? null,
          convertedFrom: hit.convertedFrom ?? null
        }))
      );
    },
    async listShippedGuardrailSwitches({ clientInstanceId }) {
      const rows = await db
        .select()
        .from(shippedGuardrailSwitches)
        .where(eq(shippedGuardrailSwitches.clientInstanceId, clientInstanceId));
      return rows.map(switchOf);
    },
    async switchShippedGuardrail({ clientInstanceId, name, enabled, switchedBy, switchedAt }) {
      const values = {
        enabled,
        switchedById: switchedBy.id,
        switchedByLabel: switchedBy.label,
        switchedAt: new Date(switchedAt)
      };
      const [row] = await db
        .insert(shippedGuardrailSwitches)
        .values({ clientInstanceId, guardrailName: name, ...values })
        .onConflictDoUpdate({
          target: [
            shippedGuardrailSwitches.clientInstanceId,
            shippedGuardrailSwitches.guardrailName
          ],
          set: values
        })
        .returning();
      if (!row) throw new Error(`Shipped guardrail '${name}' was not switched`);
      return switchOf(row);
    },
    async listHits({ clientInstanceId, guardrailName, limit }) {
      const rows = await db
        .select()
        .from(guardrailHits)
        .where(
          and(
            eq(guardrailHits.clientInstanceId, clientInstanceId),
            eq(guardrailHits.guardrailName, guardrailName)
          )
        )
        .orderBy(desc(guardrailHits.createdAt), desc(guardrailHits.id))
        .limit(limit);
      return rows.map((row): GuardrailHit => ({
        id: row.id,
        guardrailName: row.guardrailName,
        event: row.event,
        outcome: row.outcome,
        message: row.message,
        subjectKind: row.subjectKind,
        ...(row.subjectId === null ? {} : { subjectId: row.subjectId }),
        ...(row.subjectName === null ? {} : { subjectName: row.subjectName }),
        ...(row.convertedFrom === null ? {} : { convertedFrom: row.convertedFrom }),
        createdAt: row.createdAt.toISOString()
      }));
    },
    async countHits({ clientInstanceId, guardrailName }) {
      // The periods are the database's: its clock stamped the hits.
      const [row] = await db
        .select({
          last7Days:
            sql<number>`count(*) filter (where ${guardrailHits.createdAt} >= now() - interval '7 days')`.mapWith(
              Number
            ),
          last30Days: sql<number>`count(*)`.mapWith(Number)
        })
        .from(guardrailHits)
        .where(
          and(
            eq(guardrailHits.clientInstanceId, clientInstanceId),
            eq(guardrailHits.guardrailName, guardrailName),
            gte(guardrailHits.createdAt, sql`now() - interval '30 days'`)
          )
        );
      return { last7Days: row?.last7Days ?? 0, last30Days: row?.last30Days ?? 0 };
    },
    async listRecentSubjects(input) {
      const { clientInstanceId, since, limit } = input;
      // A revision written, or an audited publish of one: each with its asset, its kind and
      // who acted. Who acted counts people and leaves the store as a key only.
      const actions =
        input.action === "write"
          ? sql`
              select a.kind, a.name, a.id as asset_id, r.revision,
                coalesce(r.actor->>'userId', r.actor->>'principalId') as actor_key,
                a.scope_id, r.created_at
              from config_asset_revisions r
              join config_assets a on a.id = r.asset_id
              where r.client_instance_id = ${clientInstanceId}
                and r.created_at >= ${since.toISOString()}::timestamptz
                and r.operation <> 'delete'
                and r.config is not null`
          : sql`
              select a.kind, a.name, a.id as asset_id, (e.metadata->>'revision')::int as revision,
                coalesce(e.actor->>'userId', e.actor->>'principalId') as actor_key,
                a.scope_id, e.created_at
              from audit_events e
              join config_assets a
                on a.client_instance_id = e.client_instance_id
                and a.kind = e.metadata->>'kind'
                and a.name = e.metadata->>'name'
              where e.client_instance_id = ${clientInstanceId}
                and e.created_at >= ${since.toISOString()}::timestamptz
                and e.type in ('app.published', 'config_asset.published')
                and e.status = 'success'
                and jsonb_typeof(e.metadata->'revision') = 'number'`;
      const conditions: SQL[] = [];
      if (input.kinds) conditions.push(sql`kind in ${inList(input.kinds)}`);
      if (input.excludeKinds?.length)
        conditions.push(sql`kind not in ${inList(input.excludeKinds)}`);
      if (input.workspaceId !== undefined) conditions.push(sql`scope_id = ${input.workspaceId}`);
      const where = conditions.length > 0 ? sql`where ${sql.join(conditions, sql` and `)}` : sql``;
      const rows = await db.execute<{
        kind: string;
        name: string;
        asset_id: string;
        revision: number;
        actor_key: string | null;
        scope_id: string | null;
        total: number;
      }>(sql`
        select kind, name, asset_id, revision, actor_key, scope_id,
          (count(*) over ())::int as total
        from (${actions}) as recent
        ${where}
        order by created_at desc
        limit ${limit}`);
      return {
        subjects: rows.map((row): GuardrailDryRunSubject => ({
          kind: row.kind,
          name: row.name,
          assetId: row.asset_id,
          revision: row.revision,
          ...(row.actor_key === null ? {} : { actorKey: row.actor_key }),
          ...(row.scope_id === null ? {} : { workspaceId: row.scope_id })
        })),
        total: rows[0]?.total ?? 0
      };
    },
    async countRecentActions(input) {
      const { clientInstanceId, since } = input;
      const conditions: SQL[] = [];
      if (input.action === "operation_call") {
        if (input.operation !== undefined) {
          conditions.push(
            input.operation.endsWith(".*")
              ? sql`starts_with(operation, ${input.operation.slice(0, -1)})`
              : sql`operation = ${input.operation}`
          );
        }
        if (input.origin !== undefined) conditions.push(sql`origin_kind = ${input.origin}`);
        if (input.workspaceId !== undefined) {
          conditions.push(sql`collaboration_workspace_id = ${input.workspaceId}`);
        }
        const rows = await db.execute<{ count: number }>(sql`
          select count(*)::int as count from operation_runs
          where client_instance_id = ${clientInstanceId} and created_at >= ${since.toISOString()}::timestamptz
            and target = 'live'
            ${conditions.length > 0 ? sql`and ${sql.join(conditions, sql` and `)}` : sql``}`);
        return rows[0]?.count ?? 0;
      }
      if (input.kind !== undefined) conditions.push(sql`kind = ${input.kind}`);
      const rows = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from approval_requests
        where client_instance_id = ${clientInstanceId} and created_at >= ${since.toISOString()}::timestamptz
          ${conditions.length > 0 ? sql`and ${sql.join(conditions, sql` and `)}` : sql``}`);
      return rows[0]?.count ?? 0;
    },
    async deleteHitsOlderThan({ clientInstanceId, days }) {
      // The cutoff is the database's: its clock stamped the hits.
      const removed = await db
        .delete(guardrailHits)
        .where(
          and(
            eq(guardrailHits.clientInstanceId, clientInstanceId),
            lt(guardrailHits.createdAt, sql`now() - make_interval(days => ${days})`)
          )
        );
      return removed.count;
    }
  };
}

/** A parenthesized list of values, for `in`. Never empty: an empty list matches nothing. */
function inList(values: readonly string[]): SQL {
  return values.length === 0
    ? sql`(null)`
    : sql`(${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `
      )})`;
}

function switchOf(row: typeof shippedGuardrailSwitches.$inferSelect): ShippedGuardrailSwitch {
  return {
    name: row.guardrailName,
    enabled: row.enabled,
    switchedBy: { id: row.switchedById, label: row.switchedByLabel },
    switchedAt: row.switchedAt.toISOString()
  };
}
