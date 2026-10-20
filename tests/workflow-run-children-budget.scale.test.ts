import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@work-shape/catalyst-core";
import { child, parent, start, children } from "./support/workflow-children";
import { readyChildWorkflows } from "./support/workflow-children-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { clientInstanceId } from "./support/access-instance";
import { withTestSql } from "./support/test-sql";

// The scale test of child-run budgets. It runs only with CATALYST_SCALE_TESTS=1 (vitest.config.ts).

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

describe("child-run budgets", () => {
  it("keeps 600 children within their own budgets while their combined history exceeds 20,000 step runs", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent("child", 600));
    const t = await readyChildWorkflows((fixture) => {
      open = fixture;
    }, definitions);
    // The bulk insert of a child's history takes longer than the test Connection's default
    // call timeout on a busy machine, and a timed-out call retries and inserts it twice.
    t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
    await withTestSql(async (sql) => {
      t.setBehaviour(async (_operation, input): Promise<JsonValue> => {
        const text = z.object({ text: z.string() }).parse(input).text;
        if (text === "items") return { items: Array.from({ length: 600 }, (_, i) => String(i)) };
        // Arrange prior completed history in bulk instead of replaying 20,400 no-op jobs.
        // Every child still starts, executes its operation and completes through the engine;
        // the next step must use this child's persisted budget even after the tree exceeds it.
        await sql`
          with history as (
            insert into workflow_step_runs
              (id, client_instance_id, run_id, step_id, step_type, key, status, created_at, finished_at)
            select r.id || '_history_' || n, r.client_instance_id, r.id,
              'history', 'loop', 'history[' || n || ']', 'done', now(), now()
            from workflow_runs r cross join generate_series(1, 34) n
            where r.client_instance_id = ${clientInstanceId} and r.item_index = ${Number(text)}
              and r.parent_run_id is not null
            returning run_id
          )
          update workflow_runs r set step_run_count = r.step_run_count + h.count
          from (select run_id, count(*)::int as count from history group by run_id) h
          where r.id = h.run_id`;
        return { value: text };
      });
      const started = await start(t);
      const worker = t.worker();
      let done: Awaited<ReturnType<typeof t.stores.workflowRuns.readRun>>;
      for (let pass = 0; pass < 7_000; pass++) {
        await worker.runDue();
        done = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
        if (done?.finishedAt) break;
      }
      expect(done?.status).toBe("done");
      const runs = await children(t, started.id);
      expect(runs).toHaveLength(600);
      expect(runs.every((r) => r.status === "done" && r.stepRunCount === 37)).toBe(true);
      expect(
        runs.reduce((sum, r) => sum + r.stepRunCount, done?.stepRunCount ?? 0)
      ).toBeGreaterThan(20_000);
    });
  }, 1_200_000);
});
