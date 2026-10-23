import * as connector from "@work-shape/catalyst-postgres-connector";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataStoreRecord, JobControl } from "@work-shape/catalyst-core";
import { required } from "./assertions";
import { useDataStoreWorld } from "./data-store-world";

/** The same page and cursor contract at boundary and nightly volume. */
export function testDataStoreMaintenancePaging(storeCount: number) {
  describe(`Data Store maintenance across ${storeCount} stores`, () => {
    const STORE_COUNT = storeCount;
    const { db, published } = useDataStoreWorld(`store_maintenance_${storeCount}`);
    let seedRecord: DataStoreRecord | undefined;
    afterEach(async () => {
      // Synthetic rows share one physical database; the world cleans up its real seed once.
      await db.sql`delete from data_stores where id like 'paging-%'`;
      if (seedRecord) await db.store.dataStores.putDataStore(seedRecord);
      seedRecord = undefined;
    });

    async function seeded(owned: boolean) {
      const world = await published("seed");
      await db.sql`
      insert into data_stores (
        id, client_instance_id, name, status, host, port, database_name, app_role,
        migration_role, level, migrations, target_revision, size_limit_bytes,
        conditions, created_at, updated_at, owner_knowledge_base_id
      ) select 'paging-' || n, client_instance_id, 'store-' || lpad(n::text, 5, '0'),
        'ready', host, port, database_name, app_role, migration_role, level, '[]'::jsonb,
        target_revision, size_limit_bytes, conditions, created_at, updated_at,
        case when ${owned} then 'owner' else null end
      from data_stores cross join generate_series(1, ${STORE_COUNT}) n where id = ${world.id}`;
      seedRecord = world.record;
      await db.store.dataStores.deleteDataStore({
        clientInstanceId: world.clientInstanceId,
        id: world.id
      });
      // The seeded rows reuse one real database; only metadata discovery is under test.
      return world;
    }

    async function traverse(world: Awaited<ReturnType<typeof seeded>>, kind: string) {
      const handler = required(
        world.dataStores.jobHandlers.find((entry) => entry.kind.kind === kind)
      );
      const control: JobControl = {
        leaseToken: "paging-probe",
        signal: AbortSignal.timeout(120_000),
        attempt: 1,
        logger: world.logger,
        transaction: (work) => db.store.transaction(work)
      };
      let job = await db.store.jobs.enqueue(
        handler.kind,
        {},
        { clientInstanceId: world.clientInstanceId }
      );
      while (true) {
        await handler.bind(job).run(control);
        await db.sql`delete from platform_jobs where id = ${job.id}`;
        const rows = await db.sql<{ payload: unknown }[]>`select payload from platform_jobs
        where client_instance_id = ${world.clientInstanceId} and kind = ${kind} order by created_at limit 1`;
        const next = rows[0];
        if (!next) break;
        // Reload the persisted cursor, as another worker after a process restart would.
        job = await db.store.jobs.enqueue(
          handler.kind,
          handler.kind.payloadSchema.parse(next.payload),
          {
            clientInstanceId: world.clientInstanceId
          }
        );
        await db.sql`delete from platform_jobs where client_instance_id = ${world.clientInstanceId}
        and kind = ${kind} and id <> ${job.id}`;
      }
    }

    it("queues migration for every owned store across persisted continuations", async () => {
      const world = await seeded(true);
      await traverse(world, "data_store.upgrade_owned_page");
      const [row] = await db.sql<
        { count: number }[]
      >`select count(distinct payload->>'storeId')::int as count
      from platform_jobs where client_instance_id = ${world.clientInstanceId} and kind = 'data_store.migrate' and payload->>'storeId' like 'paging-%'`;
      expect(required(row).count).toBe(STORE_COUNT);
    });

    it("measures every store across persisted continuations", async () => {
      const executors: connector.PostgresExecutor[] = [];
      const createExecutor = connector.createPostgresExecutor;
      vi.spyOn(connector, "createPostgresExecutor").mockImplementation((input) => {
        const executor = createExecutor(input);
        executors.push(executor);
        return executor;
      });
      const world = await seeded(false);
      for (const executor of executors) {
        vi.spyOn(executor, "query").mockImplementation(async (input) => {
          if (input.sql.includes("pg_database_size"))
            return { columns: [], rowCount: 1, truncated: false, rows: [{ bytes: "100" }] };
          if (input.sql.includes("pg_catalog.pg_class"))
            return {
              columns: [],
              rowCount: 1,
              truncated: false,
              rows: [{ tables: 1, rows: "10" }]
            };
          throw new Error("Unneeded external condition probe");
        });
        vi.spyOn(executor, "change").mockRejectedValue(new Error("Unneeded external prune"));
      }
      await traverse(world, "data_store.measure_size_page");
      const [row] = await db.sql<{ count: number }[]>`select count(*)::int as count from data_stores
      where client_instance_id = ${world.clientInstanceId} and id like 'paging-%' and size_measured_at is not null`;
      expect(required(row).count).toBe(STORE_COUNT);
    }, 120_000);
  });
}
