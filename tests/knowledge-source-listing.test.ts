import { describe, expect, it, vi } from "vitest";
import {
  DocumentSourceError,
  type DocumentSourceListInput,
  documentSourceItemSchema
} from "@work-shape/catalyst-core";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { required, eventually } from "./support/assertions";

// What a pass does at `knowledge.maxDocuments`, which folders it asks the source not to walk, and
// how often it writes a large listing position.

const SOURCE = "source";
const file = (name: string) => ({
  folderId: "folder",
  name,
  mime: "text/plain",
  bytes: new TextEncoder().encode(name)
});

type World = Awaited<ReturnType<ReturnType<typeof useKnowledgeSync>["setup"]>>;

/** Runs the jobs until the run has ended, whichever way. */
async function ended(world: World, run: string) {
  await vi.waitFor(
    async () => {
      await world.platform`update platform_jobs set run_after=now() where status='queued' and kind in ('knowledge_base.sync','knowledge_base.fetch')`;
      await world.worker.runDue();
      const [row] = await world.sql`select state from catalyst_kb.sync_runs where id=${run}`;
      expect(row?.state).not.toBe("running");
    },
    { timeout: 120_000 }
  );
  const [row] =
    await world.sql`select state,failure_code,mode from catalyst_kb.sync_runs where id=${run}`;
  return required(row);
}

const items = (world: World) =>
  world.sql`select name,state,version from catalyst_kb.source_items order by name`;

describe("a source at knowledge.maxDocuments", () => {
  const { setup } = useKnowledgeSync({ maxDocuments: 10 });

  it("withdraws and changes what a full pass finds, and holds back only new documents", async () => {
    const world = await setup();
    const ids = Array.from({ length: 10 }, (_, index) => world.world.put(file(`${index}.txt`)));
    await world.drain(await world.sync());
    world.world.remove(required(ids[0]));
    world.world.write(required(ids[1]), new TextEncoder().encode("changed"));
    world.world.put(file("new-a.txt"));
    world.world.put(file("new-b.txt"));
    const run = await world.sync("full");
    expect(await ended(world, run)).toEqual({
      state: "failed",
      failure_code: "knowledge_source_limit_reached",
      mode: "full"
    });
    const rows = await items(world);
    expect(rows.find((row) => row.name === "0.txt")?.state).toBe("withdrawn");
    expect(rows.find((row) => row.name === "1.txt")).toEqual({
      name: "1.txt",
      state: "fetched",
      version: "v2"
    });
    expect(rows.filter((row) => String(row.name).startsWith("new-"))).toEqual([]);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.documents where withdrawn_at is null`
    ).toEqual([{ n: 9 }]);
    // The next pass has room for one of them.
    const next = await world.sync("full");
    expect(await ended(world, next)).toEqual({
      state: "failed",
      failure_code: "knowledge_source_limit_reached",
      mode: "full"
    });
    expect(
      (await items(world)).filter(
        (row) => String(row.name).startsWith("new-") && row.state !== "withdrawn"
      )
    ).toHaveLength(1);
  });

  it("applies a change feed's deletions past a new item it holds back, and polls on", async () => {
    const world = await setup();
    const ids = Array.from({ length: 10 }, (_, index) => world.world.put(file(`${index}.txt`)));
    await world.drain(await world.sync());
    world.world.put(file("new.txt"));
    world.world.remove(required(ids[0]));
    const run = await world.sync("changes");
    expect(await ended(world, run)).toEqual({
      state: "failed",
      failure_code: "knowledge_source_limit_reached",
      mode: "changes"
    });
    const rows = await items(world);
    expect(rows.find((row) => row.name === "0.txt")?.state).toBe("withdrawn");
    expect(rows.find((row) => row.name === "new.txt")).toBeUndefined();
    // The feed moved past the page: the next poll has nothing to apply and ends done.
    const poll = await world.sync("changes");
    expect(await ended(world, poll)).toEqual({
      state: "done",
      failure_code: null,
      mode: "changes"
    });
    // A full pass finds what waited, now that there is room.
    await world.drain(await world.sync("full"));
    expect((await items(world)).find((row) => row.name === "new.txt")?.state).toBe("fetched");
  });

  it("counts a first import that reached the limit as an import, so polls stay polls", async () => {
    const world = await setup();
    for (let index = 0; index < 12; index++) world.world.put(file(`${index}.txt`));
    const first = await world.sync();
    expect(await ended(world, first)).toEqual({
      state: "failed",
      failure_code: "knowledge_source_limit_reached",
      mode: "initial"
    });
    const poll = await world.sync("changes");
    expect(await ended(world, poll)).toMatchObject({ mode: "changes" });
  });
});

describe("a source's listing", () => {
  const { setup } = useKnowledgeSync();

  it("asks the source to skip the folders its exclude leaves out", async () => {
    const asked: DocumentSourceListInput[] = [];
    const world = await setup((source) => ({
      ...source,
      list(input, context) {
        asked.push(input);
        return source.list(input, context);
      }
    }));
    world.world.put(file("a.txt"));
    await world.drain(await world.sync());
    expect(asked.at(-1)?.excludesFolder).toBeUndefined();
    await world.publishSources([
      {
        id: SOURCE,
        connection: "fixture",
        folders: ["folder"],
        exclude: ["Projekte/Projekt [alt]/**", "**/Personal/**"]
      }
    ]);
    await world.drain(await world.sync("full"));
    const skips = required(asked.at(-1)?.excludesFolder);
    expect(skips("/Projekte/Projekt [alt]")).toBe(true);
    expect(skips("/Projekte/Projekt [alt]/.git")).toBe(true);
    expect(skips("/a/Personal")).toBe(true);
    expect(skips("/Projekte")).toBe(false);
    expect(skips("/Projekte/Projekt a")).toBe(false);
  });

  it("writes a large listing position once, not with every page, and keeps it on a rate limit", async () => {
    // A listing position of 64 KiB, as a walk that carries the folders still to list has; one
    // item per page.
    const pad = "x".repeat(64 * 1024);
    let calls = 0;
    let limited = false;
    const world = await setup((source) => ({
      ...source,
      async list(input, context) {
        calls += 1;
        if (calls === 10 && !limited) {
          limited = true;
          throw new DocumentSourceError("rate_limited", "Wait", { retryAfterMs: 1 });
        }
        const at = z(input.pageToken);
        const page = await source.list(
          { boundary: input.boundary, ...(at.inner ? { pageToken: at.inner } : {}) },
          context
        );
        const following =
          at.offset + 1 < page.items.length
            ? { inner: at.inner, offset: at.offset + 1 }
            : page.nextPageToken
              ? { inner: page.nextPageToken, offset: 0 }
              : undefined;
        return {
          items: page.items.slice(at.offset, at.offset + 1),
          ...(following ? { nextPageToken: pad + JSON.stringify(following) } : {})
        };
      }
    }));
    function z(token: string | undefined): { inner?: string; offset: number } {
      return token ? JSON.parse(token.slice(pad.length)) : { offset: 0 };
    }
    for (let index = 0; index < 20; index++) world.world.put(file(`${index}.txt`));
    await world.sql.unsafe(`
      create table public.position_writes (chars int not null);
      create function count_position() returns trigger language plpgsql as $$ begin
        if new.cursor_after is distinct from old.cursor_after then
          insert into public.position_writes values (coalesce(length(new.cursor_after), 0));
        end if;
        return new;
      end $$;
      create trigger count_position after update on catalyst_kb.sync_runs
        for each row execute function count_position();`);
    await world.drain(await world.sync());
    // 20 pages, and the call the rate limit refused: no page was listed twice.
    expect(calls).toBe(21);
    expect(
      await world.sql`select count(*)::int as n from catalyst_kb.source_items where state='fetched'`
    ).toEqual([{ n: 20 }]);
    // The first page of each of the two jobs and the position kept at the rate limit; a page
    // per write would be 19.
    expect(
      await world.sql`select count(*)::int as n from public.position_writes where chars > ${pad.length}`
    ).toEqual([{ n: 3 }]);
  });
});

const KB = "sync-test";

describe("source items with unknown ancestry (parents = [])", () => {
  const { setup } = useKnowledgeSync();
  const file = (name: string) => ({
    folderId: "folder",
    name,
    mime: "text/plain",
    bytes: new TextEncoder().encode(name)
  });

  it("finds pre-upgrade documents before their full pass and retains them when folders widen", async () => {
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

  it.each([{ narrowing: "folder", folders: ["folder"] }])(
    "KB 47 / SRC-3b: $narrowing narrowing hides unknown parents listed at the old boundary and starts a full pass",
    async ({ narrowing: _narrowing, ...boundary }) => {
      const world = await setup();
      for (let n = 0; n < 4; n++) world.world.put(file(`inside-${n}.txt`));
      const outside = world.world.put({ ...file("outside.txt"), folderId: "other" });
      await world.drain(await world.sync());
      // Keep the old listing key but lose ancestry, as when only the boundary is known.
      await world.sql`update catalyst_kb.source_items set parents=default`;
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

  it("KB 47 / SRC-3b: unknown parents listed at the old boundary stay hidden while the full pass waits for confirmation", async () => {
    const world = await setup();
    world.world.put({ ...file("unknown-removed.txt"), folderId: "other" });
    await world.drain(await world.sync());
    await world.sql`update catalyst_kb.source_items set parents=default`;
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
