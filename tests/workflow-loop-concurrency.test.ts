import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonValue } from "@vivd-catalyst/core";
import { WORKFLOW_STEP_JOB_SLOTS, parseWorkflowManifest } from "@vivd-catalyst/workflows";
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

// A loop that runs several of its items at once: `concurrency` from 1 to 8. The items are
// step runs like any other, each executed by its own job, so the worker of the test runs them
// side by side in one pass.

const CLIENTS = Array.from({ length: 8 }, (_, index) => ({ id: `client-${String(index)}` }));

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function ready(
  loop: Record<string, unknown>,
  options: Parameters<typeof workflowFixture>[0] = {},
  inner: unknown[] = []
) {
  const definitions = publishedDefinitions();
  definitions.publish(notifyClients(loop, inner));
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source, ...options }
  );
  t.setBehaviour(failingFor([], CLIENTS));
  return t;
}

/** A Connection that counts how many of its changing calls are with it at one moment. */
function countingCalls(t: WorkflowFixture) {
  const seen = { going: 0, most: 0 };
  t.setBehaviour(async (operation, input): Promise<JsonValue> => {
    if (operation === "echo") return { clients: CLIENTS };
    seen.going += 1;
    seen.most = Math.max(seen.most, seen.going);
    await new Promise((resolve) => setTimeout(resolve, 40));
    seen.going -= 1;
    return { received: input };
  });
  return seen;
}

describe("a loop with concurrency above 1", () => {
  it("is accepted from 1 to 8 and refused above", () => {
    const codes = (concurrency: number) => {
      const result = parseWorkflowManifest(notifyClients({ concurrency }));
      return result.ok ? "ok" : result.issues.map((issue) => issue.path).join(",");
    };
    expect([1, 2, 8].map(codes)).toEqual(["ok", "ok", "ok"]);
    expect(codes(9)).toBe("steps.2.concurrency");
    expect(codes(0)).toBe("steps.2.concurrency");
  });

  it("runs that many items at once, each item once, and counts them all", async () => {
    const t = await ready({ concurrency: 3 });
    const seen = countingCalls(t);
    const run = await t.finish((await start(t)).id);

    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 8, failed: 0 });
    // Three items were with the outside system at one moment, and never a fourth.
    expect(seen.most).toBe(3);
    const stepRuns = await stepRunsOf(t, run.id);
    const items = stepRuns.filter((stepRun) => stepRun.iteration !== undefined);
    // One step run per item and path, whichever items ended at the same moment.
    expect(items.map((stepRun) => stepRun.key).sort()).toEqual(
      CLIENTS.map((_, index) => `each_client[${String(index)}].send`)
    );
    expect(new Set(writesOf(t).map((input) => JSON.stringify(input))).size).toBe(8);
    expect(writesOf(t)).toHaveLength(8);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      status: "done",
      loop: { total: 8, done: 8, failed: 0, running: 0 },
      // What the loop asked for is what it ran with: a process has a slot for each.
      concurrency: { asked: 3, ranWith: 3 },
      bodyCounts: { send: { total: 8, done: 8, failed: 0, running: 0 } }
    });
    expect(run.stepRunCount).toBe(12);
  });

  // Fails without the change: a run said nowhere that a process ran fewer items at once than
  // its loop asked for.
  it("says on the loop's step run that a process ran fewer items at once than the loop asked for", async () => {
    const t = await ready({ concurrency: 8 });
    const run = await t.finish((await start(t)).id);
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.concurrency).toEqual({
      asked: 8,
      ranWith: WORKFLOW_STEP_JOB_SLOTS
    });
    expect(WORKFLOW_STEP_JOB_SLOTS).toBeLessThan(8);
    // No other step run says anything of it.
    expect(
      stepRuns.filter((stepRun) => stepRun.key !== "each_client" && stepRun.concurrency)
    ).toEqual([]);
  });

  it("starts the items in the order of the list and keeps the count of those going", async () => {
    const t = await ready({ concurrency: 3 });
    const started = await start(t);
    const worker = t.worker();
    // The trigger, the read, and the loop, which starts its first three items.
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    const loopOf = async () =>
      (await stepRunsOf(t, started.id)).find((stepRun) => stepRun.key === "each_client");
    expect((await loopOf())?.loop).toEqual({ total: 8, done: 0, failed: 0, running: 3 });
    expect(
      (await stepRunsOf(t, started.id))
        .filter((stepRun) => stepRun.iteration !== undefined)
        .map((stepRun) => stepRun.iteration?.index)
        .sort()
    ).toEqual([0, 1, 2]);
    // Each item that ends starts the next one: three are going again.
    await worker.runDue();
    expect((await loopOf())?.loop).toEqual({ total: 8, done: 3, failed: 0, running: 3 });
  });

  it("continues past failed items and ends done with them counted", async () => {
    const t = await ready({ concurrency: 3, onItemFailure: "continue" });
    t.setBehaviour(failingFor(["client-1", "client-6"], CLIENTS));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 6, failed: 2 });
    expect(writesOf(t)).toHaveLength(8);
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.loop).toEqual({
      total: 8,
      done: 6,
      failed: 2,
      running: 0
    });
    expect(
      stepRuns
        .filter((stepRun) => stepRun.status === "failed")
        .map((stepRun) => stepRun.iteration?.label)
        .sort()
    ).toEqual(["client-1", "client-6"]);
  });

  it("starts no further item after one failed where the loop stops", async () => {
    const t = await ready({ concurrency: 3 });
    t.setBehaviour(failingFor(["client-1"], CLIENTS));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    // The three that were going made their calls, and nothing after them was called. An item
    // that ended before the failure was written may have started its successor: at most the
    // two others did, and what they started was cancelled with the run.
    expect(writesOf(t)).toHaveLength(3);
    const stepRuns = await stepRunsOf(t, run.id);
    const items = stepRuns.filter((stepRun) => stepRun.iteration !== undefined);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(
      items
        .filter((stepRun) => (stepRun.iteration?.index ?? 0) > 2)
        .every((stepRun) => stepRun.status === "cancelled")
    ).toBe(true);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.status).toBe("failed");
    expect(run.error?.stepRunId).toBe(
      items.find((stepRun) => stepRun.iteration?.label === "client-1")?.id
    );
  });

  it("starts no further item after a cancel, and none of those waiting runs", async () => {
    const t = await ready({ concurrency: 3 });
    const started = await start(t);
    const worker = t.worker();
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    expect(writesOf(t)).toEqual([]);
    const stepRuns = await stepRunsOf(t, started.id);
    expect(
      stepRuns.filter((stepRun) => stepRun.iteration !== undefined).map((stepRun) => stepRun.status)
    ).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.status).toBe("cancelled");
  });

  it("is bound by the run's step runs: the loop starts no item past the limit", async () => {
    // Three step runs before the items, and room for two items of the three it would start.
    const t = await ready({ concurrency: 3 }, { limits: { maxStepRuns: 5 } });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("limit_reached");
    expect(run.error?.code).toBe("step_limit");
    expect(run.stepRunCount).toBe(5);
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.filter((stepRun) => stepRun.iteration !== undefined)).toHaveLength(2);
    expect(writesOf(t)).toEqual([]);
  });

  it("runs a loop of two steps side by side without mixing the items", async () => {
    const t = await ready({ concurrency: 4 }, {}, [
      {
        id: "confirm",
        name: "Confirm",
        type: "operation",
        operation: "connection.crm.write",
        input: { confirmed: { ref: { step: "send", path: "received.client" } } }
      }
    ]);
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    // Each item's second step read the answer of its own first step.
    const confirmed = writesOf(t).flatMap((input) =>
      typeof input === "object" && input !== null && "confirmed" in input ? [input.confirmed] : []
    );
    expect(confirmed.sort()).toEqual(CLIENTS.map((client) => client.id));
    expect(run.stepRunCount).toBe(20);
  });
});

describe("a loop that stops inside a loop that continues", () => {
  const ref = (step: string, path: string) => ({ ref: { step, path } });
  /** For each client, for each part: send. Then one step after the parts of that client. */
  const nested = (outer: Record<string, unknown>, inner: Record<string, unknown>) => {
    const definition = notifyClients(outer);
    const [trigger, clients, loop, result] = definition.steps;
    return {
      ...definition,
      steps: [
        trigger,
        clients,
        {
          ...loop,
          steps: [
            {
              id: "each_part",
              name: "For each part",
              type: "loop",
              items: { step: "clients", path: "clients" },
              itemLabel: "id",
              ...inner,
              steps: [
                {
                  id: "send",
                  name: "Send",
                  type: "operation",
                  operation: "connection.crm.write",
                  input: { client: ref("each_client", "id"), part: ref("each_part", "id") }
                }
              ]
            },
            {
              id: "after",
              name: "After the parts",
              type: "operation",
              operation: "connection.crm.write",
              input: { after: ref("each_client", "id") }
            }
          ]
        },
        result
      ]
    };
  };

  it("starts no further part, runs nothing after the stopped loop, and goes on with the next client", async () => {
    const definitions = publishedDefinitions();
    // One client at a time: with two, six parts stand for the four step jobs one process
    // runs at once, and which three go with the failed part is the order of the claim.
    definitions.publish(nested({ onItemFailure: "continue" }, { concurrency: 3 }));
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: definitions.source }
    );
    // The part `client-1` of the client `client-0` fails; every other call answers. It fails
    // once the two parts started with it have made their calls: a part whose call has not
    // begun when the loop stops is withdrawn, and which of the three comes first is the
    // machine's affair, not the engine's.
    let withIt = 0;
    t.setBehaviour(async (operation, input): Promise<JsonValue> => {
      if (operation === "echo") return { clients: CLIENTS };
      const text = JSON.stringify(input);
      if (!text.includes('"client":"client-0"') || !text.includes('"part":"')) {
        return { received: input };
      }
      if (!text.includes('"part":"client-1"')) {
        withIt += 1;
        return { received: input };
      }
      for (let waited = 0; withIt < 2 && waited < 30_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("The outside system is down");
    });
    const run = await t.finish((await start(t)).id, undefined, 600);

    // Each call by what it was for: `client/part`, or `after:client`.
    const made = z.object({
      client: z.string().optional(),
      part: z.string().optional(),
      after: z.string().optional()
    });
    const calls = writesOf(t).map((input) => {
      const call = made.parse(input);
      return call.after === undefined
        ? `${call.client ?? ""}/${call.part ?? ""}`
        : `after:${call.after}`;
    });
    const ofFirst = calls.filter((call) => call.startsWith("client-0/"));
    // The three parts that were going with the failed one made their calls: no fourth part,
    // and not the step after the parts.
    expect(ofFirst.sort()).toEqual(["client-0/client-0", "client-0/client-1", "client-0/client-2"]);
    expect(calls).not.toContain("after:client-0");
    // Every other client ran whole: eight parts and the step after them, each once.
    expect(calls).toHaveLength(3 + 7 * 9);
    expect(new Set(calls).size).toBe(calls.length);

    const stepRuns = await stepRunsOf(t, run.id);
    const first = stepRuns
      .filter((stepRun) => stepRun.key.startsWith("each_client[0]."))
      .map((stepRun) => [stepRun.key, stepRun.status])
      .sort();
    // A part that had its step run and no call yet was withdrawn, not run.
    expect(first.filter(([, status]) => status === "done" || status === "failed")).toEqual([
      ["each_client[0].each_part", "failed"],
      ["each_client[0].each_part[0].send", "done"],
      ["each_client[0].each_part[1].send", "failed"],
      ["each_client[0].each_part[2].send", "done"]
    ]);
    expect(first.every(([, status]) => status !== "queued" && status !== "running")).toBe(true);
    expect(first.map(([key]) => key)).not.toContain("each_client[0].after");

    // The outer loop counts that client as failed and the run ends done.
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 7, failed: 1 });
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")?.loop).toEqual({
      total: 8,
      done: 7,
      failed: 1,
      running: 0
    });
  }, 120_000);
});
