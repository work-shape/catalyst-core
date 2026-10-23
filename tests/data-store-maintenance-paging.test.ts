import { describe, expect, it } from "vitest";
import type { JobControl, JsonObject } from "@work-shape/catalyst-core";
import { holdTransaction } from "./support/postgres-concurrency-harness";
import { eventually, required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";

import { testDataStoreMaintenancePaging } from "./support/data-store-maintenance-paging";

describe("Data Store maintenance grants and lease recovery", () => {
  const { db, published, jobs, connect } = useDataStoreWorld("store_maintenance_paging");

  it("serializes measurement catalog grants with an in-flight store migration", async () => {
    const world = await published("catalog_grants");
    const database = world.record.location.database;
    const holder = await holdTransaction(connect(database), async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended('catalyst data store grants ' || ${database}::text, 0))`;
      await sql.unsafe(`grant usage on schema catalyst to "${world.record.roles.app}"`);
    });
    const handler = required(
      world.dataStores.jobHandlers.find(({ kind }) => kind.kind === "data_store.measure_size_page")
    );
    const job = await db.store.jobs.enqueue(
      handler.kind,
      {},
      { clientInstanceId: world.clientInstanceId }
    );
    const control: JobControl = {
      leaseToken: "grant-probe",
      signal: AbortSignal.timeout(30_000),
      attempt: 1,
      logger: world.logger,
      transaction: (work) => db.store.transaction(work)
    };
    const measuring = handler.bind(job).run(control);
    let waitingFor: string | undefined;
    try {
      waitingFor = await eventually(async () => {
        const [waiting] = await db.sql<{ wait_event: string }[]>`
          select wait_event from pg_stat_activity
          where datname = ${database} and wait_event_type = 'Lock'`;
        return required(waiting).wait_event;
      });
    } finally {
      await holder.commit();
      await measuring;
    }
    // The shared turn is taken before any catalog DDL, rather than racing on its row locks.
    expect(waitingFor).toBe("advisory");
    expect(world.logged).not.toContainEqual(
      expect.objectContaining({
        message: "The old call records of a Data Store were not removed"
      })
    );
  });

  it.each([
    ["data_store.upgrade_owned", "data_store.upgrade_owned_page"],
    ["data_store.measure_size", "data_store.measure_size_page"]
  ])(
    "recovers expired first and cursor pages of %s through the executor",
    async (tickKind, pageKind) => {
      const world = await published("lease_recovery");
      const tick = required(
        world.dataStores.jobHandlers.find(({ kind }) => kind.kind === tickKind)
      );
      const page = required(
        world.dataStores.jobHandlers.find(({ kind }) => kind.kind === pageKind)
      );
      expect(() => tick.kind.payloadSchema.parse({ after: { name: "a", id: "a" } })).toThrow();
      expect(tick.kind.maxAttempts).toBe(1);
      const control: JobControl = {
        leaseToken: "tick-probe",
        signal: AbortSignal.timeout(30_000),
        attempt: 1,
        logger: world.logger,
        transaction: (work) => db.store.transaction(work)
      };
      const tickJob = await db.store.jobs.enqueue(
        tick.kind,
        {},
        { clientInstanceId: world.clientInstanceId }
      );
      await tick.bind(tickJob).run(control);
      const worker = jobs.worker(db.store, world.clientInstanceId, [page]);
      const payloads: readonly JsonObject[] = [{}, { after: { name: "a", id: "a" } }];
      for (const payload of payloads) {
        const job = await db.store.jobs.enqueue(page.kind, payload, {
          clientInstanceId: world.clientInstanceId,
          ...(Object.keys(payload).length === 0 ? { dedupeKey: "first-page" } : {})
        });
        await db.sql`update platform_jobs set status = 'running', attempts = 1,
        lease_owner = 'crashed-worker', lease_token = 'expired-token',
        lease_expires_at = now() - interval '1 minute' where id = ${job.id}`;
        await worker.runDue();
        await db.sql`update platform_jobs set run_after = now() - interval '1 second' where id = ${job.id}`;
        await worker.runDue();
        const [recovered] = await db.sql<{ status: string; attempts: number; payload: unknown }[]>`
        select status, attempts, payload from platform_jobs where id = ${job.id}`;
        expect(recovered).toMatchObject({ status: "succeeded", attempts: 2, payload });
      }
    }
  );
});

// Two full pages and one more store keep cursor continuation in the ordinary suite.
testDataStoreMaintenancePaging(201);
