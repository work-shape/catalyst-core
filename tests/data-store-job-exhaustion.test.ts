import { describe, expect, it } from "vitest";
import { DATA_STORE_JOB_KINDS } from "@work-shape/catalyst-core";
import { awaitStoreLevels } from "@work-shape/catalyst-server";
import { required } from "./support/assertions";
import { init, manifest, refusal, useDataStoreWorld } from "./support/data-store-world";

// Crash recovery runs the real handlers' exhaustion hook without entering failAttempt.
describe("a Data Store job that loses its last lease", () => {
  const { db, setup, publish, published, recordOf, settle } = useDataStoreWorld("store_exhausted");

  it.each(["provision", "migrate"] as const)(
    "records %s exhaustion, answers the App's wait and clears the failure on manual retry",
    async (operation) => {
      const world = operation === "provision" ? await setup(operation) : await published(operation);
      const files =
        operation === "provision"
          ? [manifest(), init]
          : [
              manifest(),
              init,
              {
                path: "migrations/0002_note.sql",
                text: "alter table findings add column note text;"
              }
            ];
      const id = await publish(world, files);
      const kind = DATA_STORE_JOB_KINDS[operation];
      // The database state left by a killed worker on its final attempt, with no failAttempt.
      const [job] = await db.sql<{ id: string }[]>`
      update platform_jobs set status = 'running', attempts = max_attempts,
        lease_owner = 'killed-worker', lease_token = 'lost-lease',
        lease_expires_at = now() - interval '1 second'
      where client_instance_id = ${world.clientInstanceId} and kind = ${kind} and status = 'queued'
      returning id`;
      expect(job).toBeDefined();
      expect((await recordOf(world, id)).failure).toBeUndefined();
      await world.worker.runDue();
      const failed = await recordOf(world, id);
      expect(failed).toMatchObject({ failure: { code: "job_exhausted" } });
      expect(
        await db.sql`select status, error_code from platform_jobs where id = ${required(job).id}`
      ).toEqual([{ status: "dead", error_code: "LEASE_EXPIRED" }]);

      let sleeps = 0;
      const wait = () =>
        awaitStoreLevels(
          () => recordOf(world, id),
          [
            {
              name: "findings",
              title: "Findings",
              storeId: id,
              level: files.length - 1,
              migrations: new Map()
            }
          ],
          {
            timeoutMs: 60_000,
            pollMs: 250,
            now: () => 0,
            sleep: () => {
              sleeps++;
              throw new Error("A failed store must refuse before sleeping");
            }
          }
        );
      expect(await refusal(wait())).toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("Bitte einen Administrator"),
        details: { reason: "data_store_job_exhausted", dataStore: "findings" }
      });
      expect(sleeps).toBe(0);

      // The same transaction as the jobs admin retry: both the job and subject are restored.
      const retry = required(world.dataStores.jobRetries.find((entry) => entry.kind.kind === kind));
      await db.store.transaction(async (stores) => {
        expect(
          await stores.jobs.retry({
            clientInstanceId: world.clientInstanceId,
            id: required(job).id
          })
        ).toMatchObject({ outcome: "requeued" });
        expect(
          await required(retry.restoreSubject)(
            { clientInstanceId: world.clientInstanceId, kind, subject: id },
            stores
          )
        ).toBe(true);
      });
      expect((await recordOf(world, id)).failure).toBeUndefined();
      await settle(world, id, files.length - 1);
      await expect(wait()).resolves.toBeUndefined();
    }
  );

  it("preserves the specific failure of a final attempt", async () => {
    const world = await setup("specific");
    const id = await publish(world, [manifest(), init]);
    const failure = { code: "platform_role_lacks_privilege", message: "Grant CREATEDB." };
    await db.store.dataStores.putDataStore({ ...(await recordOf(world, id)), failure });
    await db.sql`update platform_jobs set status = 'running', attempts = max_attempts,
      lease_owner = 'killed-worker', lease_token = 'lost-lease', lease_expires_at = now() - interval '1 second'
      where client_instance_id = ${world.clientInstanceId}`;
    await world.worker.runDue();
    expect((await recordOf(world, id)).failure).toEqual(failure);
  });

  it("refuses restoring missing or retired subjects", async () => {
    const world = await setup("not_restorable");
    const id = await publish(world, [manifest(), init]);
    const record = await recordOf(world, id);
    await db.store.dataStores.putDataStore({ ...record, status: "retired" });
    for (const retry of world.dataStores.jobRetries.filter((entry) => entry.restoreSubject)) {
      for (const subject of [undefined, "missing", id]) {
        expect(
          await required(retry.restoreSubject)(
            { clientInstanceId: world.clientInstanceId, kind: retry.kind.kind, subject },
            db.store
          )
        ).toBe(false);
      }
    }
  });
});
