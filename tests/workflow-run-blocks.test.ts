import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowStepRunFilterSchema, type WorkflowManifest } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import {
  publishedDefinitions,
  runSchema,
  type workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import {
  failingFor,
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

// What a Workflow Run does with the blocks of its definition and with its revision: a loop
// whose items fail, a cancel inside a loop, a reserved block, a definition that changes while
// the run is going, and the list of the Workflows with their latest runs.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const ready = (options: Parameters<typeof workflowFixture>[0] = {}) =>
  readyWorkflows((fixture) => {
    open = fixture;
  }, options);

describe("a loop whose items fail", () => {
  it("skips the rest of a failed item, and counts each step of the loop on its own", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(
      notifyClients({ onItemFailure: "continue" }, [
        {
          id: "confirm",
          name: "Confirm",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { ref: { step: "send", path: "received.client" } } }
        }
      ])
    );
    const t = await ready({ definitions: definitions.source });
    t.setBehaviour(failingFor(["client-bert"]));
    const jobs = t.worker();
    const started = await start(t);
    // The trigger, the read, the loop, and the first step of the first item.
    for (let pass = 0; pass < 4; pass++) await jobs.runDue();
    const midway = (await stepRunsOf(t, started.id)).find(
      (stepRun) => stepRun.stepId === "each_client"
    );
    // A step no item has reached yet is counted with nothing done.
    expect(midway?.bodyCounts).toEqual({
      send: { total: 3, done: 1, failed: 0, running: 0 },
      confirm: { total: 3, done: 0, failed: 0, running: 1 }
    });
    expect(midway?.loop).toEqual({ total: 3, done: 0, failed: 0, running: 1 });

    const run = await t.finish(started.id, jobs);
    expect(run.status).toBe("done");
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "done"],
      ["each_client[0].send", "done"],
      ["each_client[0].confirm", "done"],
      ["each_client[1].send", "failed"],
      ["each_client[2].send", "done"],
      ["each_client[2].confirm", "done"],
      ["result", "done"]
    ]);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      loop: { total: 3, done: 2, failed: 1, running: 0 },
      bodyCounts: {
        send: { total: 3, done: 2, failed: 1, running: 0 },
        confirm: { total: 3, done: 2, failed: 0, running: 0 }
      }
    });
  });

  it("stops at the first failed item where the loop does not continue, and fails the run there", async () => {
    const t = await ready();
    t.setBehaviour(failingFor(["client-bert"]));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "failed"],
      ["each_client[0].send", "done"],
      ["each_client[1].send", "failed"]
    ]);
    expect(run.error?.stepRunId).toBe(stepRuns.at(-1)?.id);
    expect(writesOf(t)).toHaveLength(2);
  });
});

describe("cancelling a Workflow Run inside a loop", () => {
  it("starts no further item, ends the loop's step run and says who cancelled and when", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.use");
    const started = await start(t, t.kai.id);
    const jobs = t.worker();
    // The trigger, the read, the loop, and its first item.
    for (let pass = 0; pass < 4; pass++) await jobs.runDue();
    expect(writesOf(t)).toHaveLength(1);

    const cancelled = runSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.cancel_run", { params: { runId: started.id } })).json()
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledBy).toBe(t.kai.id);
    expect(Date.parse(cancelled.cancelledAt ?? "")).toBeGreaterThan(0);

    for (let pass = 0; pass < 4; pass++) await jobs.runDue();
    // The second item had its step run and never ran; the third never got one.
    expect(writesOf(t)).toHaveLength(1);
    const stepRuns = await stepRunsOf(t, started.id);
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "cancelled"],
      ["each_client[0].send", "done"],
      ["each_client[1].send", "cancelled"]
    ]);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.loop).toEqual({
      total: 3,
      done: 1,
      failed: 0,
      running: 0
    });
    const read = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: started.id } })).json()
    );
    expect(read).toMatchObject({
      status: "cancelled",
      cancelledBy: t.kai.id,
      cancelledAt: cancelled.cancelledAt
    });
  });

  it("lets a call that is running finish and starts nothing after it", async () => {
    const t = await ready();
    const started = await start(t);
    const jobs = t.worker();
    for (let pass = 0; pass < 3; pass++) await jobs.runDue();
    // The cancel arrives while the first item's call is with the outside system.
    let cancel: Promise<unknown> | undefined;
    t.setBehaviour((_operation, input) => {
      cancel ??= t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
      return cancel.then(() => ({ received: input }));
    });
    for (let pass = 0; pass < 4; pass++) await jobs.runDue();
    expect(writesOf(t)).toHaveLength(1);
    expect(
      (await stepRunsOf(t, started.id)).map((stepRun) => [stepRun.key, stepRun.status])
    ).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "cancelled"],
      ["each_client[0].send", "done"]
    ]);
  });
});

describe("a reserved block", () => {
  it("is refused with not_supported_yet when its definition is published or started", async () => {
    const definitions = publishedDefinitions();
    const condition = {
      id: "check",
      name: "Check",
      type: "condition",
      when: { ref: { step: "start", path: "input.note" }, op: "equals", value: "x" },
      then: [],
      else: []
    };
    const definition = notifyClients();
    expect(() =>
      definitions.publish({
        ...definition,
        steps: [definition.steps[0], condition, definition.steps[3]]
      })
    ).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: "not_supported_yet" }) })
    );

    const t = await ready();
    const refused = await t.expectRefused(
      t.root.id,
      "workflows.start",
      { params: { workflow: "with-condition" }, payload: {} },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({
      reason: "not_supported_yet",
      issues: [{ code: "not_supported_yet", path: "steps.check" }]
    });
    expect(
      await t.stores.audit.listAuditEvents({ clientInstanceId, type: "workflow_run.started" })
    ).toEqual([]);
  });

  it("fails the run at the block, without a crash, where a run reaches one all the same", async () => {
    // A definition another release stored: nothing checked it on its way to the engine.
    const manifest: WorkflowManifest = {
      id: "with-blocks",
      name: "With blocks",
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "check",
          name: "Check",
          type: "condition",
          when: { ref: { step: "start", path: "input.note" }, op: "equals", value: "x" },
          then: [
            {
              id: "then_read",
              name: "Read",
              type: "operation",
              operation: "connection.crm.echo",
              input: {}
            }
          ]
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    const definitions = publishedDefinitions();
    definitions.hold(manifest, "rev-with-condition");
    const t = await ready({ definitions: definitions.source });
    const run = await t.finish((await start(t, t.root.id, "with-blocks")).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("not_supported_yet");
    expect(t.executed).toEqual([]);
    const stepRuns = await stepRunsOf(t, run.id);
    // One attempt: the refusal is no crash that the executor would run again.
    expect(stepRuns.map((stepRun) => [stepRun.key, stepRun.status, stepRun.attempt])).toEqual([
      ["start", "done", 1],
      ["check", "failed", 1]
    ]);
    expect(run.error?.stepRunId).toBe(stepRuns[1]?.id);

    const [start0, , result] = manifest.steps;
    if (!start0 || !result) throw new Error("The definition lost a step");
    definitions.hold(
      {
        ...manifest,
        steps: [
          start0,
          {
            id: "both",
            name: "Both",
            type: "parallel",
            branches: [{ id: "left", name: "Left", steps: [] }],
            concurrency: 2
          },
          result
        ]
      },
      "rev-with-parallel"
    );
    const parallel = await t.finish((await start(t, t.root.id, "with-blocks")).id);
    expect(parallel).toMatchObject({ status: "failed", error: { code: "not_supported_yet" } });
  });
});

describe("a definition that changes while a run is going", () => {
  it("finishes the run on the revision it started with, and starts the next on the new one", async () => {
    const definitions = publishedDefinitions();
    const first = definitions.publish(notifyClients());
    const t = await ready({ definitions: definitions.source });
    const jobs = t.worker();
    const started = await start(t);
    expect(started.definitionRevisionId).toBe(first);
    // The trigger and the read have run; the loop has not started.
    await jobs.runDue();
    await jobs.runDue();

    // The new revision has no loop at all and returns other fields.
    const changed = notifyClients();
    const second = definitions.publish({
      ...changed,
      steps: [
        changed.steps[0],
        changed.steps[1],
        { id: "result", name: "Result", type: "output", input: { sent: { value: -1 } } }
      ]
    });
    expect(second).not.toBe(first);

    const run = await t.finish(started.id, jobs);
    expect(run.status).toBe("done");
    expect(run.definitionRevisionId).toBe(first);
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    expect(writesOf(t)).toHaveLength(3);
    expect((await stepRunsOf(t, run.id)).map((stepRun) => stepRun.key)).toEqual([
      "start",
      "clients",
      "each_client",
      "each_client[0].send",
      "each_client[1].send",
      "each_client[2].send",
      "result"
    ]);

    const next = await t.finish((await start(t)).id, jobs);
    expect(next.definitionRevisionId).toBe(second);
    expect(JSON.parse(next.outputPreview?.text ?? "null")).toEqual({ sent: -1 });
    expect(writesOf(t)).toHaveLength(3);
  });
});

describe("the list of the Workflows", () => {
  it("names each Workflow the caller may read with its latest run", async () => {
    const t = await ready();
    const listed = async (userId: string) =>
      z
        .object({
          items: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              lastRun: z
                .object({
                  id: z.string(),
                  status: z.string(),
                  startedAt: z.string().optional(),
                  endedAt: z.string().optional()
                })
                .optional()
            })
          )
        })
        .parse((await t.expectOk(userId, "workflows.list")).json()).items;

    // A Workflow that never ran has no latest run.
    expect(await listed(t.root.id)).toEqual([
      { id: "notify-clients", name: "Notify clients" },
      { id: "top-customers", name: "Top customers" }
    ]);
    const first = await t.finish((await start(t)).id);
    const second = await start(t);
    const [notify, top] = await listed(t.root.id);
    expect(notify?.lastRun).toEqual({ id: second.id, status: "queued" });
    expect(top?.lastRun).toBeUndefined();
    const ended = await t.finish(second.id);
    expect((await listed(t.root.id))[0]?.lastRun).toEqual({
      id: ended.id,
      status: "done",
      startedAt: expect.any(String),
      endedAt: expect.any(String)
    });
    expect(first.id).not.toBe(ended.id);

    // The list is of what the caller may read.
    expect(await listed(t.kai.id)).toEqual([]);
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    expect((await listed(t.kai.id)).map((workflow) => workflow.id)).toEqual([
      "notify-clients",
      "top-customers"
    ]);
  });
});

describe("the step runs of a run outside its loops", () => {
  it("answers the steps of the definition's own list, a loop with its counts and none of its items", async () => {
    const t = await ready();
    const run = await t.finish((await start(t)).id);
    const top = await stepRunsOf(t, run.id, { topLevel: "true" });
    expect(top.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["clients", "done"],
      ["each_client", "done"],
      ["result", "done"]
    ]);
    expect(top.every((stepRun) => stepRun.containerStepRunId === undefined)).toBe(true);
    // The loop is read here with what the run view shows of it, and its items elsewhere.
    expect(top[2]).toMatchObject({
      loop: { total: 3, done: 3, failed: 0, running: 0 },
      bodyCounts: { send: { total: 3, done: 3, failed: 0, running: 0 } }
    });
    // It goes with the filter of the status and pages like every list.
    expect(await stepRunsOf(t, run.id, { topLevel: "true", status: "failed" })).toEqual([]);
    expect(
      (await stepRunsOf(t, run.id, { topLevel: "true", limit: 2 })).map((stepRun) => stepRun.key)
    ).toEqual(["start", "clients"]);

    // The reads there were are as they were: all step runs, and those of one block.
    expect(await stepRunsOf(t, run.id)).toHaveLength(7);
    expect(await stepRunsOf(t, run.id, { topLevel: "false" })).toHaveLength(7);
    expect(await stepRunsOf(t, run.id, { containerStepRunId: top[2]?.id })).toHaveLength(3);
    // A step run of a block stands in that block, and so not at the top.
    await t.expectRefused(
      t.root.id,
      "workflows.list_step_runs",
      { params: { runId: run.id }, query: { topLevel: "true", containerStepRunId: top[2]?.id } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
  });

  it("is a filter of the store, which the contract's schema names", async () => {
    const t = await ready();
    const started = await start(t);
    const run = await t.finish(started.id);
    const read = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
    if (!read) throw new Error("The run cannot be read");
    const filter = workflowStepRunFilterSchema.parse({ topLevel: true, status: "done" });
    const stepRuns = await t.stores.workflowRuns.listStepRuns({
      clientInstanceId,
      runId: read.id,
      filter
    });
    expect(stepRuns.map((stepRun) => stepRun.key)).toEqual([
      "start",
      "clients",
      "each_client",
      "result"
    ]);
  });
});
