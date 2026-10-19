import { describe, expect, it } from "vitest";
import { createSampleSource } from "./support/chat-ui";
import { required } from "./support/assertions";

// LOWS-C 5: a run names the account it acted as, as its own. The samples answer through the
// instance's mapping, so every sample run, and one a reader starts, carries that account.
describe("the account of a sample run", () => {
  it("is the run's own, on every listed run, on a read run and on a started one", async () => {
    const source = createSampleSource("en");
    const runs = required(source.runs);
    const signal = new AbortController().signal;
    const workflows = await source.listWorkflows("cw_1", { limit: 50, cursor: undefined }, signal);
    expect(workflows.items.length).toBeGreaterThan(0);
    const accounts: (string | undefined)[] = [];
    for (const workflow of workflows.items) {
      expect((await source.getWorkflow("cw_1", workflow.id, signal)).runsAs).toBe(
        "Workflow runner"
      );
      const listed = await runs.listRuns(workflow.id, { limit: 50, cursor: undefined }, signal);
      for (const run of listed.items) {
        accounts.push(run.runsAs, (await runs.getRun(run.id, signal)).runsAs);
      }
    }
    expect(accounts.length).toBeGreaterThan(0);
    expect(new Set(accounts)).toEqual(new Set(["Workflow runner"]));
    const started = await runs.start("monthly-booking-check", {});
    expect(started.runsAs).toBe("Workflow runner");
    expect((await runs.getRun(started.id, signal)).runsAs).toBe("Workflow runner");
  });
});
