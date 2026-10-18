import { describe, expect, it } from "vitest";
import { DATA_STORE_MANIFEST_FILE, KNOWLEDGE_BASE_ASSET_KIND } from "@work-shape/catalyst-core";
import { useDataStoreInstance } from "./support/data-store-instance";

// Knowledge Bases published at once on one Data Store: each gets a reader role of its own, and
// every grant to one of them is written onto the same catalog rows of the store's database, its
// schema and its tables. None may fail because another was published beside it.

describe("Knowledge Bases published at once on one Data Store", () => {
  const { start, put, publish, settle } = useDataStoreInstance();

  for (const count of [2, 4, 8]) {
    it(`publishes ${count} Knowledge Bases on one store at once`, async () => {
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

      // A few rounds: two grants meet on a row only when their moments overlap.
      for (let round = 0; round < 3; round += 1) {
        const params = Array.from({ length: count }, (_, index) => ({
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name: `findings-kb-${round}-${index}`
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

        const answers = await Promise.all(
          params.map((param) =>
            instance.api.call("assets.publish", { params: param, payload: { revision: 1 } })
          )
        );
        expect(
          answers.filter((answer) => answer.statusCode !== 200).map((answer) => answer.body)
        ).toEqual([]);
      }
    });
  }
});
