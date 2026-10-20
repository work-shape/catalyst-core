import { afterEach, describe, expect, it } from "vitest";
import {
  publishedDefinitions,
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

// The scale test of a loop: 1,000 items, three of which fail. It runs only with
// CATALYST_SCALE_TESTS=1 (vitest.config.ts).

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
  it("runs 1,000 items, continues past the 3 that fail and counts them", async () => {
    const clients = Array.from({ length: 1_000 }, (_, index) => ({
      id: `client-${String(index).padStart(4, "0")}`
    }));
    const failing = ["client-0100", "client-0500", "client-0999"];
    const definitions = publishedDefinitions();
    definitions.publish(notifyClients({ onItemFailure: "continue" }));
    const t = await ready({ definitions: definitions.source });
    // The test Connection answers a kilobyte at most; a list of a thousand clients is more.
    t.state.limits = { ...t.state.limits, resultMaxBytes: 64 * 1_024 };
    t.setBehaviour(failingFor(failing, clients));

    const run = await t.finish((await start(t)).id, undefined, 1_200);
    // The loop and the run go on and end as done; the failed items are counted.
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(run.stepRunCount).toBe(1_004);
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 997, failed: 3 });
    // Every item was called once, the failing ones among them, and none a second time.
    expect(writesOf(t)).toHaveLength(1_000);
    expect(new Set(writesOf(t).map((input) => JSON.stringify(input))).size).toBe(1_000);

    const top = await stepRunsOf(t, run.id, { limit: 3 });
    const loop = top.find((stepRun) => stepRun.key === "each_client");
    expect(loop).toMatchObject({
      status: "done",
      loop: { total: 1_000, done: 997, failed: 3, running: 0 },
      bodyCounts: { send: { total: 1_000, done: 997, failed: 3, running: 0 } }
    });
    expect(JSON.parse(loop?.outputPreview?.text ?? "null")).toEqual({
      total: 1_000,
      done: 997,
      failed: 3
    });
    // The failed items are read as the step runs of the loop that failed, and no other.
    const failed = await stepRunsOf(t, run.id, { containerStepRunId: loop?.id, status: "failed" });
    expect(failed.map((stepRun) => stepRun.iteration?.label)).toEqual(failing);
    expect(failed.map((stepRun) => stepRun.iteration?.index)).toEqual([100, 500, 999]);
    // One item a worker pass: 1,004 passes of about 75 ms, 80 s when it runs alone. In the
    // full suite on a loaded machine they ran past 300 s.
  }, 1_200_000);
});
