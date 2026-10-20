import { sql } from "drizzle-orm";
import type { ConnectionsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { connectionSourceCalls as calls } from "./schema/connections";

/** The caller holds a transaction; the per-Connection lock serializes admission everywhere. */
export function createPostgresSourceCallOperations(
  db: PostgresConnection
): Pick<ConnectionsStore, "admitSourceCall" | "releaseSourceCall"> {
  return {
    async admitSourceCall(input) {
      const { clientInstanceId, connectionAssetId, limits, leaseId, leaseMs } = input;
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`source:${clientInstanceId}:${connectionAssetId}`}, 0))`
      );
      await db.execute(sql`delete from ${calls} where ${calls.expiresAt} <= clock_timestamp()`);
      const periodMs = (limits.perPeriod?.seconds ?? 0) * 1000;
      const [row] = await db.execute<{
        active: number;
        recent: number;
        active_wait: number | null;
        rate_wait: number | null;
      }>(sql`
        select count(*) filter (where active_until > clock_timestamp())::int as active,
          count(*) filter (where started_at > clock_timestamp() - ${periodMs} * interval '1 millisecond')::int as recent,
          extract(epoch from (min(active_until) filter (where active_until > clock_timestamp()) - clock_timestamp())) * 1000 as active_wait,
          extract(epoch from (min(started_at) filter (where started_at > clock_timestamp() - ${periodMs} * interval '1 millisecond') + ${periodMs} * interval '1 millisecond' - clock_timestamp())) * 1000 as rate_wait
        from ${calls} where client_instance_id = ${clientInstanceId} and connection_asset_id = ${connectionAssetId}
      `);
      const wait = Math.max(
        limits.concurrency !== undefined && Number(row?.active) >= limits.concurrency
          ? Number(row?.active_wait ?? leaseMs)
          : 0,
        limits.perPeriod && Number(row?.recent) >= limits.perPeriod.calls
          ? Number(row?.rate_wait ?? periodMs)
          : 0
      );
      if (wait > 0) return { admitted: false, retryAfterMs: Math.max(1, Math.ceil(wait)) };
      await db.insert(calls).values({
        leaseId,
        clientInstanceId,
        connectionAssetId,
        startedAt: sql`clock_timestamp()`,
        activeUntil: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
        expiresAt: sql`clock_timestamp() + ${Math.max(leaseMs, periodMs)} * interval '1 millisecond'`
      });
      return { admitted: true };
    },
    async releaseSourceCall({ clientInstanceId, connectionAssetId, leaseId }) {
      await db.execute(sql`update ${calls} set active_until = clock_timestamp()
        where client_instance_id = ${clientInstanceId} and connection_asset_id = ${connectionAssetId} and lease_id = ${leaseId}`);
    }
  };
}
