import { describe, expect, it } from "vitest";
import { CONDITION_WAIT_MS, waitUntil } from "./support/assertions";
import { createTestInstance } from "./support/test-instance";
import { init, manifest, useDataStoreWorld } from "./support/data-store-world";

// Provisioning opens a migration-role socket. Restart the runtime before the next publish:
// only a cold executor proves that reading its password stays in the held transaction.
describe("migration credentials with one Platform Store connection", () => {
  const { db, jobs, published, publish, recordOf, connect } =
    useDataStoreWorld("migration_credentials");

  it.each([false, true])("completes a cold migration with rollback=%s", async (rollback) => {
    const world = await published(`cold_${rollback}`);
    await world.dataStores.close();
    const applicationName = `migration_credentials_${rollback}`;
    const { stores } = await createTestInstance({
      postgres: { applicationName, poolSize: 1 }
    });
    const cold = world.restart(stores);
    try {
      await publish(world, [
        manifest(),
        init,
        {
          path: "migrations/0002_cold.sql",
          text: `create table cold_result (id integer);${rollback ? " select 1/0;" : ""}`
        }
      ]);
      let ended = false;
      const running = cold.worker.runDue().finally(() => {
        ended = true;
      });
      try {
        await waitUntil(() => ended, "the cold migration completes", CONDITION_WAIT_MS);
      } finally {
        if (!ended) {
          // Release only this test's blocked transaction so a regression can fail cleanly.
          await db.sql`select pg_terminate_backend(pid) from pg_stat_activity
              where datname = ${new URL(db.databaseUrl).pathname.slice(1)}
                and application_name = ${applicationName} and state = 'idle in transaction'`;
        }
        await running;
      }
      const record = await recordOf(world, world.id);
      expect(record).toMatchObject({
        status: "ready",
        level: rollback ? 1 : 2,
        migrations: rollback ? [{ number: 1 }] : [{ number: 1 }, { number: 2 }]
      });
      if (rollback) {
        expect(record.failure).toMatchObject({
          code: "migration_failed",
          message: expect.stringContaining("SQLSTATE 22012")
        });
      } else {
        expect(record.failure).toBeUndefined();
      }
      const sql = connect(record.location.database);
      expect(
        (await sql`select to_regclass('public.cold_result') is not null as present`)[0]
      ).toEqual({ present: !rollback });
      expect(await sql`select number from catalyst.migrations order by number`).toEqual(
        rollback ? [{ number: 1 }] : [{ number: 1 }, { number: 2 }]
      );
    } finally {
      await jobs.stopWorkers();
      await cold.dataStores.close();
      await stores.close();
    }
  });
});
