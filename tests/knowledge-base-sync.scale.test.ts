import { describe, expect, it } from "vitest";
import { DocumentSourceError, knowledgeFetchJob } from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";

const KB = "sync-test";

describe("source import volume", () => {
  const { setup } = useKnowledgeSync();
  it("queues 1000 ids once across listing 429 resumes and claims duplicate batches without orphan copies", async () => {
    let listCalls = 0;
    let release = false;
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const calls = new Map<string, number>();
    const world = await setup((source) => ({
      ...source,
      list(input, ctx) {
        if (++listCalls % 2 === 0)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 60000 });
        return source.list(input, ctx);
      },
      async *fetch(input, ctx) {
        if (!release)
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 60000 });
        calls.set(input.itemId, (calls.get(input.itemId) ?? 0) + 1);
        await gate;
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < 1000; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("shared text")
      });
    const run = await world.sync();
    for (let page = 0; page < 10; page++) {
      await world.platform`update platform_jobs set run_after=now() where kind='knowledge_base.sync' and status='queued'`;
      await world.worker.runDue();
    }
    const queued =
      await world.platform`select payload from platform_jobs where kind='knowledge_base.fetch' and status='queued'`;
    expect(queued).toHaveLength(10);
    const payloads = queued.map((row) => knowledgeFetchJob.payloadSchema.parse(row.payload));
    expect(payloads.flatMap((payload) => payload.sourceItemIds)).toHaveLength(1000);
    // Park the normal queue, then start two identical batches together. Hold their
    // streams until both handlers reach fetch: the claim must let them fetch different
    // items, and removing the claim predicate must produce duplicate calls.
    await world.platform`update platform_jobs set run_after=now()+interval '1 day' where kind='knowledge_base.fetch' and status='queued'`;
    const payload = required(payloads[0]);
    for (let duplicate = 0; duplicate < 2; duplicate++)
      await world.instance.stores.jobs.enqueue(knowledgeFetchJob, payload, { clientInstanceId });
    release = true;
    const racing = world.worker.runDue();
    try {
      await eventually(() =>
        expect([...calls.values()].reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(2)
      );
    } finally {
      unblock();
      await racing;
    }
    await world.drain(run);
    expect(calls.size).toBe(1000);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(
      await world.platform`select count(*)::int as n from managed_files where owner_id=${world.record.id}`
    ).toEqual([{ n: 1000 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 1000 }
    ]);
  }, 180000);

  it("imports a source of many pages and batches, isolates three failed fetches, and makes zero fetch or embedding calls on the second full pass", async () => {
    // 1,250 items cross 13 listing pages of 100, the last one short, and queue 13 fetch
    // batches of 100: every paging and batching path a 10,000-item source takes. Fetching runs
    // at some 65 items a second, so 10,000 items took about 176 seconds, at the drain limit.
    const items = 1250;
    let fetches = 0;
    let pages = 0;
    const world = await setup((source) => ({
      ...source,
      list(input, ctx) {
        pages++;
        return source.list(input, ctx);
      },
      async *fetch(input, ctx) {
        fetches++;
        if (input.itemId === "f1")
          throw new DocumentSourceError("unavailable", "Fixture unavailable");
        yield* source.fetch(input, ctx);
      }
    }));
    for (let i = 0; i < items; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode("Shared searchable text")
      });
    await world.drain(await world.sync());
    expect(
      await world.sql`select state, attempts, failure_code from catalyst_kb.source_items where item_id = 'f1'`
    ).toMatchObject([{ state: "failed", attempts: 3, failure_code: "knowledge_fetch_failed" }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.source_items`).toMatchObject([
      { n: items }
    ]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toMatchObject([
      { n: items - 1 }
    ]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'extracted'`
    ).toMatchObject([{ n: 1 }]);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.chunks`).toMatchObject([
      { n: 1 }
    ]);
    expect(pages).toBe(13);
    const statusStarted = performance.now();
    const status = await world.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: KB }
    });
    const statusMs = performance.now() - statusStarted;
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      sources: [
        {
          items: { indexed: items - 1, failed: 1 },
          failures: [{ code: "knowledge_fetch_failed", count: 1 }]
        }
      ]
    });
    console.info(JSON.stringify({ probe: "SRC-1b source status", items, durationMs: statusMs }));
    expect(fetches).toBe(items + 2);
    expect(world.embed).toHaveBeenCalledTimes(1);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.embeddings_1`).toEqual([
      { n: 1 }
    ]);
    const extractions = await world.objects.list(`knowledge-bases/${world.record.id}/extracted/`);
    expect(extractions.objects).toHaveLength(1);
    const before = world.embed.mock.calls.length;
    fetches = 0;
    await world.drain(await world.sync("full"));
    expect(fetches).toBe(0);
    expect(world.embed.mock.calls.length).toBe(before);
    expect(await world.objects.list(`knowledge-bases/${world.record.id}/extracted/`)).toEqual(
      extractions
    );
  }, 240_000);
});
