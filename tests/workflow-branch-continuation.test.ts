import { deferred, eventually, jsonObject, required } from "./support/assertions";
import { afterEach, expect, it } from "vitest";
import type { JsonValue, WorkflowStep } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import type { WorkflowFixture } from "./support/workflow-instance";
import { definition, finishChain, readyPublished } from "./support/workflow-continue-as-new";
import { start, stepRunsOf, writesOf } from "./support/workflow-runs";

// Like the existing continuation-chain suite: these exercise multiple persisted histories.
const chainRun = { timeout: 120_000 };
let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const ref = (step: string, path = "") => ({ ref: { step, path } });
const write = (id: string): WorkflowStep => ({
  id,
  name: id,
  type: "operation",
  operation: "connection.crm.write",
  input: { phase: { value: id } }
});
const each = (id: string, continues = false): WorkflowStep => ({
  id,
  name: id,
  type: "loop",
  items: { step: "clients", path: "clients" },
  ...(continues ? { continueAsNew: { position: "offset", after: 1 } } : {}),
  steps: [write(`${id}_write`)]
});
function manifest(block: WorkflowStep) {
  const base = definition();
  return {
    ...base,
    steps: [
      required(base.steps[0]),
      required(base.steps[1]),
      block,
      { id: "result", name: "Result", type: "output", input: { block: ref(block.id) } }
    ]
  };
}
async function ready(block: WorkflowStep) {
  return readyPublished((t) => {
    open = t;
  }, manifest(block));
}
function parallel(concurrency?: number): WorkflowStep {
  return {
    id: "fork",
    name: "Fork",
    type: "parallel",
    ...(concurrency ? { concurrency } : {}),
    branches: [
      { id: "a", name: "A", steps: [write("already_done")] },
      {
        id: "b",
        name: "B",
        steps: [write("before_loop"), each("items", true), write("after_loop")]
      },
      { id: "c", name: "C", steps: [each("other_items"), write("other_tail")] }
    ]
  };
}

it.each([undefined, 1])(
  "resumes all three branches and joins once (concurrency %s)",
  chainRun,
  async (concurrency) => {
    const t = await ready(parallel(concurrency));
    await start(t);
    const chain = await finishChain(t);
    expect(chain.filter((run) => run.status === "continued")).toHaveLength(2);
    const last = chain.find((run) => run.status !== "continued");
    expect(last, JSON.stringify(chain)).toMatchObject({ status: "done" });
    expect(
      writesOf(t)
        .map((input) => jsonObject(input).phase)
        .sort()
    ).toEqual(
      [
        "already_done",
        "before_loop",
        "after_loop",
        "other_tail",
        ...Array.from({ length: 3 }, () => "items_write"),
        ...Array.from({ length: 3 }, () => "other_items_write")
      ].sort()
    );
    for (const run of chain) {
      const steps = await stepRunsOf(t, run.id);
      const blocks = steps.filter((step) => step.stepId === "fork");
      expect(blocks).toHaveLength(1);
      expect(
        steps
          .filter((step) => step.branch)
          .every((step) => step.containerStepRunId === blocks[0]?.id)
      ).toBe(true);
    }
    if (!last) throw new Error("Missing last history");
    const steps = await stepRunsOf(t, last.id);
    expect(steps.find((step) => step.stepId === "fork")).toMatchObject({
      status: "done",
      bodyCounts: { already_done: { total: 1, done: 1, failed: 0, running: 0 } }
    });
    expect(steps.filter((step) => step.stepId === "result")).toHaveLength(1);
    const output = await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: last.id });
    expect(output).toMatchObject({
      value: {
        block: {
          a: { received: { phase: "already_done" } },
          b: { received: { phase: "after_loop" } },
          c: { received: { phase: "other_tail" } }
        }
      }
    });
  }
);

it(
  "keeps the taken condition branch even when continuation changes the input it tested",
  chainRun,
  async () => {
    const t = await ready({
      id: "choice",
      name: "Choice",
      type: "condition",
      when: { ref: { step: "start", path: "input.offset" }, op: "equals", value: 0 },
      then: [write("before_choice_loop"), each("items", true), write("taken_tail")],
      else: [write("wrong_branch")]
    });
    await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: "Condition", offset: 0 } }
    });
    const chain = await finishChain(t);
    expect(chain.filter((run) => run.status === "continued")).toHaveLength(2);
    expect(chain.find((run) => run.status === "done")).toBeDefined();
    expect(
      writesOf(t)
        .map((input) => jsonObject(input).phase)
        .sort()
    ).toEqual(
      ["before_choice_loop", "taken_tail", "items_write", "items_write", "items_write"].sort()
    );
    for (const run of chain) {
      const steps = await stepRunsOf(t, run.id);
      expect(steps.filter((step) => step.stepId === "choice")).toHaveLength(1);
      expect(steps.filter((step) => step.branch).every((step) => step.branch === "then")).toBe(
        true
      );
    }
  }
);

it(
  "commits a handoff only after an in-flight sibling settles, then a fresh worker resumes it",
  chainRun,
  async () => {
    const t = await ready({
      id: "fork",
      name: "Fork",
      type: "parallel",
      branches: [
        { id: "continuing", name: "Continuing", steps: [each("items", true)] },
        { id: "held", name: "Held", steps: [write("held_call"), write("held_tail")] },
        { id: "done", name: "Done", steps: [write("finished_sibling")] }
      ]
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    t.setBehaviour(async (operation, input): Promise<JsonValue> => {
      if (operation === "echo") return { clients: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      if (jsonObject(input).phase === "held_call") {
        entered.resolve();
        await release.promise;
      }
      return { received: input };
    });
    const run = required(
      await t.stores.workflowRuns.readRun({ clientInstanceId, id: (await start(t)).id })
    );
    const worker = t.worker();
    // Open the fork and the continuing loop, but keep a call of its sibling in flight.
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    const running = worker.runDue();
    try {
      await entered.promise;
      // A second worker can finish the continuing branch's admitted item.
      await t.worker().runDue();
      await eventually(async () => {
        const checkpoint = await t.stores.workflowRuns.readCheckpoint({
          clientInstanceId,
          id: run.id
        });
        return checkpoint?.pending !== undefined;
      });
      expect((await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id }))?.status).toBe(
        "running"
      );
      expect(writesOf(t).some((input) => jsonObject(input).phase === "held_tail")).toBe(false);
    } finally {
      release.resolve();
      await running;
    }
    const chain = await finishChain(t);
    expect(chain.find((run) => run.status === "done")).toBeDefined();
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "held_call")).toHaveLength(1);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "held_tail")).toHaveLength(1);
    expect(
      writesOf(t).filter((input) => jsonObject(input).phase === "finished_sibling")
    ).toHaveLength(1);
  }
);

it("checkpoints a parallel inside an oversized continuing loop item", chainRun, async () => {
  const block: WorkflowStep = {
    id: "outer",
    name: "Outer",
    type: "loop",
    items: { step: "clients", path: "clients" },
    continueAsNew: { position: "offset" },
    steps: [
      {
        id: "fork",
        name: "Fork",
        type: "parallel",
        branches: ["a", "b", "c"].map((id) => ({
          id,
          name: id,
          steps: [write(`${id}_prefix`), each(`${id}_items`), write(`${id}_tail`)]
        }))
      }
    ]
  };
  const value = { ...manifest(block), limits: { stepRuns: 20 } };
  const t = await readyPublished((t) => {
    open = t;
  }, value);
  await start(t);
  const chain = await finishChain(t);
  const last = chain.find((run) => run.status !== "continued");
  expect(last, JSON.stringify(chain)).toMatchObject({ status: "done" });
  expect(chain.some((run) => run.status === "continued")).toBe(true);
  for (const id of ["a", "b", "c"]) {
    expect(writesOf(t).filter((input) => jsonObject(input).phase === `${id}_prefix`)).toHaveLength(
      3
    );
    expect(
      writesOf(t).filter((input) => jsonObject(input).phase === `${id}_items_write`)
    ).toHaveLength(9);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === `${id}_tail`)).toHaveLength(3);
  }
});

it(
  "drains concurrent sibling loop items through nested joins before saving their frontier",
  chainRun,
  async () => {
    const t = await ready({
      id: "fork",
      name: "Fork",
      type: "parallel",
      branches: [
        { id: "continuing", name: "Continuing", steps: [each("items", true)] },
        {
          id: "concurrent",
          name: "Concurrent",
          steps: [
            {
              id: "siblings",
              name: "Siblings",
              type: "loop",
              items: { step: "clients", path: "clients" },
              concurrency: 3,
              steps: [
                {
                  id: "nested",
                  name: "Nested",
                  type: "parallel",
                  branches: [
                    { id: "left", name: "Left", steps: [write("left_first"), write("left_last")] },
                    {
                      id: "right",
                      name: "Right",
                      steps: [write("right_first"), write("right_last")]
                    }
                  ]
                }
              ]
            },
            write("sibling_tail")
          ]
        }
      ]
    });
    await start(t);
    const chain = await finishChain(t);
    expect(
      chain.find((run) => run.status !== "continued"),
      JSON.stringify(chain)
    ).toMatchObject({ status: "done" });
    for (const phase of ["left_first", "left_last", "right_first", "right_last"])
      expect(writesOf(t).filter((input) => jsonObject(input).phase === phase)).toHaveLength(3);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "sibling_tail")).toHaveLength(
      1
    );
  }
);

it(
  "retains a failed sibling without retrying it and fails only after the other branches finish",
  chainRun,
  async () => {
    const t = await ready({
      id: "fork",
      name: "Fork",
      type: "parallel",
      concurrency: 1,
      branches: [
        { id: "failed", name: "Failed", steps: [write("fails_once")] },
        { id: "continues", name: "Continues", steps: [each("items", true), write("good_tail")] }
      ]
    });
    t.setBehaviour(async (operation, input): Promise<JsonValue> => {
      if (operation === "echo") return { clients: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      if (jsonObject(input).phase === "fails_once") throw new Error("Unavailable");
      return { received: input };
    });
    await start(t);
    const chain = await finishChain(t);
    expect(
      chain.find((run) => run.status !== "continued"),
      JSON.stringify(chain)
    ).toMatchObject({ status: "failed" });
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "fails_once")).toHaveLength(1);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "items_write")).toHaveLength(
      3
    );
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "good_tail")).toHaveLength(1);
  }
);

it(
  "reads the next cursor page without reopening completed sibling branches",
  chainRun,
  async () => {
    const block: WorkflowStep = {
      id: "fork",
      name: "Fork",
      type: "parallel",
      branches: [
        {
          id: "pages",
          name: "Pages",
          steps: [
            {
              id: "items",
              name: "Items",
              type: "loop",
              items: { step: "clients", path: "clients" },
              continueAsNew: { position: "offset", cursor: "id" },
              steps: [write("page_write")]
            }
          ]
        },
        { id: "once", name: "Once", steps: [write("sibling_once")] }
      ]
    };
    const base = manifest(block);
    const value = {
      ...base,
      inputs: {
        ...base.inputs,
        properties: { ...base.inputs.properties, offset: { type: "string" } }
      },
      steps: base.steps.map((step) =>
        step.id === "clients" ? { ...step, input: { text: ref("start", "input.offset") } } : step
      )
    };
    const t = await readyPublished((t) => {
      open = t;
    }, value);
    t.setBehaviour(async (operation, input): Promise<JsonValue> =>
      operation === "echo"
        ? {
            clients:
              jsonObject(input).text === "three"
                ? []
                : [{ id: "one" }, { id: "two" }, { id: "three" }]
          }
        : { received: input }
    );
    await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: "Cursor", offset: "zero" } }
    });
    const chain = await finishChain(t);
    expect(
      chain.find((run) => run.status !== "continued"),
      JSON.stringify(chain)
    ).toMatchObject({ status: "done" });
    expect(chain).toHaveLength(2);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "page_write")).toHaveLength(3);
    expect(writesOf(t).filter((input) => jsonObject(input).phase === "sibling_once")).toHaveLength(
      1
    );
  }
);
