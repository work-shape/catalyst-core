import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DATA_STORE_MANIFEST_FILE, KNOWLEDGE_BASE_ASSET_KIND } from "@work-shape/catalyst-core";
import { useDataStoreInstance } from "./support/data-store-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

// More Knowledge Bases published at once than the platform's pool has connections (ten, the
// driver's default). A publish holds one connection for its transaction; a read of the publish
// that took a second one from the pool would wait for a connection that only another waiting
// publish could give back, and none would end.

/** How long the publishes may take before the test calls them stalled. */
const STALLED_AFTER_MS = 30_000;

describe("Knowledge Bases published at once beyond the platform's pool", () => {
  const { start, put, publish, settle } = useDataStoreInstance();

  for (const count of [16, 32]) {
    it(`publishes ${count} Knowledge Bases on one store at once`, { timeout: 90_000 }, async () => {
      const instance = await start(true, undefined, undefined, undefined, true);
      expect(
        (
          await put(instance, [
            { path: DATA_STORE_MANIFEST_FILE, text: "id: findings\nname: Findings\n" },
            {
              path: "migrations/0001_init.sql",
              text: "create table findings (client_id text not null);"
            }
          ])
        ).statusCode
      ).toBe(200);
      expect((await publish(instance, 1)).statusCode).toBe(200);
      await settle(instance, 1);

      const params = Array.from({ length: count }, (_, index) => ({
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: `findings-kb-${index}`
      }));
      for (const param of params) {
        const written = await instance.api.call("assets.put", {
          params: param,
          payload: {
            expectedRevision: null,
            config: {
              name: param.name,
              title: param.name,
              description: "What the monthly check of bookings found.",
              backend: { dataStore: "findings" },
              tables: [{ name: "findings", description: "One finding." }]
            }
          }
        });
        expect(written.statusCode, written.body).toBe(200);
      }

      const answers = Promise.all(
        params.map((param) =>
          instance.api.call("assets.publish", { params: param, payload: { revision: 1 } })
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
        // Ends the stalled transactions of this file's own database, so the test can finish.
        const url = await fileTestDatabaseUrl();
        const sql = postgres(url, { max: 1, onnotice: () => undefined });
        let left = true;
        void answers.finally(() => (left = false)).catch(() => undefined);
        while (left) {
          await sql`select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
            where datname = ${new URL(url).pathname.slice(1)} and state = 'idle in transaction'`;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await sql.end();
      }
      expect(ended, `no publish ended within ${STALLED_AFTER_MS} ms`).toBe(true);
      expect(
        (await answers).filter((answer) => answer.statusCode !== 200).map((answer) => answer.body)
      ).toEqual([]);
    });
  }
});
