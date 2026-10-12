import { describe, expect, it } from "vitest";
import { createPlatformId, workflowStepIdempotencyKey } from "@vivd-catalyst/core";
import { change, createServer, person } from "./support/operation-server";

// The key of a step's changing call, held against what an Operation Run does with a key.

describe("the idempotency key of a step's changing call", () => {
  // Fails with the key of run and step, which one step has once for all items of its loop:
  // the first item acts, and the second and third meet the first one's key and act no time.
  it("acts once for each item of a loop and no further time for a retried item", async () => {
    const { server, runs, executed } = await createServer();
    const stepRuns = ["10432", "10433", "10434"].map((item) => ({
      item,
      id: createPlatformId<"WorkflowStepRunId">("wfs")
    }));
    const act = (stepRun: (typeof stepRuns)[number]) =>
      server.call(
        "testRunChange",
        change(stepRun.item, "ok", workflowStepIdempotencyKey(stepRun.id)),
        person()
      );

    for (const stepRun of stepRuns) {
      expect((await act(stepRun)).statusCode).toBe(200);
    }
    expect(executed).toHaveLength(3);

    // The second item's step run is retried: it answers with its first run.
    const [, second] = stepRuns;
    if (!second) throw new Error("No second step run");
    const retried = await act(second);
    expect(retried.statusCode).toBe(200);
    expect(executed).toHaveLength(3);
    const recorded = await runs();
    expect(recorded).toHaveLength(3);
    expect(new Set(recorded.map((run) => run.idempotencyKey))).toEqual(
      new Set(stepRuns.map((stepRun) => workflowStepIdempotencyKey(stepRun.id)))
    );
  });
});
