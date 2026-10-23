import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { readyChildWorkflows } from "./support/workflow-children-instance";

// Count only statements in a scoped read, excluding concurrent worker activity.
const plans = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<{ text: string; parameters: string[] }[]>();
});
vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement, parameters) => {
        if (statement.includes("count(*)") && statement.includes('"workflow_runs"'))
          plans
            .getStore()
            ?.push({ text: statement, parameters: z.array(z.string()).parse(parameters) });
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const ready = (
  definitions = publishedDefinitions(),
  options: { now?: () => Date; duration?: number } = {}
) =>
  readyChildWorkflows(
    (fixture) => {
      open = fixture;
    },
    definitions,
    options
  );

it("uses the partial tree index on the real projection query across 219365 runs", async () => {
  const t = await ready();
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
  try {
    // One year of nightly 600-child fan-outs. Mix status failures and item-only failures.
    await sql.unsafe(`
        insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode, trigger, status, definition, input, principal_id, principal_name, principal_label, started_by, deadline_at, correlation_id, created_at, depth, root_run_id)
        select 'root_' || n, '${clientInstanceId}', 'plan-parent', 'rev', 'live', 'schedule', 'done', '{}', '{}', 'sp', 'sp', 'sp', '{}', now(), 'c', now(), 0, 'root_' || n
        from generate_series(1, 365) n;
        insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode, trigger, status, failed_item_count, definition, input, principal_id, principal_name, principal_label, started_by, deadline_at, correlation_id, created_at, depth, root_run_id, parent_run_id, parent_step_run_id)
        select 'child_' || n || '_' || i, '${clientInstanceId}', 'plan-child', 'rev', 'live', 'parent', case when i = 1 then 'failed' else 'done' end, case when i = 2 then 1 else 0 end, '{}', '{}', 'sp', 'sp', 'sp', '{}', now(), 'c', now(), 1, 'root_' || n, 'root_' || n, 'sr_' || n || '_' || i
        from generate_series(1, 365) n, generate_series(1, 600) i;
        analyze workflow_runs;
      `);
    for (const [label, workflow, limit] of [
      ["ONE ROOT", "plan-parent", 1],
      ["PAGE OF 50 ROOTS", "plan-parent", 50],
      ["ONE CHILD", "plan-child", 1]
    ] as const) {
      const queries: { text: string; parameters: string[] }[] = [];
      await plans.run(queries, () =>
        t.stores.workflowRuns.listRuns({ clientInstanceId, workflow, page: { limit } })
      );
      expect(queries).toHaveLength(1);
      const query = queries[0];
      if (!query) throw new Error("Missing failure projection query");
      const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(
        `explain (analyze, buffers, costs off) ${query.text}`,
        query.parameters
      );
      const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan, label).toContain("workflow_runs_failures_idx");
      expect(plan).not.toContain("Seq Scan");
    }
  } finally {
    await sql.end();
  }
});
