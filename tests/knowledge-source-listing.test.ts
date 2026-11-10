import { describe, expect, it, vi } from "vitest";
import { DocumentSourceError, type DocumentSourceListInput } from "@work-shape/catalyst-core";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { required } from "./support/assertions";

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
