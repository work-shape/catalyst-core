import { describe, expect, it } from "vitest";
import { eventually } from "./support/assertions";
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
    await world.sql`update catalyst_kb.source_items set parents=default,seen_run_id=null`;
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
    await world.sql`update catalyst_kb.source_items set parents=default,seen_run_id=null`;
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

  it.each([
    { narrowing: "folder", folders: ["folder"] },
    { narrowing: "include", folders: ["folder", "other"], include: ["inside-*"] },
    { narrowing: "exclude", folders: ["folder", "other"], exclude: ["outside*"] }
  ])(
    "KB 47 / SRC-3b: $narrowing narrowing hides unknown parents at publish and starts a full pass at once",
    async ({ narrowing: _narrowing, ...boundary }) => {
      const world = await setup();
      for (let n = 0; n < 4; n++) world.world.put(file(`inside-${n}.txt`));
      const outside = world.world.put({ ...file("outside.txt"), folderId: "other" });
      await world.drain(await world.sync());
      // Use the actual migration default, so this also guards its unknown marker.
      await world.sql`update catalyst_kb.source_items set parents=default,seen_run_id=null`;
      expect(await world.sql`select distinct parents from catalyst_kb.source_items`).toEqual([
        { parents: [] }
      ]);
      await world.publishSources([{ id: SOURCE, connection: "fixture", ...boundary }]);
      const hits = await world.instance.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: "outside" }
      });
      expect(hits.statusCode, hits.body).toBe(200);
      expect(hits.body).not.toContain("outside.txt");
      await world.worker.runDue();
      const [automatic] =
        await world.sql`select id,mode from catalyst_kb.sync_runs where id<>'sync-1'`;
      expect(automatic?.mode).toBe("full");
      // No manual sync: publishing alone learns membership and withdraws the missing fifth.
      expect(automatic?.id).toBeTypeOf("string");
      await world.drain(String(automatic?.id));
      expect(
        await world.sql`select state from catalyst_kb.source_items where item_id=${outside}`
      ).toEqual([{ state: "withdrawn" }]);
      expect(
        await world.sql`select distinct parents from catalyst_kb.source_items where state='fetched'`
      ).toEqual([{ parents: ["folder"] }]);
      const retained = await world.instance.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: "inside" }
      });
      expect(retained.body).toContain("inside-");
    }
  );

  it("KB 47 / SRC-3b: unknown removed folders stay hidden while the full pass waits for withdrawal confirmation", async () => {
    const world = await setup();
    world.world.put({ ...file("unknown-removed.txt"), folderId: "other" });
    await world.drain(await world.sync());
    await world.sql`update catalyst_kb.source_items set parents=default,seen_run_id=null`;
    await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["folder"] }]);
    await eventually(async () => {
      await world.worker.runDue();
      const pending = await world.instance.api.call("approval_requests.list", {
        query: { status: "pending" }
      });
      expect(pending.json<{ items: { id: string }[] }>().items).toHaveLength(1);
    });
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "unknown" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    expect(hits.body).not.toContain("unknown-removed.txt");
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "fetched" }
    ]);
  });

  it.each([{ include: ["*.md"] }, { exclude: ["*.txt"] }])(
    "still applies name and path rules to unknown ancestry: %j",
    async (rule) => {
      const world = await setup();
      world.world.put(file("filtered.txt"));
      await world.drain(await world.sync());
      await world.sql`update catalyst_kb.source_items set parents=default,seen_run_id=null`;
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
