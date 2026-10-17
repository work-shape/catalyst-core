import { describe, expect, it } from "vitest";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { documentSourceItemSchema } from "@work-shape/catalyst-core";

const KB = "sync-test";
const SOURCE = "source";

describe("items synced before migration 5 (parents = [])", () => {
  const { setup } = useKnowledgeSync();
  const file = (name: string) => ({
    folderId: "folder",
    name,
    mime: "text/plain",
    bytes: new TextEncoder().encode(name)
  });

  it("search still finds pre-upgrade synced documents before their full pass", async () => {
    const world = await setup();
    world.world.put(file("upgraded-alpha.txt"));
    await world.drain(await world.sync());
    // What migration 5 leaves on every row synced by SRC-1b.
    await world.sql`update catalyst_kb.source_items set parents='[]'::jsonb`;
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "upgraded" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    expect(hits.body).toContain("upgraded-alpha.txt");
  });

  it("widening a source's folders does not withdraw pre-upgrade items", async () => {
    const world = await setup();
    world.world.put(file("upgraded-beta.txt"));
    await world.drain(await world.sync());
    await world.sql`update catalyst_kb.source_items set parents='[]'::jsonb`;
    await world.publishSources([
      { id: SOURCE, connection: "fixture", folders: ["folder", "other", "third"] }
    ]);
    await world.worker.runDue();
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "fetched" }
    ]);
    expect(await world.sql`select withdrawn_at from catalyst_kb.documents`).toEqual([
      { withdrawn_at: null }
    ]);
  });

  it("defers folder narrowing until a complete pass learns the upgraded items' membership", async () => {
    const world = await setup();
    for (let n = 0; n < 4; n++) world.world.put(file(`inside-${n}.txt`));
    const outside = world.world.put({ ...file("outside.txt"), folderId: "other" });
    await world.drain(await world.sync());
    // Use the actual migration default, so this also guards its unknown marker.
    await world.sql`update catalyst_kb.source_items set parents=default`;
    expect(await world.sql`select distinct parents from catalyst_kb.source_items`).toEqual([
      { parents: [] }
    ]);
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["folder"] }]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "outside" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    expect(hits.body).toContain("outside.txt");
    await world.worker.runDue();
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.source_items where state='withdrawn'`
    ).toEqual([{ n: 0 }]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is not null`
    ).toEqual([{ n: 0 }]);

    // One of five items is exactly the threshold: the fresh, complete listing can
    // withdraw it without confirmation, and fills ancestry for every retained item.
    await world.drain(await world.sync("full"));
    expect(
      await world.sql`select state from catalyst_kb.source_items where item_id=${outside}`
    ).toEqual([{ state: "withdrawn" }]);
    expect(
      await world.sql`select distinct parents from catalyst_kb.source_items where state='fetched'`
    ).toEqual([{ parents: ["folder"] }]);
  });

  it.each([{ include: ["*.md"] }, { exclude: ["*.txt"] }])(
    "still applies name and path rules to unknown ancestry: %j",
    async (rule) => {
      const world = await setup();
      world.world.put(file("filtered.txt"));
      await world.drain(await world.sync());
      await world.sql`update catalyst_kb.source_items set parents='[]'::jsonb`;
      await world.publishSources([
        { id: SOURCE, connection: "fixture", folders: ["folder", "other"], ...rule }
      ]);
      const hits = await world.instance.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: "filtered" }
      });
      expect(hits.statusCode, hits.body).toBe(200);
      expect(hits.body).not.toContain("filtered.txt");
      await world.worker.runDue();
      expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
        { state: "withdrawn" }
      ]);
    }
  );
});

it("reserves empty parents for unknown ancestry rather than a valid connector item", () => {
  const item = {
    id: "item",
    version: "1",
    path: "/known.txt",
    name: "known.txt",
    mime: "text/plain",
    size: 1,
    modifiedAt: "2026-10-17T00:00:00Z",
    parents: ["folder"]
  };
  expect(documentSourceItemSchema.safeParse(item).success).toBe(true);
  expect(documentSourceItemSchema.safeParse({ ...item, parents: [] }).success).toBe(false);
});
