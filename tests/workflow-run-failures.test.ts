import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type JsonValue } from "@work-shape/catalyst-core";
import { ref, child, parent, start, children } from "./support/workflow-children";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { readyChildWorkflows } from "./support/workflow-children-instance";
import { notifyClients } from "./support/workflow-runs";

// Count only statements in a scoped read, excluding concurrent worker activity.
const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});
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
        counted.getStore()?.push(statement);
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
describe("Workflow failure projections", () => {
  it("marks a parent whose done child contains failed operation items and keeps engine reads single-row", async () => {
    const definitions = publishedDefinitions();
    const inner = notifyClients({ onItemFailure: "continue" });
    definitions.publish({
      ...inner,
      inputs: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      steps: [
        { id: "start", name: "Parent", type: "trigger", triggers: [{ kind: "parent" }] },
        {
          id: "clients",
          name: "Clients",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: "items" } }
        },
        {
          id: "each_client",
          name: "Each",
          type: "loop",
          items: { step: "clients", path: "clients" },
          onItemFailure: "continue",
          steps: [
            {
              id: "check",
              name: "Check",
              type: "operation",
              operation: "connection.crm.echo",
              input: { text: ref("each_client", "") }
            }
          ]
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    definitions.publish(parent(inner.id));
    const t = await ready(definitions);
    t.setBehaviour((_operation, input): Promise<JsonValue> => {
      const text = z.object({ text: z.string() }).parse(input).text;
      return Promise.resolve<JsonValue>(
        text === "items" ? { clients: ["ok", 412] } : { value: text }
      );
    });
    const root = await t.finish((await start(t)).id);
    const [childRun] = await children(t, root.id);
    expect(childRun).toMatchObject({
      status: "done",
      failedItemCount: 1,
      failedDescendantCount: 0
    });
    expect(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: root.id } })).json()
    ).toMatchObject({ status: "done", failedItemCount: 0, failedDescendantCount: 1 });
    const statements: string[] = [];
    const engineRead = await counted.run(statements, () =>
      t.stores.workflowRuns.readRun({ clientInstanceId, id: root.id })
    );
    expect(engineRead).toMatchObject({ status: "done", failedItemCount: 0 });
    expect(engineRead?.failedDescendantCount).toBeUndefined();
    expect(
      statements.filter((statement) => !statement.includes("pg_catalog.pg_type"))
    ).toHaveLength(1);
    expect(statements.join(" ")).not.toContain("count(*)");
    expect(
      await t.stores.workflowNotices.failureCount({ clientInstanceId, rootRunId: root.id })
    ).toBe(1);
  });

  it("counts a failed grandchild under a done child on run, list, overview and child reads", async () => {
    const definitions = publishedDefinitions();
    definitions.publish({
      ...child("leaf"),
      outputs: { type: "object", required: ["value"], properties: { value: { type: "string" } } }
    });
    definitions.publish({ ...parent("leaf", 2), id: "middle" });
    definitions.publish(parent("middle"));
    const t = await ready(definitions);
    t.setBehaviour((_operation, input): Promise<JsonValue> => {
      const value = z.object({ text: z.string() }).parse(input).text;
      if (value === "items") return Promise.resolve({ items: ["ok", "412"] });
      // A permanent output failure: aggregation must not depend on a reading call's retry clock.
      return Promise.resolve({ value: value === "412" ? 412 : value });
    });
    const started = await start(t);
    expect((await t.finish(started.id)).status).toBe("done");
    const [middle] = await children(t, started.id);
    expect(middle).toMatchObject({ status: "done", failedDescendantCount: 1 });
    if (!middle) throw new Error("Missing middle run");
    const leaves = await children(t, middle.id);
    expect(leaves).toHaveLength(2);
    expect(leaves.every((run) => run.failedDescendantCount === 0)).toBe(true);
    expect(leaves.filter((run) => run.status === "failed")).toHaveLength(1);
    for (const [workflow, run] of [
      ["parent", started],
      ["middle", middle]
    ] as const) {
      expect(
        (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } })).json()
      ).toMatchObject({ status: "done", failedDescendantCount: workflow === "parent" ? 2 : 1 });
      expect(
        (await t.expectOk(t.root.id, "workflows.list_runs", { params: { workflow } })).json()
      ).toMatchObject({
        items: [
          expect.objectContaining({
            id: run.id,
            failedDescendantCount: workflow === "parent" ? 2 : 1
          })
        ]
      });
    }
    const overview = await t.stores.workflowRuns.listLastRuns({
      clientInstanceId,
      workflows: ["parent", "middle", "leaf"]
    });
    expect(overview.get("parent")).toMatchObject({ failedDescendantCount: 2 });
    expect(overview.get("middle")).toMatchObject({ failedDescendantCount: 1 });
    expect(overview.get("leaf")).toMatchObject({ failedDescendantCount: 0 });
    expect((await t.expectOk(t.root.id, "workflows.list")).json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "parent",
          lastRun: expect.objectContaining({ failedDescendantCount: 2 })
        }),
        expect.objectContaining({
          id: "middle",
          lastRun: expect.objectContaining({ failedDescendantCount: 1 })
        })
      ])
    });
    expect(
      await t.stores.workflowNotices.failureCount({ clientInstanceId, rootRunId: started.id })
    ).toBe(2);
  });

  it("uses the partial tree index on the real projection query across 7300 runs", async () => {
    const t = await ready();
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
    try {
      // 100 roots and 72 children each. Mix status failures and item-only failures.
      await sql.unsafe(`
        insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode, trigger, status, definition, input, principal_id, principal_name, principal_label, started_by, deadline_at, correlation_id, created_at, depth, root_run_id)
        select 'root_' || n, '${clientInstanceId}', 'plan-parent', 'rev', 'live', 'schedule', 'done', '{}', '{}', 'sp', 'sp', 'sp', '{}', now(), 'c', now(), 0, 'root_' || n
        from generate_series(1, 100) n;
        insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode, trigger, status, failed_item_count, definition, input, principal_id, principal_name, principal_label, started_by, deadline_at, correlation_id, created_at, depth, root_run_id, parent_run_id, parent_step_run_id)
        select 'child_' || n || '_' || i, '${clientInstanceId}', 'plan-child', 'rev', 'live', 'parent', case when i = 1 then 'failed' else 'done' end, case when i = 2 then 1 else 0 end, '{}', '{}', 'sp', 'sp', 'sp', '{}', now(), 'c', now(), 1, 'root_' || n, 'root_' || n, 'sr_' || n || '_' || i
        from generate_series(1, 100) n, generate_series(1, 72) i;
        analyze workflow_runs;
        set enable_seqscan = off;
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
});
