import { randomUUID } from "node:crypto";
import { createPlatformId } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { useAgentRunJobFixture } from "./support/agent-run-job-fixture";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// MODEL-REGION-3: the worker hands a subagent's run what picked the model of the run that
// started it, so the runtime counts that run's route among the subagent's own.

describe("a subagent's run as a claimed job", () => {
  const db = usePostgresSuite("agent_run_ancestors");
  const harness = useJobExecutorHarness(db);
  const { createFixture } = useAgentRunJobFixture(db, harness);

  it("starts with the model its parent run was started on", async () => {
    const fixture = await createFixture("ancestors");
    const parent = await fixture.accept("Do the work", { modelBindingId: "outside" });
    const parentPass = fixture.worker().runDue();
    const parentExecution = await fixture.executor.next();
    const child = await db.store.childAgentRuns.startSubagentRun({
      clientInstanceId: fixture.clientInstanceId,
      parentRunId: parent.id,
      parentOperationRunId: createPlatformId<"OperationRunId">("oprun"),
      agentName: "research_agent",
      description: "Read",
      task: "Read",
      correlationId: randomUUID()
    });
    if (child.status !== "started") throw new Error("No child");

    const childPass = fixture.worker().runDue();
    const childExecution = await fixture.executor.next();
    expect(childExecution.input.ancestors).toEqual([
      { agentName: "test_agent", modelBindingId: "outside" }
    ]);
    expect(parentExecution.input.ancestors).toBeUndefined();
    childExecution.complete();
    parentExecution.complete();
    await Promise.all([parentPass, childPass]);
  });
});
