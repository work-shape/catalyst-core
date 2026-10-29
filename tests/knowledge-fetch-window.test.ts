import { describe, expect, it } from "vitest";
import { AppError, knowledgeFetchJob } from "@work-shape/catalyst-core";
import { eventually } from "./support/assertions";
import { useKnowledgeSync } from "./support/knowledge-sync";

// The fetch window (KB-ISO-3b): a Knowledge Base holds at most so many fetched items, and so
// many bytes, whose content has not yet left `pending`. A fetch batch that finds it full queues
// its rest after 60 seconds and spends no attempt, or sooner once indexing frees half the
// window. Spec: data-stores-and-knowledge-bases.md,
// Throughput, check 104. The window here is 4 items instead of 2,000.

const WINDOW = 4;

describe("the fetch window of a Knowledge Base (KB-ISO-3b)", () => {
  const { setup } = useKnowledgeSync({
    fetchWindow: { items: WINDOW, bytes: 1024 ** 3 }
  });

  it("stops fetching at the window while indexing waits, queues the rest after a minute without spending an attempt, and finishes once indexing goes on", async () => {
    const world = await setup();
    // Indexing pauses: the embedding model answers 429, so every content stays `pending`.
    world.embed.mockRejectedValue(new AppError("RATE_LIMITED", "The model asks to wait"));
    for (let item = 0; item < 10; item++)
      world.world.put({
        folderId: "folder",
        name: `${item}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode(`Unterlage ${item} über die Wohnung.`)
      });
    const run = await world.sync();

    const waiting = async () =>
      (
        await world.platform<{ payload: unknown; attempts: number; wait_s: number }[]>`
          select payload, attempts, extract(epoch from run_after - now())::float8 as wait_s
          from platform_jobs where kind = 'knowledge_base.fetch' and status = 'queued'`
      ).map((row) => ({
        ids: knowledgeFetchJob.payloadSchema.parse(row.payload).sourceItemIds,
        attempts: row.attempts,
        wait: row.wait_s
      }));
    const items = () =>
      world.sql<{ state: string; attempts: number; claimed: boolean }[]>`
        select state, attempts, fetch_job_id is not null as claimed from catalyst_kb.source_items`;

    await eventually(async () => {
      await world.platform`update platform_jobs set run_after = now()
        where status = 'queued' and kind = 'knowledge_base.sync'`;
      await world.worker.runDue();
      expect((await items()).filter((item) => item.state === "fetched")).toHaveLength(WINDOW);
      expect((await waiting()).map((job) => job.wait > 0)).toEqual([true]);
    });
    const [pending] = await world.sql<{ n: number }[]>`
      select count(*)::int as n from catalyst_kb.contents where state = 'pending'`;
    expect(pending?.n).toBe(WINDOW);
    const [documents] = await world.sql<{ n: number }[]>`
      select count(*)::int as n from catalyst_kb.documents`;
    expect(documents?.n).toBe(WINDOW);
    // The rest waits a minute in a job of its own that has spent no attempt, and no item has.
    const [rest] = await waiting();
    expect(rest?.ids).toHaveLength(10 - WINDOW);
    expect(rest?.attempts).toBe(0);
    expect(rest?.wait).toBeGreaterThan(50);
    expect(rest?.wait).toBeLessThanOrEqual(60);
    expect((await items()).filter((item) => item.state === "discovered")).toEqual(
      Array.from({ length: 10 - WINDOW }, () => ({
        state: "discovered",
        attempts: 0,
        claimed: false
      }))
    );

    // Due again while the window is still full: it fetches nothing and waits once more, again
    // without an attempt.
    await world.platform`update platform_jobs set run_after = now()
      where status = 'queued' and kind = 'knowledge_base.fetch'`;
    await world.worker.runDue();
    expect((await items()).filter((item) => item.state === "fetched")).toHaveLength(WINDOW);
    const [again] = await waiting();
    expect(again?.ids).toHaveLength(10 - WINDOW);
    expect(again?.attempts).toBe(0);
    expect(again?.wait).toBeGreaterThan(50);
    expect(
      (await items()).filter((item) => item.state === "discovered" && item.attempts === 0)
    ).toHaveLength(10 - WINDOW);
    const [runRow] = await world.sql<{ state: string }[]>`
      select state from catalyst_kb.sync_runs where id = ${run}`;
    expect(runRow?.state).toBe("running");

    // Indexing goes on: the window empties, the rest is fetched, and the run ends.
    world.embed.mockImplementation(async ({ texts }: { texts: readonly string[] }) => ({
      vectors: texts.map(() => Array.from({ length: 8 }, () => 0.25))
    }));
    // A content that leaves `pending` with at most half the window held makes the waiting batch
    // due at once: only the index jobs are brought forward here, and the rest is fetched.
    expect((await waiting())[0]?.wait).toBeGreaterThan(50);
    await eventually(async () => {
      await world.platform`update platform_jobs set run_after = now()
        where status = 'queued' and kind = 'knowledge_base.index'`;
      await world.worker.runDue();
      expect((await items()).filter((item) => item.state === "fetched")).toHaveLength(10);
    }, 30_000);
    await eventually(async () => {
      await world.platform`update platform_jobs set run_after = now() where status = 'queued'
          and kind in ('knowledge_base.sync', 'knowledge_base.fetch', 'knowledge_base.index')`;
      await world.worker.runDue();
      expect((await items()).filter((item) => item.state === "fetched")).toHaveLength(10);
      const [unindexed] = await world.sql<{ n: number }[]>`
          select count(*)::int as n from catalyst_kb.contents where state <> 'extracted'`;
      expect(unindexed?.n).toBe(0);
      const [ended] = await world.sql<{ state: string }[]>`
          select state from catalyst_kb.sync_runs where id = ${run}`;
      expect(ended?.state).toBe("done");
    }, 60_000);
  });
});
