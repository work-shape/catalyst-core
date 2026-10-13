import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_LOOP_MAX_CONCURRENCY } from "@vivd-catalyst/core";
import {
  WORKFLOW_LOOP_MAX_ITEMS,
  WORKFLOW_STEP_DATA_MAX_BYTES,
  WORKFLOW_STEP_JOB_SLOTS
} from "@vivd-catalyst/workflows";
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
      const { world: t, worker } = await openProbeWorld();
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
      await waitFor(
        async () => {
          const [row] = await t.sql(
            (sql) => sql<{ count: number }[]>`
              select count(*)::int as count from platform_jobs
              where kind like 'workflow%' and status = 'running'`
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

      await writeProbeRecord("volume", {
        items: ITEMS,
        bounds: {
          loopMaxItems: WORKFLOW_LOOP_MAX_ITEMS,
          loopConcurrency: WORKFLOW_LOOP_MAX_CONCURRENCY,
          stepJobSlots: WORKFLOW_STEP_JOB_SLOTS,
          stepDataMaxBytes: WORKFLOW_STEP_DATA_MAX_BYTES,
          readWithinMs: READ_WITHIN_MS
        },
        wallMs,
        itemsPerSecond: Math.round((ITEMS / wallMs) * 1_000),
        idleResidentBytes,
        peakResidentBytes,
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
      expect(after).toMatchObject({ status: "done", stepRunCount: ITEMS + 3 });
      expect(loop?.loop).toMatchObject({ total: ITEMS, done: ITEMS, failed: 0 });
      // Each item was read once.
      expect(t.arrivals("echo")).toBe(ITEMS);
      expect(mostRunningJobs).toBeLessThanOrEqual(WORKFLOW_STEP_JOB_SLOTS);
      for (const [name, read] of Object.entries(reads)) {
        expect(read.medianMs, name).toBeLessThan(READ_WITHIN_MS);
      }
    },
    70 * MINUTE_MS
  );
});
