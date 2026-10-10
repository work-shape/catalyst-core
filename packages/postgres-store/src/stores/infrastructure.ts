import { eq, sql } from "drizzle-orm";
import {
  PROVIDER_CHECK_ERROR_CLASSES,
  type InfrastructureCheckOutcome,
  type InfrastructureCheckStore
} from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
import { infrastructureCheckState } from "../schema";

export function createPostgresInfrastructureChecksStore(
  db: PostgresConnection
): InfrastructureCheckStore {
  return {
    async read({ clientInstanceId }) {
      const [row] = await db
        .select({
          outcomes: infrastructureCheckState.outcomes,
          manualCheckAt: infrastructureCheckState.manualCheckAt
        })
        .from(infrastructureCheckState)
        .where(eq(infrastructureCheckState.clientInstanceId, clientInstanceId));
      return {
        outcomes: readOutcomes(row?.outcomes),
        ...(row?.manualCheckAt ? { manualCheckAt: row.manualCheckAt } : {})
      };
    },
    async recordOutcomes({ clientInstanceId, outcomes }) {
      if (Object.keys(outcomes).length === 0) {
        return;
      }
      await db
        .insert(infrastructureCheckState)
        .values({ clientInstanceId, outcomes, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: infrastructureCheckState.clientInstanceId,
          // The merge runs in the database: two processes that write different providers at
          // the same moment both keep theirs.
          set: {
            outcomes: sql`${infrastructureCheckState.outcomes} || excluded.outcomes`,
            updatedAt: sql`now()`
          }
        });
    },
    async claimManualCheck({ clientInstanceId, at, minIntervalMs }) {
      const lastAllowed = new Date(at.getTime() - minIntervalMs);
      const [claimed] = await db
        .insert(infrastructureCheckState)
        .values({ clientInstanceId, outcomes: {}, manualCheckAt: at, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: infrastructureCheckState.clientInstanceId,
          set: { manualCheckAt: at, updatedAt: sql`now()` },
          // The row lock makes the second of two callers see the first one's claim here.
          setWhere: sql`${infrastructureCheckState.manualCheckAt} is null or ${infrastructureCheckState.manualCheckAt} <= ${lastAllowed.toISOString()}::timestamptz`
        })
        .returning({ manualCheckAt: infrastructureCheckState.manualCheckAt });
      if (claimed) {
        return { claimed: true, manualCheckAt: at };
      }
      const [standing] = await db
        .select({ manualCheckAt: infrastructureCheckState.manualCheckAt })
        .from(infrastructureCheckState)
        .where(eq(infrastructureCheckState.clientInstanceId, clientInstanceId));
      return { claimed: false, manualCheckAt: standing?.manualCheckAt ?? at };
    }
  };
}

/**
 * What the row holds, read as written by any release: an entry that is no outcome is left out,
 * so a row of a later release with a class this one does not know cannot break a page.
 */
function readOutcomes(stored: unknown): Record<string, InfrastructureCheckOutcome> {
  const outcomes: Record<string, InfrastructureCheckOutcome> = {};
  if (typeof stored !== "object" || stored === null) {
    return outcomes;
  }
  for (const [id, value] of Object.entries(stored)) {
    const outcome = readOutcome(value);
    if (outcome) {
      outcomes[id] = outcome;
    }
  }
  return outcomes;
}

function readOutcome(value: unknown): InfrastructureCheckOutcome | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const checkedAt: unknown = Reflect.get(value, "checkedAt");
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) {
    return undefined;
  }
  const ok: unknown = Reflect.get(value, "ok");
  if (ok === true) {
    return { ok: true, checkedAt };
  }
  const errorClass = PROVIDER_CHECK_ERROR_CLASSES.find(
    (known) => known === Reflect.get(value, "errorClass")
  );
  return ok === false && errorClass ? { ok: false, checkedAt, errorClass } : undefined;
}
