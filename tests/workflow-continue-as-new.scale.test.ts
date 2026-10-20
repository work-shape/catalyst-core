import { afterEach, expect, it } from "vitest";
import type { WorkflowStep } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import type { WorkflowFixture } from "./support/workflow-instance";
import { start, stepRunsOf, writesOf } from "./support/workflow-runs";
import {
  definition,
  finishChain,
  readyPublished as readyPublishedWorkflow
} from "./support/workflow-continue-as-new";

// The budget scans of continue-as-new: every budget from a publish floor up, each a chain of
// histories run to its end. tests/workflow-continue-as-new.test.ts holds one budget of each
// shape. They run only with CATALYST_SCALE_TESTS=1 (vitest.config.ts).

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const readyPublished = (manifest: unknown) =>
  readyPublishedWorkflow((fixture) => {
    open = fixture;
  }, manifest);

// A test that runs a chain of histories to its end takes up to 7 s when the file runs alone.
// In the full suite on a loaded machine such tests ran past the default 30 s.
const chainRun = { timeout: 120_000 };

// Scan every budget from each publish floor through floor + 13, including exact fills.
it.each(
  [false, true].flatMap((nested) =>
    [1, 3].flatMap((concurrency) =>
      Array.from({ length: 14 }, (_, offset) => ({
        nested,
        concurrency,
        budget: (nested ? 7 : 5) + offset
      }))
    )
  )
)(
  "reserves the final tail at nested=$nested concurrency=$concurrency budget=$budget",
  chainRun,
  async ({ nested, concurrency, budget }) => {
    const manifest = definition();
    manifest.steps = manifest.steps.map((step) =>
      step.id === "each_client" ? { ...step, concurrency } : step
    );
    if (nested)
      manifest.steps = manifest.steps.map((step) =>
        step.id === "each_client"
          ? {
              ...step,
              concurrency,
              steps: [
                {
                  id: "before",
                  name: "Before",
                  type: "operation",
                  operation: "connection.crm.write",
                  input: {
                    client: { ref: { step: "each_client", path: "id" } },
                    phase: { value: "before" }
                  }
                },
                {
                  id: "inner",
                  name: "Inner",
                  type: "loop",
                  items: { step: "clients", path: "clients" },
                  steps: [
                    {
                      id: "pair",
                      name: "Pair",
                      type: "operation",
                      operation: "connection.crm.write",
                      input: {
                        client: { ref: { step: "each_client", path: "id" } },
                        inner: { ref: { step: "inner", path: "id" } }
                      }
                    }
                  ]
                }
              ]
            }
          : step
      );
    const t = await readyPublished({ ...manifest, limits: { stepRuns: budget } });
    const started = await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: "Tail edge" }, key: "tail-edge" }
    });
    expect(started.statusCode).toBe(200);
    const chain = (await finishChain(t)).sort(
      (a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1)
    );
    expect(chain.at(-1)?.status).toBe("done");
    if (budget >= (nested ? 19 : 7)) expect(chain).toHaveLength(1);
    expect(chain.slice(0, -1).every((run) => run.status === "continued")).toBe(true);
    const tails = (await Promise.all(chain.map((run) => stepRunsOf(t, run.id))))
      .flat()
      .filter((step) => step.stepId === "result");
    expect(tails).toHaveLength(1);
    expect(tails[0]?.status).toBe("done");
    expect(chain.every((run) => run.stepRunCount <= budget)).toBe(true);
    const last = chain.at(-1);
    if (!last) throw new Error("Missing final history");
    expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: last.id })).toEqual({
      value: { sent: 3, failed: 0 }
    });
    expect(writesOf(t)).toHaveLength(nested ? 12 : 3);
    expect(new Set(writesOf(t).map((write) => JSON.stringify(write))).size).toBe(nested ? 12 : 3);
    for (const run of chain)
      expect(
        await t.stores.workflowNotices.failureCount({ clientInstanceId, rootRunId: run.id })
      ).toBe(0);
  }
);

// A serial outer loop may enclose a continuing inner loop. Its three clients each
// produce three pairs and two tail writes; the full history needs 22 slots, floor 8.
it.each(Array.from({ length: 16 }, (_, offset) => 8 + offset))(
  "publishes a serial ancestor and scans its inner continuation at budget %s",
  chainRun,
  async (budget) => {
    const manifest = definition();
    const write = (id: string): WorkflowStep => ({
      id,
      name: id,
      type: "operation",
      operation: "connection.crm.write",
      input: { client: { ref: { step: "each_client", path: "id" } }, phase: { value: id } }
    });
    manifest.steps = manifest.steps.map((step) =>
      step.id === "each_client"
        ? {
            ...step,
            continueAsNew: undefined,
            concurrency: 1,
            steps: [
              {
                id: "inner",
                name: "Inner",
                type: "loop",
                items: { step: "clients", path: "clients" },
                continueAsNew: { position: "offset" },
                steps: [
                  {
                    ...write("pair"),
                    input: {
                      client: { ref: { step: "each_client", path: "id" } },
                      inner: { ref: { step: "inner", path: "id" } }
                    }
                  }
                ]
              },
              write("after_inner"),
              write("outer_tail")
            ]
          }
        : step
    );
    const t = await readyPublished({ ...manifest, limits: { stepRuns: budget } });
    await start(t);
    const chain = (await finishChain(t)).sort(
      (a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1)
    );
    expect(chain.at(-1)?.status).toBe("done");
    expect(chain.slice(0, -1).every((run) => run.status === "continued")).toBe(true);
    expect(chain.every((run) => run.stepRunCount <= budget)).toBe(true);
    if (budget >= 22) expect(chain).toHaveLength(1);
    const writes = writesOf(t);
    expect(writes).toHaveLength(15);
    expect(new Set(writes.map((write) => JSON.stringify(write))).size).toBe(15);
    const steps = (await Promise.all(chain.map((run) => stepRunsOf(t, run.id)))).flat();
    expect(steps.filter((step) => step.stepId === "result")).toEqual([
      expect.objectContaining({ status: "done" })
    ]);
    const last = chain.at(-1);
    if (!last) throw new Error("Missing final history");
    expect(await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: last.id })).toEqual({
      value: { sent: 3, failed: 0 }
    });
  }
);
