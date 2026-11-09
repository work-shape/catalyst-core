import { describe, expect, it } from "vitest";
import type { DocumentSourceCapability } from "@work-shape/catalyst-core";
import { changesDueAt, scheduledPass, sourceTickJob } from "@work-shape/catalyst-data-stores";
import { required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";

// The source's own schedule (SRC-3, KB 79). Nothing here starts a pass by hand once the first
// import is done: every later pass comes from the tick, on a clock the test sets.

const SOURCE = "source";
const file = (name: string, folderId = "folder") => ({
  folderId,
  name,
  mime: "text/plain",
  bytes: new TextEncoder().encode(name)
});

let clock = new Date(0);

interface Calls {
  list: number;
  changes: number;
  fetch: number;
}

/** Counts the calls to the source, and takes away its change feed where it has none. */
function counting(calls: Calls, feed = true) {
  return (source: DocumentSourceCapability): DocumentSourceCapability => ({
    ...source,
    list: (input, context) => {
      calls.list += 1;
      return source.list(input, context);
    },
    changes: (input, context) => {
      calls.changes += 1;
      return feed ? source.changes(input, context) : Promise.resolve({ kind: "not_offered" });
    },
    fetch: (input, context) => {
      calls.fetch += 1;
      return source.fetch(input, context);
    }
  });
}

const noCalls = (): Calls => ({ list: 0, changes: 0, fetch: 0 });

type World = Awaited<ReturnType<ReturnType<typeof useKnowledgeSync>["setup"]>>;

/** Writes the times of what ran since onto the test's clock: the store stamps its own. */
async function stamp(world: World) {
  await world.sql`update catalyst_kb.sync_runs set started_at=least(started_at,${clock}),ended_at=case when ended_at is null then null else least(ended_at,${clock}) end`;
}

async function runJobs(world: World) {
  // A job may queue the next one, and a fetch's retry waits: make what is queued due.
  for (let round = 0; round < 5; round += 1) {
    const queued = await world.platform`
      update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%' returning id`;
    if (!queued.length) break;
    await world.worker.runDue();
  }
  await stamp(world);
}

/** One tick at this time, with whatever it started run to its end or its wait. */
async function tick(world: World, at: Date | string) {
  clock = new Date(at);
  await world.instance.stores.jobs.enqueue(sourceTickJob, {}, { clientInstanceId });
  await runJobs(world);
}

/** The first import, done at this time. */
async function imported(world: World, at: string) {
  clock = new Date(at);
  await world.drain(await world.sync());
  await stamp(world);
}

const passes = (world: World, mode: string, sourceId = SOURCE) =>
  world.sql<{ id: string; state: string; started_at: Date }[]>`
    select id,state,started_at from catalyst_kb.sync_runs where source_id=${sourceId} and mode=${mode} order by started_at`;

const runCount = async (world: World) =>
  required(
    (await world.sql<{ n: number }[]>`select count(*)::int as n from catalyst_kb.sync_runs`)[0]
  ).n;

const addMinutes = (at: Date | string, minutes: number) =>
  new Date(new Date(at).getTime() + minutes * 60_000);

describe("the source tick keeps a source current (SRC-3, KB 79)", () => {
  const { setup } = useKnowledgeSync({ sourceTick: { now: () => clock } });

  it("withdraws a deleted file and purges it within the bounds, with no pass started by hand", async () => {
    const calls = noCalls();
    const world = await setup(counting(calls));
    const deleted = world.world.put(file("deleted.txt"));
    world.world.put(file("kept.txt"));
    world.world.put(file("kept-too.txt"));
    world.world.put(file("kept-as-well.txt"));
    world.world.put(file("kept-four.txt"));
    world.world.put(file("kept-five.txt"));
    await imported(world, "2025-01-07T09:00:00Z");
    const embeds = world.embed.mock.calls.length;
    const audited = async () =>
      required(
        (
          await world.platform<{ n: number }[]>`
            select count(*)::int as n from audit_events where type in ('knowledge_base.sync_started','knowledge_base.sync_finished')`
        )[0]
      ).n;
    const auditedAfterImport = await audited();
    Object.assign(calls, noCalls());

    // The first poll of an idle source: one call to the feed, and nothing else at all.
    await tick(world, "2025-01-07T10:00:00Z");
    expect(calls).toEqual({ list: 0, changes: 1, fetch: 0 });
    expect(world.embed.mock.calls.length).toBe(embeds);
    expect(await audited()).toBe(auditedAfterImport);
    const [poll] = await passes(world, "changes");
    expect(poll?.state).toBe("done");
    const sources = await world.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: "sync-test" }
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.body).toContain('"mode":"changes"');

    world.world.remove(deleted);
    const removedAt = clock;
    let withdrawnAfter: number | undefined;
    for (let minute = 1; minute <= 20 && withdrawnAfter === undefined; minute += 1) {
      await tick(world, addMinutes(removedAt, minute));
      const [item] = await world.sql<{ state: string; purged: boolean }[]>`
        select state,purged_at is not null as purged from catalyst_kb.source_items where item_id=${deleted}`;
      if (item?.state === "withdrawn") {
        withdrawnAfter = minute;
        expect(item.purged).toBe(true);
      }
    }
    expect(required(withdrawnAfter)).toBeLessThanOrEqual(16);
    expect(await audited()).toBe(auditedAfterImport + 1);
    expect(await passes(world, "full")).toEqual([]);
    expect(calls.list).toBe(0);
    expect(calls.fetch).toBe(0);
  });

  it("does not poll twice for one due time, and a schedule changed alone stops no sync", async () => {
    const world = await setup();
    world.world.put(file("one.txt"));
    await imported(world, "2025-01-07T09:00:00Z");
    await tick(world, "2025-01-07T10:00:00Z");
    expect((await passes(world, "changes")).length).toBe(1);
    await tick(world, "2025-01-07T10:00:30Z");
    expect((await passes(world, "changes")).length).toBe(1);

    await world.publishSources([
      {
        id: SOURCE,
        connection: "fixture",
        folders: ["folder", "other"],
        schedule: { full: "0 4 * * *" }
      }
    ]);
    expect(
      await world.platform`select id from platform_jobs where kind='knowledge_base.reconcile_sources'`
    ).toEqual([]);
  });

  it("gives one full pass after downtime over several nights, and one again at the next", async () => {
    const world = await setup();
    world.world.put(file("one.txt"));
    await imported(world, "2025-01-06T01:00:00Z");

    // The first tick of a process that was down from Monday to Thursday.
    await tick(world, "2025-01-09T10:00:00Z");
    const scheduledFor = new Date("2025-01-09T02:00:00Z");
    const { key, payload } = scheduledPass(world.record.id, SOURCE, "full", scheduledFor);
    expect((await passes(world, "full")).map((run) => run.id)).toEqual([payload.syncRunId]);
    expect(
      await world.platform`select dedupe_key from platform_jobs where kind='knowledge_base.sync' and dedupe_key=${`knowledge_base.sync:${key}`}`
    ).toHaveLength(1);

    await tick(world, "2025-01-09T10:01:00Z");
    expect((await passes(world, "full")).length).toBe(1);

    // Down again over two nights, this process having looked at the source before.
    await tick(world, "2025-01-11T10:00:00Z");
    expect((await passes(world, "full")).length).toBe(2);
    await tick(world, "2025-01-11T10:15:00Z");
    expect((await passes(world, "full")).length).toBe(2);
  });

  it("does not poll a source without a change feed, and lists it at its full pass alone", async () => {
    const calls = noCalls();
    const world = await setup(counting(calls, false));
    world.world.put(file("one.txt"));
    await imported(world, "2025-01-06T08:00:00Z");
    Object.assign(calls, noCalls());

    const start = new Date("2025-01-06T08:15:00Z");
    for (let quarter = 0; quarter < 71; quarter += 1)
      await tick(world, addMinutes(start, quarter * 15));
    // The last of those was 01:45 the next night.
    expect(calls).toEqual(noCalls());
    await tick(world, "2025-01-07T02:00:00Z");
    expect(calls.list).toBe(1);
    await tick(world, "2025-01-07T02:15:00Z");
    await tick(world, "2025-01-07T02:30:00Z");
    expect(calls.list).toBe(1);
    expect(await passes(world, "changes")).toEqual([]);
    expect((await passes(world, "full")).length).toBe(1);
  });

  it("leaves a pass waiting on a withdrawal confirmation as it waits", async () => {
    const world = await setup();
    const deleted = world.world.put(file("deleted.txt"));
    world.world.put(file("kept.txt"));
    await imported(world, "2025-01-06T08:00:00Z");
    world.world.remove(deleted);
    await tick(world, "2025-01-07T02:00:00Z");
    const [waiting] = await passes(world, "full");
    expect(waiting?.state).toBe("running");
    const before = await runCount(world);

    await tick(world, "2025-01-07T02:15:00Z");
    await tick(world, "2025-01-08T02:00:00Z");
    expect(await runCount(world)).toBe(before);
    const inbox = await world.instance.api.call("approval_requests.list", {
      query: { status: "pending" }
    });
    expect(inbox.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await passes(world, "full"))[0]?.state).toBe("running");
  });

  it("does not push a first import that failed past its stop with a full pass", async () => {
    const world = await setup();
    world.world.put(file("one.txt"));
    const run = await world.sync();
    await world.worker.runDue();
    await world.sql`update catalyst_kb.sync_runs set state='failed',failure_code='knowledge_source_refused',ended_at=now() where id=${run}`;
    clock = new Date("2025-01-06T08:00:00Z");
    await stamp(world);
    await tick(world, "2025-01-07T02:00:00Z");
    await tick(world, "2025-01-08T02:00:00Z");
    expect(await runCount(world)).toBe(1);
  });

  it("does not leave a poll waiting for what a failed pass left: the next full pass takes it", async () => {
    const world = await setup();
    const left = world.world.put(file("left.txt"));
    await imported(world, "2025-01-06T08:00:00Z");
    await world.sql`update catalyst_kb.source_items set state='discovered',fetch_job_id=null,enqueued_run_id=null where item_id=${left}`;
    await tick(world, "2025-01-06T09:00:00Z");
    expect(await passes(world, "changes")).toEqual([]);
    await tick(world, "2025-01-07T02:00:00Z");
    expect((await passes(world, "full"))[0]?.state).toBe("done");
    expect(await world.sql`select state from catalyst_kb.source_items`).toEqual([
      { state: "fetched" }
    ]);
    await tick(world, "2025-01-07T03:00:00Z");
    expect((await passes(world, "changes")).length).toBe(1);
  });

  it("goes on to the other sources when one of them fails", async () => {
    const world = await setup();
    await world.publishSources([
      { id: "first", connection: "fixture", folders: ["folder"] },
      { id: "second", connection: "fixture", folders: ["other"] }
    ]);
    clock = new Date("2025-01-07T09:00:00Z");
    await runJobs(world);
    const now = new Date("2025-01-07T10:00:00Z");
    // Its id is taken, so the start of the first source's poll fails on the store.
    const taken = scheduledPass(
      world.record.id,
      "first",
      "changes",
      changesDueAt(world.record.id, "first", 15, now)
    ).payload.syncRunId;
    await world.sql`insert into catalyst_kb.sync_runs (id,source_id,mode,operation_run_id,state,started_at,ended_at) values (${taken},'first','changes','other','done',${clock},${clock})`;
    await tick(world, now);
    expect(JSON.stringify(world.logs)).toContain("The source tick could not look at a source");
    expect((await passes(world, "changes", "second")).length).toBe(1);
  });
});

describe("the source's cron and the poll setting (SRC-3)", () => {
  const { setup } = useKnowledgeSync({
    sourceTick: { now: () => clock, sourcePollMinutes: { fixture: 720 } }
  });

  it("runs a custom full pass at its due time only, and polls by the connector type's setting", async () => {
    const world = await setup();
    await world.publishSources([
      {
        id: SOURCE,
        connection: "fixture",
        folders: ["folder", "other"],
        schedule: { full: "0 3 * * 1" }
      }
    ]);
    world.world.put(file("one.txt"));
    // A Monday, after its 03:00: the import stands for that pass.
    await imported(world, "2025-01-06T08:00:00Z");
    const start = new Date("2025-01-06T09:00:00Z");
    // Every three hours for eight days, which holds each Monday's 03:00.
    for (let hours = 0; hours < 8 * 24; hours += 3)
      await tick(world, addMinutes(start, hours * 60));
    const full = await passes(world, "full");
    expect(full.map((run) => run.id)).toEqual([
      scheduledPass(world.record.id, SOURCE, "full", new Date("2025-01-13T03:00:00Z")).payload
        .syncRunId
    ]);
    expect(full[0]?.started_at).toEqual(new Date("2025-01-13T03:00:00Z"));
    // Twice a day for eight days, with one due time the full pass stood for.
    const polls = (await passes(world, "changes")).length;
    expect(polls).toBeGreaterThanOrEqual(15);
    expect(polls).toBeLessThanOrEqual(16);
  }, 120_000);
});

describe("a first import that waits for its confirmation (SRC-3, KB-ISO-1b)", () => {
  const { setup } = useKnowledgeSync({ sourceTick: { now: () => clock }, firstPassStop: 1 });

  it("is not pushed past its stop", async () => {
    const calls = noCalls();
    const world = await setup(counting(calls));
    world.world.put(file("one.txt"));
    world.world.put(file("two.txt"));
    world.world.put(file("three.txt"));
    const run = await world.sync();
    clock = new Date("2025-01-06T08:00:00Z");
    await runJobs(world);
    const stopped = async () =>
      world.sql<{ state: string; cursor_after: string }[]>`
        select state,cursor_after from catalyst_kb.sync_runs where id=${run}`;
    const [before] = await stopped();
    expect(before?.state).toBe("running");
    expect(JSON.parse(required(before).cursor_after).stop.confirmed).toBeUndefined();
    Object.assign(calls, noCalls());

    await tick(world, "2025-01-06T08:15:00Z");
    await tick(world, "2025-01-07T02:00:00Z");
    expect(await runCount(world)).toBe(1);
    expect(calls).toEqual(noCalls());
    expect(await stopped()).toEqual([before]);
  });
});
