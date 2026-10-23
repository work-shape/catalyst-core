import { expect, it } from "vitest";
import { memoryWorkflowEngine } from "./support/workflow-memory-engine";

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
