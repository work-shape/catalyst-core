import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { createPlatformId, type GuardrailHit, type GuardrailStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { guardrailHits } from "../schema/guardrails";

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
          subjectName: hit.subjectName ?? null
        }))
      );
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
