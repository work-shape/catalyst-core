import { expect, it, vi } from "vitest";
import { memoryWorkflowEngine } from "./support/workflow-memory-engine";

// Full-size engine semantics against strict product-owned store/job ports. The companion
// Postgres tests prove the atomic/persistent boundary with a smaller dataset, without making
// the suite send fifty thousand outside calls or measure database throughput by accident.
it("check 112: processes a 50,000-row dataset at 20,000 step runs as one three-part Lauf, without skipped or repeated rows", async () => {
  const fixture = await memoryWorkflowEngine(50_000);
  const reads = vi.spyOn(fixture.objects, "get");
  const chain = (await fixture.execute()).sort(
    (a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1)
  );
  expect(chain.map((run) => run.status)).toEqual(["continued", "continued", "done"]);
  expect(chain.map((run) => run.stepRunCount)).toEqual([19_999, 19_999, 10_009]);
  expect(chain.reduce((sum, run) => sum + run.stepRunCount, 0)).toBe(50_007); // trigger + loop per history, final output.
  expect(chain.map((run) => `${run.runKey}/${run.continuation?.number}`)).toEqual([
    "2026-10-18/1",
    "2026-10-18/2",
    "2026-10-18/3"
  ]);
  expect(chain.map((run) => run.definitionRevisionId)).toEqual([
    "published-1",
    "published-2",
    "published-2"
  ]);
  expect(chain.every((run) => run.labels?.customer === "Acme")).toBe(true);
  for (let part = 1; part < chain.length; part++) {
    const before = chain[part - 1],
      after = chain[part];
    if (!before?.finishedAt || !after) throw new Error("Missing continued history");
    expect(Date.parse(after.createdAt) - Date.parse(before.finishedAt)).toBeLessThan(60_000);
    expect(before.continuation?.successorRunId).toBe(after.id);
    expect(after.continuation?.previousRunId).toBe(before.id);
    expect(fixture.inputs.get(after.id)?.offset).toBe(part * 19_997);
  }
  expect(fixture.seen.size).toBe(50_000);
  expect(reads.mock.calls.length).toBe(3); // One bounded immutable part per history.
});

it.each(
  [1, 3, 8].flatMap((concurrency) => [6, 8, 10, 12, 16].map((budget) => ({ concurrency, budget })))
)(
  "drains nested items exactly once with outer concurrency $concurrency and budget $budget",
  async ({ concurrency, budget }) => {
    const fixture = await memoryWorkflowEngine(3, {
      manifest: (manifest) => ({
        ...manifest,
        limits: { stepRuns: budget },
        steps: manifest.steps.map((step) =>
          step.type !== "loop"
            ? step
            : {
                ...step,
                concurrency,
                steps: [
                  {
                    id: "before",
                    name: "Before",
                    type: "notify",
                    to: { users: ["scale-owner"] },
                    channels: ["inbox"],
                    title: { value: "before" },
                    text: { ref: { step: "each", path: "id" } }
                  },
                  {
                    id: "inner",
                    name: "Inner",
                    type: "loop",
                    items: { step: "start", path: "input.rows" },
                    steps: [
                      {
                        id: "pair",
                        name: "Pair",
                        type: "notify",
                        to: { users: ["scale-owner"] },
                        channels: ["inbox"],
                        title: { ref: { step: "each", path: "id" } },
                        text: { ref: { step: "inner", path: "id" } }
                      }
                    ]
                  }
                ]
              }
        )
      })
    });
    const chain = await fixture.execute();
    expect(chain.at(-1)?.status).toBe("done");
    expect(chain.every((run) => run.status === "continued" || run.status === "done")).toBe(true);
    expect(fixture.seen).toEqual(
      new Set([
        "before:0",
        "before:1",
        "before:2",
        "0:0",
        "0:1",
        "0:2",
        "1:0",
        "1:1",
        "1:2",
        "2:0",
        "2:1",
        "2:2"
      ])
    );
  }
);
