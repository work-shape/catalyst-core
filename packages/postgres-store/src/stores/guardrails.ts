import { and, desc, eq, lt, sql } from "drizzle-orm";
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
          actorId: hit.actor.id,
          actorLabel: hit.actor.displayLabel
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
        actor: { id: row.actorId, displayLabel: row.actorLabel },
        createdAt: row.createdAt.toISOString()
      }));
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
