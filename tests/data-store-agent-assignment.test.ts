import { describe, expect, it } from "vitest";
import { clientInstanceId, useDataStoreInstance } from "./support/data-store-instance";

describe("assigning a Data Store's row tools to an agent", () => {
  const { start, publishStore } = useDataStoreInstance();

  it("accepts a live row tool through the asset API, lists its agent as a user, and refuses missing or malformed tools", async () => {
    const world = await start(true, undefined, undefined, undefined, true);
    await publishStore(world);
    const save = (name: string, tool: string) =>
      world.api.call("assets.put", {
        params: { kind: "agent", name },
        payload: {
          expectedRevision: null,
          availableIn: "all",
          config: {
            name,
            displayName: "Finding scout",
            modelProviderId: "local",
            instructions: "Read findings.",
            toolNames: [tool]
          }
        }
      });
    const stored = await save("assignment-a", "data_store.findings.query");
    expect(stored.statusCode, stored.body).toBe(200);
    const used = await world.api.call("data_stores.used_by", { params: { store: "findings" } });
    expect(used.statusCode, used.body).toBe(200);
    expect(used.json()).toMatchObject({
      agents: [{ name: "assignment-a", title: "Finding scout", reads: true, writes: false }]
    });
    const protectedStore = await world.api.call("assets.delete", {
      params: { kind: "data_store", name: "findings" },
      payload: { expectedRevision: 1 }
    });
    expect(protectedStore.statusCode, protectedStore.body).toBe(422);
    expect(protectedStore.body).toContain("data_store_in_use");
    const second = await save("assignment-z", "data_store.findings.query");
    expect(second.statusCode, second.body).toBe(200);
    const first = await world.stores.configAssets.listActiveConfigAssets({
      clientInstanceId,
      kind: "agent",
      namePrefix: "assignment-",
      limit: 1
    });
    expect(first.map((asset) => asset.name)).toEqual(["assignment-a"]);
    const next = await world.stores.configAssets.listActiveConfigAssets({
      clientInstanceId,
      kind: "agent",
      namePrefix: "assignment-",
      limit: 1,
      afterName: first[0]?.name
    });
    expect(next.map((asset) => asset.name)).toEqual(["assignment-z"]);
    for (const [index, tool] of [
      "data_store.missing.query",
      "data_store.findings.unknown",
      "data_store..query",
      "data_store.findings.query.extra"
    ].entries()) {
      const refused = await save(`invalid-scout-${index}`, tool);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.body).toContain("unavailable tool");
    }
  });
});
