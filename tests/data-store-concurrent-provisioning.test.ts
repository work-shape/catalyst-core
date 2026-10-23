import { describe, expect, it } from "vitest";
import { DATA_STORE_MANIFEST_FILE } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { readJobDiagnostics } from "./support/job-diagnostics";
import { init, useDataStoreWorld, type StoreFile } from "./support/data-store-world";

// Many Data Stores provisioned at once on one Postgres server: each makes its own database and
// roles, and every one of them takes CONNECT on the same platform database from PUBLIC. None may
// fail because another ran beside it, and none waits for another to be provisioned whole.

const manifestOf = (name: string): StoreFile => ({
  path: DATA_STORE_MANIFEST_FILE,
  text: `id: ${name}\nname: ${name}\ndescription: One of many stores published at once.\n`
});

describe("Data Stores provisioned at once", () => {
  const { setup, publish, recordOf } = useDataStoreWorld("data_stores_at_once");

  for (const count of [4, 8, 16]) {
    it(`provisions ${count} stores published at once, each on its first attempt`, async () => {
      // As instances on one platform database run them: two processes each, four stores to one.
      const instances = await Promise.all(
        Array.from({ length: Math.ceil(count / 4) }, async (_, index) => {
          const world = await setup(`at_once_${count}_${index}`);
          const second = await setup(`at_once_${count}_${index}`);
          return {
            world,
            workers: [world.worker, second.worker],
            logs: [world.logged, second.logged]
          };
        })
      );
      const published = await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const { world } = required(instances[index % instances.length]);
          const name = `store_${index}`;
          return { world, id: await publish(world, [manifestOf(name), init], name) };
        })
      );

      await Promise.all(
        instances.flatMap(({ workers }) => workers.map((worker) => worker.runDue()))
      );

      const records = await Promise.all(published.map(({ world, id }) => recordOf(world, id)));
      const diagnostics = await readJobDiagnostics({
        clientInstanceIds: instances.map(({ world }) => world.clientInstanceId),
        kinds: ["data_store.provision"],
        logs: instances.flatMap(({ logs }) => logs.flat())
      });
      const evidence = JSON.stringify(diagnostics);
      expect(
        records.filter((record) => record.failure !== undefined).map((record) => record.failure),
        evidence
      ).toEqual([]);
      expect(
        records.map((record) => record.status),
        evidence
      ).toEqual(Array.from({ length: count }, () => "ready"));
      expect(
        diagnostics.jobs.map(({ status, attempts }) => ({ status, attempts })),
        evidence
      ).toEqual(Array.from({ length: count }, () => ({ status: "succeeded", attempts: 1 })));
    });
  }
});
