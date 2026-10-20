import type postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@work-shape/catalyst-core";
import { child, parent, start, children } from "./support/workflow-children";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { readyChildWorkflows } from "./support/workflow-children-instance";

// The scale test of child runs: 600 children of one parent, four at a time. It runs only with
// CATALYST_SCALE_TESTS=1 (vitest.config.ts).

// Count only statements in a scoped read, excluding concurrent worker activity.
const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});
vi.mock("postgres", async (importOriginal) => {
  type Connect = (url: string, options?: postgres.Options<Record<string, never>>) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) =>
    actual.default(url, {
      ...options,
      debug: (_connection, statement) => {
        counted.getStore()?.push(statement);
      }
    });
  return { ...actual, default: Object.assign(connect, actual.default) };
});

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const ready = (definitions = publishedDefinitions()) =>
  readyChildWorkflows((fixture) => {
    open = fixture;
  }, definitions);

describe("Workflow child runs", () => {
  it("runs 600 children with three steps each, concurrency four, and continues past a failed child", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent("child", 600));
    const t = await ready(definitions);
    let openMax = 0;
    t.setBehaviour(async (_operation, input): Promise<JsonValue> => {
      if (z.object({ text: z.string() }).parse(input).text === "items")
        return { items: Array.from({ length: 600 }, (_, i) => String(i)) };
      const value = z.object({ text: z.string() }).parse(input).text;
      if (value === "412") throw new Error("Item failed");
      return { value };
    });
    const started = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 2_000; pass++) {
      await worker.runDue();
      const runs = await children(t, started.id);
      openMax = Math.max(
        openMax,
        runs.filter((r) => ["queued", "running", "waiting"].includes(r.status)).length
      );
      const root = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
      if (root?.finishedAt) break;
    }
    const done = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    );
    expect(done.status).toBe("done");
    expect(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    ).toMatchObject({ failedDescendantCount: 1 });
    expect(
      (
        await t.expectOk(t.root.id, "workflows.list_runs", { params: { workflow: "parent" } })
      ).json()
    ).toMatchObject({
      items: [expect.objectContaining({ id: started.id, failedDescendantCount: 1 })]
    });
    expect(
      (await t.stores.workflowRuns.listLastRuns({ clientInstanceId, workflows: ["parent"] })).get(
        "parent"
      )
    ).toMatchObject({ id: started.id, failedDescendantCount: 1 });
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({
      result: { total: 600, done: 599, failed: 1 }
    });
    expect(openMax).toBe(4);
    const runs = await children(t, started.id);
    expect(runs).toHaveLength(600);
    // A page of 600 runs and one of five each need one list and one grouped count.
    for (const limit of [5, 600]) {
      const statements: string[] = [];
      const page = await counted.run(statements, () =>
        t.stores.workflowRuns.listRuns({
          clientInstanceId,
          workflow: "child",
          page: { limit }
        })
      );
      expect(page).toHaveLength(limit);
      expect(
        statements.filter((statement) => !statement.includes("pg_catalog.pg_type"))
      ).toHaveLength(2);
    }
    expect(runs.every((r) => r.stepRunCount <= 3)).toBe(true);
    expect(runs.find((r) => r.itemIndex === 599)).toBeDefined();
    const failedChild = runs.find((r) => r.status === "failed");
    expect(failedChild).toBeDefined();
    const response = await t.expectOk(t.root.id, "workflows.list_step_runs", {
      params: { runId: started.id },
      query: { status: "failed" }
    });
    const { items: failedSteps } = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            childRunId: z.string().optional(),
            linkedRunId: z.string().optional()
          })
        )
      })
      .parse(response.json());
    expect(failedSteps).toHaveLength(1);
    expect(failedSteps[0]).toMatchObject({
      id: failedChild?.parentStepRunId,
      childRunId: failedChild?.id
    });
    expect(failedSteps[0]?.linkedRunId).toBeUndefined();
    // About 770 worker passes of up to four children, 100 s when it runs alone. In the full
    // suite on a loaded machine they ran past 300 s.
  }, 1_200_000);
});
