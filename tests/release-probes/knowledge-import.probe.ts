import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { waitUntil } from "../support/assertions";
import { fileTestDatabaseUrl } from "../support/test-database";
import { useKnowledgeSync } from "../support/knowledge-sync";

// The release probe `knowledge-import` (SRC-PERF, Data Stores And Knowledge Bases check 103).
// It publishes a source of fixture items and takes them to `indexed` with the knowledge worker
// as a process of its own (tests/support/knowledge-import-worker.mjs: the built packages, the
// production pool of six connections, a stub embedding provider, nothing real). It is not part
// of any check; run it with `pnpm probe:knowledge-import` after `pnpm build`, with
// POSTGRES_STORE_TEST_DATABASE_URL naming a disposable Postgres.
//
// Measured: the seconds from the publish to the last item `indexed`, the machine's CPU count,
// what each stage held the worker for (the profile per stage), the rows the import left, and
// whether a worker killed in the middle and started again left a duplicate row.
//
// KNOWLEDGE_PROBE_ITEMS       items of the timed run; 10,000 by default, the floor of the spec.
// KNOWLEDGE_PROBE_FLAT_ITEMS  also runs this many (100,000 in the spec) and holds the rate per
//                             item to at most 25 percent below the run of KNOWLEDGE_PROBE_ITEMS.
// KNOWLEDGE_PROBE_KILL        0 skips the run with the killed worker.
// KNOWLEDGE_PROBE_DATABASE    a note on the database server (a durable disk, memory) for the record.
// KNOWLEDGE_PROBE_NODE_ARGS   arguments of Node for the worker, such as --cpu-prof.
// KNOWLEDGE_PROBE_STATEMENTS  1 also records the statements that held the database longest;
//                             the server needs shared_preload_libraries=pg_stat_statements.

const ITEMS = Number(process.env.KNOWLEDGE_PROBE_ITEMS ?? 10_000);
const FLAT_ITEMS = Number(process.env.KNOWLEDGE_PROBE_FLAT_ITEMS ?? 0);
const KILL = process.env.KNOWLEDGE_PROBE_KILL !== "0";
const STATEMENTS = process.env.KNOWLEDGE_PROBE_STATEMENTS === "1";
const NODE_ARGS = (process.env.KNOWLEDGE_PROBE_NODE_ARGS ?? "").split(" ").filter(Boolean);
const DIMENSIONS = 1536;
/** The floor of the spec: 10,000 items from publish to `indexed`. */
const FLOOR_ITEMS = 10_000;
const FLOOR_MS = 120_000;
/** At the flat run each item may take 25 percent longer than at the timed run, not more. */
const FLAT_TOLERANCE = 1.25;
const MINUTE_MS = 60_000;
/** How long after `indexed` the import may take to release its originals before it is cut short. */
const SETTLE_MS = 10 * MINUTE_MS;
const SOURCE = "probe";

const stageSchema = z.record(
  z.string(),
  z.object({
    count: z.number(),
    totalMs: z.number(),
    meanMs: z.number(),
    maxMs: z.number(),
    wallMs: z.number()
  })
);
const messageSchema = z.object({
  type: z.string(),
  stages: stageSchema.optional(),
  embedded: z.number().optional(),
  memory: z.object({ rss: z.number() }).passthrough().optional()
});
const count = z.array(z.object({ n: z.coerce.number() }));

interface Measured {
  items: number;
  wallMs: number;
  msPerItem: number;
}
const measured: Measured[] = [];

async function record(name: string, body: unknown) {
  const directory =
    process.env.KNOWLEDGE_PROBE_RECORDS ?? join(tmpdir(), "catalyst-knowledge-probes");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `knowledge-${name}-probe.json`);
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  console.info(`knowledge-import probe: ${path}\n${JSON.stringify(body)}`);
}

describe("knowledge-import probe", () => {
  const { setup } = useKnowledgeSync();
  let child: ChildProcess | undefined;
  afterAll(async () => {
    await stopWorker();
  });

  async function stopWorker() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    child = undefined;
  }

  /** The knowledge worker as a process of its own, ready when it holds the fixture's items. */
  async function startWorker(world: Awaited<ReturnType<typeof setup>>, items: number) {
    const messages: z.infer<typeof messageSchema>[] = [];
    let errors = "";
    const worker = spawn(
      process.execPath,
      [
        "--experimental-import-meta-resolve",
        ...NODE_ARGS,
        new URL("../support/knowledge-import-worker.mjs", import.meta.url).pathname
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          PROBE_DATABASE_URL: await fileTestDatabaseUrl(),
          PROBE_FILES_ROOT: world.instance.filesRoot,
          PROBE_ITEMS: String(items),
          PROBE_DIMENSIONS: String(DIMENSIONS)
        }
      }
    );
    child = worker;
    worker.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    worker.on("message", (message) => messages.push(messageSchema.parse(message)));
    await waitUntil(
      () => {
        if (worker.exitCode !== null)
          throw new Error(`The knowledge worker exited: ${errors || "no output"}`);
        return messages.some((message) => message.type === "ready");
      },
      "the knowledge worker holds its items",
      5 * MINUTE_MS
    );
    return {
      process: worker,
      errors: () => errors,
      async profile() {
        const before = messages.length;
        worker.send("profile");
        await waitUntil(
          () => messages.length > before && messages.at(-1)?.type === "profile",
          "the worker reports its profile",
          30_000
        );
        return messages.at(-1);
      },
      async stop() {
        const exited = once(worker, "exit");
        worker.send("stop");
        await exited;
        child = undefined;
      }
    };
  }

  /** Items that have left the source's listing and the index: the import is over. */
  async function importState(world: Awaited<ReturnType<typeof setup>>, items: number) {
    const [discovered, pending, indexed, runs, releasing] = await Promise.all([
      world.sql`select count(*)::int as n from catalyst_kb.source_items where state = 'discovered'`,
      world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'pending'`,
      world.sql`select count(*)::int as n from catalyst_kb.contents where state = 'extracted'`,
      world.sql`select count(*)::int as n from catalyst_kb.sync_runs where state = 'done' and source_id = ${SOURCE}`,
      world.platform`select count(*)::int as n from platform_jobs where kind in ('knowledge_base.delete_originals','knowledge_base.release_originals') and status in ('queued','running')`
    ]);
    const [d, p, i, r, l] = [discovered, pending, indexed, runs, releasing].map(
      (rows) => count.parse(rows)[0]?.n ?? 0
    );
    const indexedAll = d === 0 && p === 0 && i === items && r === 1;
    return { indexed: i ?? 0, indexedAll, settled: indexedAll && l === 0 };
  }

  async function machine(world: Awaited<ReturnType<typeof setup>>) {
    const [settings] = await world.platform`
      select version() as version, current_setting('fsync') as fsync,
        current_setting('synchronous_commit') as synchronous_commit,
        current_setting('shared_buffers') as shared_buffers,
        current_setting('max_connections') as max_connections`;
    return {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      os: `${platform()} ${release()}`,
      node: process.version,
      postgres: settings,
      databaseNote: process.env.KNOWLEDGE_PROBE_DATABASE ?? "not stated",
      // The connections the worker holds: `database.poolSize` and a store's `poolMaxConnections`.
      pools: {
        platform: Number(process.env.PROBE_POOL_SIZE ?? 10),
        store: Number(process.env.PROBE_STORE_POOL ?? 10)
      }
    };
  }

  /** What the import left behind, to prove nothing was written twice. */
  async function rows(world: Awaited<ReturnType<typeof setup>>) {
    const one = async (statement: ReturnType<typeof world.sql>) =>
      count.parse(await statement)[0]?.n ?? 0;
    const sql = world.sql;
    return {
      sourceItems: await one(sql`select count(*)::int as n from catalyst_kb.source_items`),
      distinctSourceItems: await one(
        sql`select count(distinct item_id)::int as n from catalyst_kb.source_items`
      ),
      documents: await one(sql`select count(*)::int as n from catalyst_kb.documents`),
      distinctDocuments: await one(
        sql`select count(distinct source_item_id)::int as n from catalyst_kb.documents`
      ),
      contents: await one(sql`select count(*)::int as n from catalyst_kb.contents`),
      chunks: await one(sql`select count(*)::int as n from catalyst_kb.chunks`),
      distinctChunks: await one(
        sql`select count(distinct (content_sha256, position))::int as n from catalyst_kb.chunks`
      ),
      embeddings: await one(sql`select count(*)::int as n from catalyst_kb.embeddings_1`),
      distinctEmbeddings: await one(
        sql`select count(distinct chunk_id)::int as n from catalyst_kb.embeddings_1`
      ),
      managedFiles: await one(
        world.platform`select count(*)::int as n from managed_files where owner_id = ${world.record.id} and status <> 'deleted'`
      )
    };
  }

  async function importItems(items: number, kill?: { atIndexed: number }) {
    const world = await setup();
    let worker = await startWorker(world, items);
    try {
      const machineRecord = await machine(world);
      if (STATEMENTS) {
        await world.platform`create extension if not exists pg_stat_statements`;
        await world.platform`select pg_stat_statements_reset()`;
      }
      const startedAt = performance.now();
      // The publish queues the source's first sync in its own transaction (KB-ISO-1b).
      await world.publishSources([{ id: SOURCE, connection: "fixture", folders: ["folder"] }]);
      const timeline: { seconds: number; indexed: number }[] = [];
      let killedAt: { seconds: number; indexed: number } | undefined;
      let lastSample = 0;
      let indexedAtMs: number | undefined;
      let indexedNow = 0;
      await waitUntil(
        async () => {
          // Counting is the probe's own cost: a second apart keeps it out of the measure.
          await new Promise<void>((resolve) => setTimeout(resolve, 1000));
          if (worker.process.exitCode !== null)
            throw new Error(`The knowledge worker exited: ${worker.errors()}`);
          const state = await importState(world, items);
          indexedNow = state.indexed;
          const seconds = Math.round((performance.now() - startedAt) / 100) / 10;
          if (seconds - lastSample >= 5) {
            timeline.push({ seconds, indexed: indexedNow });
            lastSample = seconds;
          }
          if (kill && !killedAt && indexedNow >= kill.atIndexed) {
            // A worker killed outright: its leases are all it leaves of the jobs it held.
            killedAt = { seconds, indexed: indexedNow };
            const exited = once(worker.process, "exit");
            worker.process.kill("SIGKILL");
            await exited;
            child = undefined;
            await world.platform`update platform_jobs set lease_expires_at = now() - interval '1 second' where status = 'running'`;
            worker = await startWorker(world, items);
            return false;
          }
          // `indexed` is every content extracted and the sync run done. The originals the
          // import no longer needs are released after that, and the import settles with them.
          if (state.indexedAll) indexedAtMs ??= performance.now() - startedAt;
          return (
            state.settled ||
            (indexedAtMs !== undefined && performance.now() - startedAt - indexedAtMs > SETTLE_MS)
          );
        },
        `${items} items are indexed`,
        Math.max(30 * MINUTE_MS, items * 200)
      );
      const settledMs = performance.now() - startedAt;
      const settled = (await importState(world, items)).settled;
      const wallMs = indexedAtMs ?? settledMs;
      const profile = await worker.profile();
      await worker.stop();
      const statements = STATEMENTS
        ? await world.platform`
            select calls::int as calls, round(total_exec_time)::int as "totalMs",
              round(mean_exec_time::numeric, 2)::float as "meanMs", rows::int as rows,
              left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 160) as query
            from pg_stat_statements order by total_exec_time desc limit 14`
        : undefined;
      return {
        world,
        wallMs,
        settledMs,
        settled,
        profile,
        timeline,
        killedAt,
        machineRecord,
        statements
      };
    } finally {
      await stopWorker();
    }
  }

  it(
    `takes ${ITEMS} fixture items from publish to indexed`,
    async () => {
      const { world, wallMs, settledMs, settled, profile, timeline, machineRecord, statements } =
        await importItems(ITEMS);
      const left = await rows(world);
      measured.push({ items: ITEMS, wallMs, msPerItem: wallMs / ITEMS });
      await record(`import-${ITEMS}`, {
        probe: "knowledge-import",
        items: ITEMS,
        secondsToIndexed: Math.round(wallMs / 100) / 10,
        secondsToSettled: Math.round(settledMs / 100) / 10,
        originalsReleased: settled,
        itemsPerSecond: Math.round((ITEMS / wallMs) * 10_000) / 10,
        floor: ITEMS === FLOOR_ITEMS ? { seconds: FLOOR_MS / 1000, met: wallMs <= FLOOR_MS } : null,
        machine: machineRecord,
        embeddingsStubbed: { dimensions: DIMENSIONS, embedded: profile?.embedded },
        workerMemoryMb: Math.round((profile?.memory?.rss ?? 0) / 1024 ** 2),
        stages: profile?.stages,
        statements,
        timeline,
        rows: left
      });
      expect(left.sourceItems).toBe(ITEMS);
      expect(left.documents).toBe(ITEMS);
      expect(left.contents).toBe(ITEMS);
      expect(left.distinctChunks).toBe(left.chunks);
      expect(left.embeddings).toBe(left.chunks);
      if (ITEMS === FLOOR_ITEMS) expect(wallMs).toBeLessThanOrEqual(FLOOR_MS);
    },
    Math.max(40 * MINUTE_MS, ITEMS * 300)
  );

  if (KILL)
    it(
      `leaves no duplicate row when the worker is killed after a third of ${ITEMS} items and started again`,
      async () => {
        const { world, wallMs, settledMs, settled, killedAt, profile } = await importItems(ITEMS, {
          atIndexed: Math.floor(ITEMS / 3)
        });
        const left = await rows(world);
        await record(`kill-${ITEMS}`, {
          probe: "knowledge-import-kill",
          items: ITEMS,
          secondsToIndexed: Math.round(wallMs / 100) / 10,
          secondsToSettled: Math.round(settledMs / 100) / 10,
          originalsReleased: settled,
          killedAt,
          stages: profile?.stages,
          rows: left
        });
        expect(killedAt).toBeDefined();
        expect(left.sourceItems).toBe(ITEMS);
        expect(left.distinctSourceItems).toBe(ITEMS);
        expect(left.documents).toBe(ITEMS);
        expect(left.distinctDocuments).toBe(ITEMS);
        expect(left.contents).toBe(ITEMS);
        expect(left.distinctChunks).toBe(left.chunks);
        expect(left.embeddings).toBe(left.chunks);
        expect(left.distinctEmbeddings).toBe(left.embeddings);
        expect(left.managedFiles).toBeGreaterThanOrEqual(ITEMS);
      },
      Math.max(60 * MINUTE_MS, ITEMS * 500)
    );

  if (FLAT_ITEMS > 0)
    it(
      `holds the rate per item at ${FLAT_ITEMS} items within 25 percent of ${ITEMS}`,
      async () => {
        const { world, wallMs, settledMs, settled, profile, timeline, machineRecord } =
          await importItems(FLAT_ITEMS);
        const left = await rows(world);
        const base = measured.find((run) => run.items === ITEMS);
        const msPerItem = wallMs / FLAT_ITEMS;
        measured.push({ items: FLAT_ITEMS, wallMs, msPerItem });
        await record(`import-${FLAT_ITEMS}`, {
          probe: "knowledge-import",
          items: FLAT_ITEMS,
          secondsToIndexed: Math.round(wallMs / 100) / 10,
          secondsToSettled: Math.round(settledMs / 100) / 10,
          originalsReleased: settled,
          itemsPerSecond: Math.round((FLAT_ITEMS / wallMs) * 10_000) / 10,
          msPerItem: Math.round(msPerItem * 100) / 100,
          baseMsPerItem: base ? Math.round(base.msPerItem * 100) / 100 : null,
          slowerThanBase: base ? Math.round((msPerItem / base.msPerItem - 1) * 1000) / 10 : null,
          machine: machineRecord,
          workerMemoryMb: Math.round((profile?.memory?.rss ?? 0) / 1024 ** 2),
          stages: profile?.stages,
          timeline,
          rows: left
        });
        expect(base, "the run of the base size comes first").toBeDefined();
        expect(left.documents).toBe(FLAT_ITEMS);
        expect(left.embeddings).toBe(left.chunks);
        expect(msPerItem).toBeLessThanOrEqual((base?.msPerItem ?? 0) * FLAT_TOLERANCE);
      },
      Math.max(8 * 60 * MINUTE_MS, FLAT_ITEMS * 400)
    );
});
