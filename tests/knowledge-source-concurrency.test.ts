import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { fileTestDatabaseUrl } from "./support/test-database";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { eventually, required } from "./support/assertions";
const KB = "sync-test";
describe("source concurrency (SRC-3a)", () => {
  const { setup } = useKnowledgeSync();
  const file = (name: string) => ({
    folderId: "folder",
    name,
    mime: "text/plain",
    bytes: new TextEncoder().encode(name)
  });
  it("drops a hit whose document is purged while its published-boundary check waits", async () => {
    const world = await setup();
    world.world.put(file("purged-during-search.txt"));
    await world.drain(await world.sync());
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${world.record.location.database}`;
    const blocker = postgres(url.toString(), { max: 1, onnotice() {} });
    let unlock = () => {},
      locked = () => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.begin(async (sql) => {
      await sql`lock table catalyst_kb.source_items in access exclusive mode`;
      locked();
      await gate;
      await sql`update catalyst_kb.documents set withdrawn_at=now()`;
      await sql`delete from catalyst_kb.documents`;
    });
    await ready;
    const searching = world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "purged" }
    });
    try {
      await eventually(async () => {
        const [row] =
          await world.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select d.id,i.source_id,i.parents%'`;
        expect(row?.n).toBeGreaterThan(0);
      });
    } finally {
      unlock();
      await blocking;
      await blocker.end();
    }
    const response = await searching;
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("purged-during-search.txt");
  });
  it("an old withdrawal cannot cancel a rediscovered item's fetch while its purge is queued", async () => {
    let restore = false;
    const world = await setup((source) => ({
      ...source,
      async changes(input, context) {
        const page = await source.changes(input, context);
        const upsert =
          page.kind === "changes"
            ? page.changes.find((change) => change.kind === "upsert")
            : undefined;
        if (restore && page.kind === "changes" && upsert) {
          restore = false;
          return {
            ...page,
            changes: [{ kind: "delete" as const, item: { id: upsert.item.id } }, ...page.changes]
          };
        }
        return page;
      }
    }));
    const item = world.world.put(file("before-restore.txt"));
    await world.drain(await world.sync());
    restore = true;
    world.world.rename(item, "after-restore.txt");
    const run = await world.sync("changes");
    await world.worker.runDue();
    const [fetch] =
      await world.platform`select id from platform_jobs where kind='knowledge_base.fetch' and status='queued'`;
    const fetchId = String(required(fetch).id);
    // The new fetch has a durable claim but has not handed off a document yet.
    await world.sql`update catalyst_kb.source_items set fetch_job_id=${fetchId}`;
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where id=${fetchId}`;
    await world.worker.runDue();
    expect(
      await world.sql`select state,document_id,fetch_job_id from catalyst_kb.source_items`
    ).toEqual([{ state: "discovered", document_id: null, fetch_job_id: fetchId }]);
    await world.drain(run);
    expect(
      await world.sql`select state,withdrawn_at,purged_at from catalyst_kb.source_items`
    ).toEqual([{ state: "fetched", withdrawn_at: null, purged_at: null }]);
    expect(
      await world.sql`select state,items::int from catalyst_kb.source_counts where items>0`
    ).toEqual([{ state: "indexed", items: 1 }]);
    const hits = await world.instance.api.call("knowledge_bases.search", {
      params: { knowledgeBase: KB },
      payload: { query: "after" }
    });
    expect(hits.body).toContain("after-restore.txt");
  });
  it("withdrawal follows the indexer's content-before-item lock order", async () => {
    const world = await setup();
    const item = world.world.put(file("lock-order.txt"));
    await world.drain(await world.sync());
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${world.record.location.database}`;
    const blocker = postgres(url.toString(), { max: 1, onnotice() {} });
    let advance = () => {},
      locked = () => {};
    const gate = new Promise<void>((resolve) => {
      advance = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.begin(async (sql) => {
      await sql`select sha256 from catalyst_kb.contents for update`;
      locked();
      await gate;
      // An index completion must still be able to project this item while withdrawal
      // waits for its content. NOWAIT makes a reversed lock order fail immediately.
      await sql`select id from catalyst_kb.source_items for update nowait`;
      await sql`update catalyst_kb.source_items set open_change_at=null`;
    });
    await ready;
    world.world.remove(item);
    const run = await world.sync("changes");
    const withdrawing = world.worker.runDue();
    try {
      await eventually(async () => {
        const [row] =
          await world.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
        expect(row?.n).toBeGreaterThan(0);
      });
    } finally {
      advance();
      try {
        await blocking;
      } finally {
        await withdrawing;
        await blocker.end();
      }
    }
    await world.drain(run);
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "withdrawn" }
    ]);
  });
  it("does not borrow a platform transaction while waiting for a sync run row", async () => {
    const world = await setup();
    const run = await world.sync("full");
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where kind='knowledge_base.sync' and status='queued'`;
    await world.publishSources([]);
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${world.record.location.database}`;
    const blocker = postgres(url.toString(), { max: 1, onnotice() {} });
    let release = () => {},
      locked = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocking = blocker.begin(async (sql) => {
      await sql`select id from catalyst_kb.sync_runs where id=${run} for update`;
      locked();
      await gate;
    });
    await ready;
    let active = 0;
    const original = world.instance.stores.transaction.bind(world.instance.stores);
    const spy = vi.spyOn(world.instance.stores, "transaction").mockImplementation(async (work) => {
      active++;
      try {
        return await original(work);
      } finally {
        active--;
      }
    });
    const reconciling = world.worker.runDue();
    try {
      await eventually(async () => {
        const [row] =
          await world.sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`;
        expect(row?.n).toBeGreaterThan(0);
      });
      expect(active).toBe(0);
    } finally {
      release();
      try {
        await blocking;
        await reconciling;
      } finally {
        spy.mockRestore();
        await blocker.end();
      }
    }
  });
});
