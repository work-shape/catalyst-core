import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { asUserId, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// A publish holds a platform connection and the definition-graph lock. Reading an operation
// through the pool instead of that transaction stalls every publish once all ten default
// connections are held, including those waiting for the graph lock.
const STALLED_AFTER_MS = 30_000;

describe("Workflows published at once beyond the platform's pool", () => {
  const fixture = useDataStoreInstance();

  for (const count of [16, 32]) {
    it(
      `publishes ${count} Workflows with Data Store dataset contracts at once`,
      { timeout: 90_000 },
      async () => {
        const world = await fixture.start(true, "allow", undefined, undefined, false, true);
        await world.api.call("health.get");
        const owner = await fixture.person(world, "user-1", ["user", "admin", "superadmin"]);
        await fixture.publishStore(world);
        await world.stores.apiAccess.createServicePrincipal({
          clientInstanceId,
          name: "dataset-reader",
          displayLabel: "Dataset reader",
          createdByUserId: asUserId(owner.id)
        });
        const params = Array.from({ length: count }, (_, index) => ({
          kind: WORKFLOW_ASSET_KIND,
          name: `dataset-reader-${index}`
        }));
        for (const param of params) {
          const written = await world.api.call("assets.put", {
            params: param,
            payload: {
              expectedRevision: null,
              config: {
                name: param.name,
                manifest: {
                  id: param.name,
                  name: param.name,
                  runAs: "dataset-reader",
                  inputs: { type: "object" },
                  outputs: {
                    type: "object",
                    properties: { rows: { type: "dataset", row: { type: "object" } } }
                  },
                  steps: [
                    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
                    {
                      id: "query",
                      name: "Read findings",
                      type: "operation",
                      operation: "data_store.findings.query",
                      input: { sql: { value: "select * from findings" } },
                      dataset: { at: "rows" }
                    },
                    {
                      id: "result",
                      name: "Result",
                      type: "output",
                      input: { rows: { ref: { step: "query", path: "rows" } } }
                    }
                  ]
                }
              }
            }
          });
          expect(written.statusCode, written.body).toBe(200);
        }

        const started = performance.now();
        const answers = Promise.all(
          params.map((param) =>
            world.api.call("assets.publish", {
              params: param,
              payload: { revision: 1 }
            })
          )
        );
        let timer: NodeJS.Timeout | undefined;
        const ended = await Promise.race([
          answers.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), STALLED_AFTER_MS);
          })
        ]);
        clearTimeout(timer);
        if (!ended) {
          // Terminate only transactions in this file's disposable database. This releases both
          // the graph lock and its waiters so a regression fails without hanging file teardown.
          const url = await fileTestDatabaseUrl();
          const sql = postgres(url, { max: 1, onnotice: () => undefined });
          try {
            let left = true;
            void answers.finally(() => (left = false)).catch(() => undefined);
            while (left) {
              await sql`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
              where datname = ${new URL(url).pathname.slice(1)} and pid <> pg_backend_pid()
                and xact_start is not null`;
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } finally {
            await sql.end();
          }
        }
        expect(ended, `${count} publishes did not complete within ${STALLED_AFTER_MS} ms`).toBe(
          true
        );
        expect(
          (await answers).filter((answer) => answer.statusCode !== 200).map((answer) => answer.body)
        ).toEqual([]);
        console.info(
          `${count} Workflow publishes completed in ${Math.round(performance.now() - started)} ms`
        );
      }
    );
  }
});
