import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue, WorkflowStep } from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, runSchema, type WorkflowFixture } from "./support/workflow-instance";
import {
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const ref = (step: string, path = "") => ({ ref: { step, path } });
const action = (id: string, input = { data: ref("clients", "clients") }): WorkflowStep => ({
  id,
  name: id,
  type: "operation",
  operation: "connection.crm.write",
  input
});
const branches = ["a", "b", "c"].map((id) => ({
  id,
  name: id,
  steps: [
    action(`check_${id}`),
    action(`keep_${id}`, { data: ref(`check_${id}`, "received.data") })
  ]
}));
function definition(
  block: unknown = { id: "analyses", name: "Analyses", type: "parallel", branches }
) {
  const base = notifyClients();
  return {
    ...base,
    steps: [
      base.steps[0],
      base.steps[1],
      block,
      { id: "result", name: "Result", type: "output", input: { analyses: ref("analyses") } }
    ]
  };
}
async function ready(
  value: unknown = definition(),
  options: Parameters<typeof readyWorkflows>[1] = {}
) {
  const definitions = publishedDefinitions();
  definitions.publish(value);
  return readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, ...options }
  );
}
function gate() {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function within(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Branches did not overlap")), 1500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function reachBlock(t: WorkflowFixture) {
  const run = await start(t);
  const worker = t.worker();
  for (let pass = 0; pass < 3; pass++) await worker.runDue();
  return { run, worker };
}

describe("parallel Workflow branches", () => {
  it("loads once, overlaps three analyses, joins once and exposes branch durations and body counts", async () => {
    const t = await ready();
    const data = [{ id: "one" }, { id: "two" }];
    const all = gate(),
      release = gate();
    let entered = 0;
    t.setBehaviour(async (operation, input): Promise<JsonValue> => {
      if (operation === "echo") return { clients: data };
      if (++entered === 3) all.release();
      await release.promise;
      return { received: input };
    });
    const { run, worker } = await reachBlock(t);
    const running = worker.runDue();
    try {
      await within(all.promise);
      const steps = await stepRunsOf(t, run.id);
      const block = steps.find((step) => step.stepId === "analyses");
      expect(block).toMatchObject({
        status: "waiting",
        concurrency: { asked: 3, ranWith: 3 },
        bodyCounts: {
          check_a: { total: 1, done: 0, failed: 0, running: 1 },
          keep_a: { total: 1, done: 0, failed: 0, running: 0 },
          check_b: { total: 1, done: 0, failed: 0, running: 1 },
          keep_b: { total: 1, done: 0, failed: 0, running: 0 },
          check_c: { total: 1, done: 0, failed: 0, running: 1 },
          keep_c: { total: 1, done: 0, failed: 0, running: 0 }
        }
      });
      expect(steps.some((step) => step.stepId === "result")).toBe(false);
      expect(
        steps
          .filter((step) => step.containerStepRunId === block?.id)
          .map((step) => step.branch)
          .sort()
      ).toEqual(["a", "b", "c"]);
    } finally {
      release.release();
      await running;
    }
    // A new worker takes up the persisted frontier after the branch jobs ended.
    const ended = await t.finish(run.id, t.worker());
    expect(ended.status).toBe("done");
    expect(t.executed.filter((call) => call.operation === "echo")).toHaveLength(1);
    expect(writesOf(t)).toEqual(Array.from({ length: 6 }, () => ({ data })));
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({
      analyses: Object.fromEntries(["a", "b", "c"].map((id) => [id, { received: { data } }]))
    });
    const steps = await stepRunsOf(t, run.id);
    const analyses = steps.filter((step) => step.stepId.startsWith("check_"));
    expect(
      Math.max(...analyses.map((step) => Date.parse(step.startedAt ?? "")))
    ).toBeLessThanOrEqual(Math.min(...analyses.map((step) => Date.parse(step.finishedAt ?? ""))));
    expect(
      steps.every((step) => Date.parse(step.finishedAt ?? "") >= Date.parse(step.startedAt ?? ""))
    ).toBe(true);
    expect(steps.filter((step) => step.stepId === "result")).toHaveLength(1);
    expect(steps.find((step) => step.stepId === "analyses")?.bodyCounts?.keep_c).toEqual({
      total: 1,
      done: 1,
      failed: 0,
      running: 0
    });
  });

  it("bounds active branches, preserves order within each, and uses all slots when concurrency is omitted", async () => {
    const t = await ready(
      definition({ id: "analyses", name: "Analyses", type: "parallel", branches, concurrency: 2 })
    );
    const { run, worker } = await reachBlock(t);
    expect(
      (await stepRunsOf(t, run.id))
        .filter((step) => step.branch)
        .map((step) => step.branch)
        .sort()
    ).toEqual(["a", "b"]);
    await worker.runDue();
    // First steps ending do not admit C while A and B still have their second step.
    expect((await stepRunsOf(t, run.id)).filter((step) => step.branch === "c")).toEqual([]);
    expect((await t.finish(run.id, worker)).status).toBe("done");
    expect(writesOf(t)).toHaveLength(6);
  });

  it("lets other branches finish, including ones waiting for concurrency, before failing at the join", async () => {
    const t = await ready(
      definition({ id: "analyses", name: "Analyses", type: "parallel", branches, concurrency: 1 })
    );
    let calls = 0;
    t.setBehaviour((operation, input) => {
      if (operation === "echo") return Promise.resolve({ clients: [] });
      if (++calls === 1) throw new Error("Analysis unavailable");
      return Promise.resolve({ received: input });
    });
    const { run, worker } = await reachBlock(t);
    await worker.runDue();
    expect(
      runSchema.parse(
        (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } })).json()
      ).status
    ).toBe("running");
    expect((await stepRunsOf(t, run.id)).find((step) => step.stepId === "analyses")?.status).toBe(
      "waiting"
    );
    expect((await t.finish(run.id, worker)).status).toBe("failed");
    const steps = await stepRunsOf(t, run.id);
    expect(steps.find((step) => step.stepId === "keep_a")).toBeUndefined();
    expect(steps.find((step) => step.stepId === "keep_b")?.status).toBe("done");
    expect(steps.find((step) => step.stepId === "keep_c")?.status).toBe("done");
    expect(steps.find((step) => step.stepId === "result")).toBeUndefined();
    expect(writesOf(t)).toHaveLength(5);
  });

  it("drains sibling refusals before propagating a run-wide failure past a continuing loop", async () => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Each",
        type: "loop",
        items: { step: "clients", path: "clients" },
        onItemFailure: "continue",
        steps: [{ id: "fork", name: "Fork", type: "parallel", concurrency: 1, branches }]
      })
    );
    const run = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 4; pass++) await worker.runDue();
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      status: "disabled"
    });
    const ended = await t.finish(run.id, worker);
    expect(ended).toMatchObject({ status: "failed", error: { code: "principal_inactive" } });
    const steps = await stepRunsOf(t, run.id);
    expect(
      steps
        .filter((step) => step.stepId.startsWith("check_"))
        .map((step) => [step.branch, step.status])
        .sort()
    ).toEqual([
      ["a", "failed"],
      ["b", "failed"],
      ["c", "failed"]
    ]);
    expect(
      steps.filter((step) => step.iteration).every((step) => step.iteration?.index === 0)
    ).toBe(true);
    expect(writesOf(t)).toEqual([]);
  });

  it("cancels all branches during overlapping calls and starts no branch tail or join", async () => {
    const t = await ready();
    const all = gate(),
      release = gate();
    let entered = 0;
    t.setBehaviour(async (operation, input): Promise<JsonValue> => {
      if (operation === "echo") return { clients: [] };
      if (++entered === 3) all.release();
      await release.promise;
      return { received: input };
    });
    const { run, worker } = await reachBlock(t);
    const running = worker.runDue();
    try {
      await within(all.promise);
      await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: run.id } });
    } finally {
      release.release();
      await running;
    }
    await worker.runDue();
    expect(
      runSchema.parse(
        (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } })).json()
      ).status
    ).toBe("cancelled");
    expect(writesOf(t)).toHaveLength(3);
    const steps = await stepRunsOf(t, run.id);
    expect(steps.find((step) => step.stepId === "analyses")?.status).toBe("cancelled");
    expect(
      steps.filter((step) => step.stepId.startsWith("keep_") || step.stepId === "result")
    ).toEqual([]);
  });

  it("cancels queued work and never admits a later branch", async () => {
    const t = await ready(
      definition({ id: "analyses", name: "Analyses", type: "parallel", branches, concurrency: 1 })
    );
    const { run, worker } = await reachBlock(t);
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: run.id } });
    await worker.runDue();
    expect(writesOf(t)).toEqual([]);
    const steps = await stepRunsOf(t, run.id);
    expect(steps.filter((step) => step.branch).map((step) => [step.branch, step.status])).toEqual([
      ["a", "cancelled"]
    ]);
  });

  it.each([{ branches: [] }, { branches: [{ id: "empty", name: "Empty", steps: [] }] }])(
    "joins empty branches ($branches)",
    async ({ branches }) => {
      const t = await ready(
        definition({ id: "analyses", name: "Analyses", type: "parallel", branches })
      );
      const run = await t.finish((await start(t)).id);
      expect(run.status, JSON.stringify(run.error)).toBe("done");
      expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
        analyses: branches.length ? { empty: null } : {}
      });
      expect(
        (await stepRunsOf(t, run.id)).find((step) => step.stepId === "analyses")?.bodyCounts
      ).toEqual({});
    }
  );

  it("respects the step-run budget during branch admission", async () => {
    const t = await ready(definition(), { limits: { maxStepRuns: 4 } });
    const run = await t.finish((await start(t)).id);
    expect(run).toMatchObject({
      status: "limit_reached",
      stepRunCount: 4,
      error: { code: "step_limit" }
    });
    expect(writesOf(t)).toEqual([]);
  });
});

describe("condition execution and mixed blocks", () => {
  it.each([true, false])(
    "runs only the chosen branch (%s), returning its last output",
    async (takeThen) => {
      const t = await ready(
        definition({
          id: "analyses",
          name: "Choose",
          type: "condition",
          when: {
            ref: { step: "start", path: "input.note" },
            op: "equals",
            value: takeThen ? "Quarterly figures are ready" : "other"
          },
          then: [action("yes")],
          else: [action("no")]
        })
      );
      const run = await t.finish((await start(t)).id);
      expect(run.status).toBe("done");
      expect(JSON.parse(run.outputPreview?.text ?? "null")).toMatchObject({
        analyses: {
          taken: takeThen ? "then" : "else",
          result: { received: { data: expect.any(Array) } }
        }
      });
      const steps = await stepRunsOf(t, run.id);
      expect(steps.filter((step) => step.branch).map((step) => [step.stepId, step.branch])).toEqual(
        [[takeThen ? "yes" : "no", takeThen ? "then" : "else"]]
      );
    }
  );

  it.each([
    { op: "greater_than", actual: 3, value: 2, taken: "then" },
    { op: "greater_than_or_equal", actual: 2, value: 2, taken: "then" },
    { op: "less_than", actual: 3, value: 2, taken: "else" },
    { op: "less_than_or_equal", actual: 2, value: 2, taken: "then" },
    { op: "equals", actual: { b: 2, a: 1 }, value: { a: 1, b: 2 }, taken: "then" }
  ])("evaluates $op without coercion", async ({ op, actual, value, taken }) => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Choose",
        type: "condition",
        when: { ref: { step: "clients", path: "actual" }, op, value },
        then: [],
        else: []
      })
    );
    t.setBehaviour(() => Promise.resolve({ actual }));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      analyses: { taken, result: null }
    });
  });

  it("fails an ordered comparison on text without running a branch", async () => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Choose",
        type: "condition",
        when: { ref: { step: "start", path: "input.note" }, op: "greater_than", value: 2 },
        then: [action("yes")]
      })
    );
    const run = await t.finish((await start(t)).id);
    expect(run).toMatchObject({ status: "failed", error: { code: "condition_invalid" } });
    expect(writesOf(t)).toEqual([]);
  });

  it("returns null when the chosen branch is omitted", async () => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Choose",
        type: "condition",
        when: { ref: { step: "start", path: "input.note" }, op: "equals", value: "other" },
        then: [action("yes")]
      })
    );
    const run = await t.finish((await start(t)).id);
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      analyses: { taken: "else", result: null }
    });
    expect(writesOf(t)).toEqual([]);
  });

  it("resolves ancestors and branch-local outputs through loop → parallel → condition nesting", async () => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Each",
        type: "loop",
        items: { step: "clients", path: "clients" },
        concurrency: 3,
        steps: [
          {
            id: "fork",
            name: "Fork",
            type: "parallel",
            branches: [
              {
                id: "left",
                name: "Left",
                steps: [
                  {
                    id: "choice",
                    name: "Choice",
                    type: "condition",
                    when: {
                      ref: { step: "analyses", path: "id" },
                      op: "not_equals",
                      value: "never"
                    },
                    then: [
                      action("read_item", { data: ref("analyses", "id") }),
                      action("repeat", { data: ref("read_item", "received.data") })
                    ]
                  }
                ]
              },
              {
                id: "right",
                name: "Right",
                steps: [action("other", { data: ref("analyses", "id") })]
              }
            ]
          }
        ]
      })
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(
      writesOf(t)
        .map((input) => JSON.stringify(input))
        .sort()
    ).toEqual(
      ["client-anna", "client-bert", "client-cleo"]
        .flatMap((id) => Array.from({ length: 3 }, () => JSON.stringify({ data: id })))
        .sort()
    );
  });

  it("lets an outer continuing loop count a failed parallel item after its sibling completes", async () => {
    const t = await ready(
      definition({
        id: "analyses",
        name: "Each",
        type: "loop",
        items: { step: "clients", path: "clients" },
        onItemFailure: "continue",
        steps: [
          {
            id: "fork",
            name: "Fork",
            type: "parallel",
            branches: [
              {
                id: "bad",
                name: "Bad",
                steps: [
                  {
                    id: "bad_choice",
                    name: "Bad choice",
                    type: "condition",
                    when: { ref: { step: "start", path: "missing" }, op: "equals", value: true },
                    then: []
                  }
                ]
              },
              { id: "good", name: "Good", steps: [action("other")] }
            ]
          }
        ]
      })
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toMatchObject({
      analyses: { total: 3, failed: 3, done: 0 }
    });
    expect(writesOf(t)).toHaveLength(3);
  });
});

it("validates branch ids, reference scope, nested unsupported fields and condition references", () => {
  const issues = (block: unknown) => {
    const read = parseWorkflowManifest(definition(block));
    return read.ok ? [] : read.issues;
  };
  expect(
    issues({ id: "analyses", name: "Fork", type: "parallel", branches: [branches[0], branches[0]] })
  ).not.toEqual([]);
  expect(
    issues({
      id: "analyses",
      name: "Fork",
      type: "parallel",
      branches: [
        { id: "a", name: "A", steps: [action("a", { data: ref("b") })] },
        { id: "b", name: "B", steps: [action("b")] }
      ]
    })
  ).toContainEqual(expect.objectContaining({ code: "reference_out_of_scope" }));
  expect(
    issues({
      id: "analyses",
      name: "Choose",
      type: "condition",
      when: { ref: { step: "absent", path: "" }, op: "equals", value: true },
      then: []
    })
  ).toContainEqual(expect.objectContaining({ path: "steps.analyses" }));
  expect(
    issues({
      id: "analyses",
      name: "Choose",
      type: "condition",
      when: { ref: { step: "clients", path: "" }, op: "expression", value: true },
      then: []
    })
  ).not.toEqual([]);
});
