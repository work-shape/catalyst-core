import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_LOOP_MAX_CONCURRENCY } from "@work-shape/catalyst-core";
import {
  WORKFLOW_LOOP_MAX_ITEMS,
  WORKFLOW_STEP_DATA_MAX_BYTES
} from "@work-shape/catalyst-workflows";
import { stepRunsSchema } from "../support/workflow-instance";
import {
  ended,
  openProbeWorld,
  waitFor,
  writeProbeRecord,
  type ProbeWorld
} from "../support/workflow-probe-world";

// The volume probe of the Workflow engine: one run with a loop over as many items as a loop
// may hold, at the concurrency a loop may ask for, each item one cheap reading call. The
// server of an assembled instance runs it in a process of its own. Measured: the time the run
// takes, the largest resident set of that process, the rows the run wrote, the size of its
// record, and how long the reads of the run's page take afterwards.

const ITEMS = Number(process.env.WORKFLOW_PROBE_ITEMS ?? WORKFLOW_LOOP_MAX_ITEMS);
/**
 * `WORKFLOW_PROBE_BUILT=1` starts the server from the built packages, with the arguments of
 * Node that `WORKFLOW_PROBE_NODE_ARGS` names, such as `--max-old-space-size=256 --expose-gc`.
 * The server then says what it holds once a second, and the record keeps what it said when the
 * loop had started none, a quarter, half, three quarters and all of its items.
 */
const BUILT = process.env.WORKFLOW_PROBE_BUILT === "1";
const NODE_ARGS = (process.env.WORKFLOW_PROBE_NODE_ARGS ?? "").split(" ").filter(Boolean);
const QUARTERS = [0, 0.25, 0.5, 0.75, 1].map((part) => Math.round(ITEMS * part));
const MINUTE_MS = 60_000;
/** The bound a read of the run list or of the run's page is held to. */
const READ_WITHIN_MS = 200;
const READS = 9;

const WORKFLOW = {
  id: "volume-probe",
  name: "Volume probe",
  runAs: "workflow-runner",
  inputs: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "each",
      name: "For each item",
      type: "loop",
      items: { step: "start", path: "input.items" },
      itemLabel: "id",
      concurrency: WORKFLOW_LOOP_MAX_CONCURRENCY,
      steps: [
        {
          id: "touch",
          name: "Read once",
          type: "operation",
          operation: "connection.outside.echo",
          input: { month: { ref: { step: "each", path: "id" } } }
        }
      ]
    },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: {
        done: { ref: { step: "each", path: "done" } },
        failed: { ref: { step: "each", path: "failed" } }
      }
    }
  ]
};

const median = (values: number[]) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

describe(`a Workflow Run with a loop over ${ITEMS} items`, () => {
  let open: ProbeWorld | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it(
    "ends, and its record is read within the bound",
    async () => {
      const { world: t, worker } = await openProbeWorld(
        BUILT ? { built: { nodeArgs: NODE_ARGS } } : {}
      );
      open = t;
      await t.publish(WORKFLOW);

      const rowCounts = () =>
        t.sql(async (sql) => {
          const tables = await sql<{ name: string }[]>`
            select tablename as name from pg_tables where schemaname = 'public' order by 1`;
          const counts: Record<string, number> = {};
          for (const { name } of tables) {
            const [row] = await sql<{ count: number }[]>`
              select count(*)::int as count from ${sql(name)}`;
            counts[name] = row?.count ?? 0;
          }
          return counts;
        });
      const before = await rowCounts();

      const items = Array.from({ length: ITEMS }, (_, index) => ({
        id: `item-${String(index).padStart(5, "0")}`
      }));
      // The process is started from source by the TypeScript loader, which is most of this.
      const idleResidentBytes = await worker.residentBytes();
      const startedAt = Date.now();
      const run = await t.start(WORKFLOW.id, { items });

      // How many jobs of the run its process holds at once, asked while the run runs.
      let mostRunningJobs = 0;
      /** When the run had created the step runs of so many items, by the clock of this process. */
      const reachedAt = new Map<number, number>([[0, startedAt]]);
      await waitFor(
        async () => {
          const items = (await t.run(run.id)).stepRunCount - 2;
          for (const quarter of QUARTERS) {
            if (items >= quarter && !reachedAt.has(quarter)) reachedAt.set(quarter, Date.now());
          }
          const [row] = await t.sql(
            (sql) => sql<{ count: number }[]>`
              select count(*)::int as count from platform_jobs
              where kind = 'workflow_run.execute_step' and status = 'running'`
          );
          mostRunningJobs = Math.max(mostRunningJobs, row?.count ?? 0);
          return ended(await t.run(run.id));
        },
        "the run ended",
        60 * MINUTE_MS
      );
      const wallMs = Date.now() - startedAt;
      const after = await t.run(run.id);
      const peakResidentBytes = worker.peakResidentBytes();
      const samples = await worker.memorySamples();
      const megabytes = (bytes: number) => Math.round(bytes / (1_024 * 1_024));
      const memory = QUARTERS.map((items) => {
        const at = reachedAt.get(items) ?? Date.now();
        const sample = samples.find((candidate) => candidate.at >= at) ?? samples.at(-1);
        return sample
          ? {
              items,
              rssMb: megabytes(sample.rss),
              heapUsedMb: megabytes(sample.heapUsed),
              heapTotalMb: megabytes(sample.heapTotal),
              externalMb: megabytes(sample.external),
              arrayBuffersMb: megabytes(sample.arrayBuffers)
            }
          : { items };
      });

      const counts = await rowCounts();
      const rowsWritten = Object.fromEntries(
        Object.entries(counts)
          .map(([name, count]) => [name, count - (before[name] ?? 0)] as const)
          .filter(([, written]) => written !== 0)
      );
      const [record] = await t.sql(
        (sql) => sql<
          {
            runRowBytes: number;
            stepRunRowBytes: number;
            largestStepRunRowBytes: number;
            loopInputBytes: number;
            stepRunsRelationBytes: number;
            jobsRelationBytes: number;
            operationRunsRelationBytes: number;
          }[]
        >`
          select
            (select pg_column_size(r.*) from workflow_runs r where r.id = ${run.id})::int
              as "runRowBytes",
            (select sum(pg_column_size(s.*)) from workflow_step_runs s where s.run_id = ${run.id})::int
              as "stepRunRowBytes",
            (select max(pg_column_size(s.*)) from workflow_step_runs s where s.run_id = ${run.id})::int
              as "largestStepRunRowBytes",
            (select max(octet_length(s.input::text)) from workflow_step_runs s
              where s.run_id = ${run.id})::int as "loopInputBytes",
            pg_total_relation_size('workflow_step_runs')::int as "stepRunsRelationBytes",
            pg_total_relation_size('platform_jobs')::int as "jobsRelationBytes",
            pg_total_relation_size('operation_runs')::int as "operationRunsRelationBytes"`
      );

      const topLevel = stepRunsSchema.parse(
        (
          await t.api.call("workflows.list_step_runs", {
            params: { runId: run.id },
            query: { topLevel: "true" }
          })
        ).json()
      ).items;
      const loop = topLevel.find((stepRun) => stepRun.key === "each");

      /** The time of one read through the API of this process, the median and the slowest. */
      const timed = async (read: () => Promise<{ statusCode: number; body: string }>) => {
        const taken: number[] = [];
        for (let index = 0; index < READS; index++) {
          const since = performance.now();
          const response = await read();
          taken.push(performance.now() - since);
          expect(response.statusCode, response.body).toBe(200);
        }
        return { medianMs: Math.round(median(taken)), slowestMs: Math.round(Math.max(...taken)) };
      };
      const reads = {
        runList: await timed(() =>
          t.api.call("workflows.list_runs", { params: { workflow: WORKFLOW.id } })
        ),
        run: await timed(() => t.api.call("workflows.get_run", { params: { runId: run.id } })),
        topLevelStepRuns: await timed(() =>
          t.api.call("workflows.list_step_runs", {
            params: { runId: run.id },
            query: { topLevel: "true" }
          })
        ),
        stepRunsOfTheLoop: await timed(() =>
          t.api.call("workflows.list_step_runs", {
            params: { runId: run.id },
            query: { containerStepRunId: loop?.id ?? "" }
          })
        ),
        failedStepRuns: await timed(() =>
          t.api.call("workflows.list_step_runs", {
            params: { runId: run.id },
            query: { status: "failed" }
          })
        ),
        stepRunsOfTheLastItem: await timed(() =>
          t.api.call("workflows.list_step_runs", {
            params: { runId: run.id },
            query: { containerStepRunId: loop?.id ?? "", iteration: String(ITEMS - 1) }
          })
        )
      };

      // The job that removes the values of old runs, on this run: the run is made 31 days
      // old in the database and the tick that waits for tomorrow is made due now.
      const held = () =>
        t.sql(async (sql) => {
          const [row] = await sql<
            {
              stepRuns: number;
              stepRunsWithValues: number;
              stepRunRowBytes: number;
              runRowBytes: number;
              stepRunsRelationBytes: number;
            }[]
          >`
            select
              (select count(*) from workflow_step_runs s where s.run_id = ${run.id})::int
                as "stepRuns",
              (select count(*) from workflow_step_runs s where s.run_id = ${run.id}
                and (s.output is not null or s.input ? 'items'))::int as "stepRunsWithValues",
              (select sum(pg_column_size(s.*)) from workflow_step_runs s
                where s.run_id = ${run.id})::int as "stepRunRowBytes",
              (select pg_column_size(r.*) from workflow_runs r where r.id = ${run.id})::int
                as "runRowBytes",
              pg_total_relation_size('workflow_step_runs')::int as "stepRunsRelationBytes"`;
          return row;
        });
      const beforePrune = await held();
      await t.sql(async (sql) => {
        await sql`
          update workflow_runs set finished_at = finished_at - interval '31 days'
          where id = ${run.id}`;
        await sql`
          update platform_jobs set run_after = now()
          where kind = 'workflow_run.prune_data' and status = 'queued'`;
      });
      const pruneStartedAt = Date.now();
      await waitFor(
        async () => (await t.run(run.id)).dataPrunedAt !== undefined,
        "the values of the run were removed",
        10 * MINUTE_MS
      );
      const pruneMs = Date.now() - pruneStartedAt;
      const afterPrune = await held();
      const pruned = await t.run(run.id);

      await writeProbeRecord("volume", {
        prune: {
          ms: pruneMs,
          before: beforePrune,
          after: afterPrune,
          run: { status: pruned.status, stepRunCount: pruned.stepRunCount }
        },
        items: ITEMS,
        bounds: {
          loopMaxItems: WORKFLOW_LOOP_MAX_ITEMS,
          loopConcurrency: WORKFLOW_LOOP_MAX_CONCURRENCY,
          stepJobSlots: workflowsConfigSchema.parse({}).stepSlots,
          stepDataMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES,
          readWithinMs: READ_WITHIN_MS
        },
        wallMs,
        itemsPerSecond: Math.round((ITEMS / wallMs) * 1_000),
        built: BUILT,
        nodeArgs: NODE_ARGS,
        idleResidentBytes,
        peakResidentBytes,
        memory,
        mostRunningJobs,
        run: { status: after.status, error: after.error, stepRunCount: after.stepRunCount },
        loop: loop?.loop,
        output: after.outputPreview?.text,
        rowsWritten,
        record,
        reads,
        arrivals: t.arrivals("echo")
      });

      expect(after.error).toBeUndefined();
      // The values are gone and every record is there.
      expect(afterPrune).toMatchObject({ stepRuns: ITEMS + 3, stepRunsWithValues: 0 });
      expect(pruned).toMatchObject({ status: "done", stepRunCount: ITEMS + 3 });
      expect(after).toMatchObject({ status: "done", stepRunCount: ITEMS + 3 });
      expect(loop?.loop).toMatchObject({ total: ITEMS, done: ITEMS, failed: 0 });
      // Each item was read once.
      expect(t.arrivals("echo")).toBe(ITEMS);
      expect(mostRunningJobs).toBeLessThanOrEqual(workflowsConfigSchema.parse({}).stepSlots);
      for (const [name, read] of Object.entries(reads)) {
        expect(read.medianMs, name).toBeLessThan(READ_WITHIN_MS);
      }
    },
    70 * MINUTE_MS
  );
});
