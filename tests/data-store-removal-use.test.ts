import { describe, expect, it } from "vitest";
import { DATA_STORE_ASSET_KIND, type JsonObject } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";

// Deleting a referenced store is a refusal, before its retirement, even when the caller may
// not read the referencing asset. It leaves the asset, its revision and its database live.
describe("deleting a referenced Data Store", () => {
  const { start, publishStore } = useDataStoreInstance();

  it("refuses published App, Workflow, Knowledge Base and agent references without naming them", async () => {
    const world = await start(true);
    const record = await publishStore(world);
    const uses: [string, JsonObject][] = [
      [
        "app",
        {
          title: "Private board",
          manifest: { actions: [{ kind: "sql", dataStore: "findings", effect: "reading" }] }
        }
      ],
      [
        "workflow",
        {
          manifest: {
            name: "Private workflow",
            steps: [
              {
                id: "call",
                name: "Call",
                type: "operation",
                operation: "data_store.findings.insert",
                input: {}
              }
            ]
          }
        }
      ],
      ["knowledge_base", { title: "Private knowledge", backend: { dataStore: "findings" } }],
      ["agent", { displayName: "Private agent", toolNames: ["data_store.findings.query"] }]
    ];
    for (const [kind, config] of uses) {
      const name = `private-${kind}-reference`;
      const key = `${kind}:${name}`;
      const written = await world.stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: null },
        mutations: [{ type: "upsert", kind, name, config, draft: true }]
      });
      const revision = required(written.revisions[key]);
      const stored = required(
        await world.stores.configAssets.getConfigAssetRevision({
          clientInstanceId,
          kind,
          name,
          revision
        })
      );
      const assetId = required(written.assetIds[key]);
      await world.stores.configAssets.publishConfigAssetRevision({
        clientInstanceId,
        kind,
        name,
        assetId,
        revision,
        revisionId: stored.id
      });

      const refused = await world.api.call("assets.delete", {
        params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
        payload: { expectedRevision: 1 }
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({
        error: { code: "VALIDATION_FAILED", details: { reason: "data_store_in_use" } }
      });
      expect(refused.body).not.toContain(name);
      expect(refused.body).not.toContain("Private");
      expect(
        await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
      ).toMatchObject({ status: "ready" });
      expect(
        (
          await world.api.call("assets.get", {
            params: { kind: DATA_STORE_ASSET_KIND, name: "findings" }
          })
        ).statusCode
      ).toBe(200);
      await world.stores.configAssets.removeConfigAsset({
        clientInstanceId,
        kind,
        name,
        assetId,
        expectedRevision: revision
      });
    }
    const removed = await world.api.call("assets.delete", {
      params: { kind: DATA_STORE_ASSET_KIND, name: "findings" },
      payload: { expectedRevision: 1 }
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(
      await world.stores.dataStores.getDataStore({ clientInstanceId, id: record.id })
    ).toMatchObject({ status: "retired" });
  });
});
