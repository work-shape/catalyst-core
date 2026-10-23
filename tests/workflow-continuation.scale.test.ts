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
  // A notice built from a dataset row keeps no input preview, which would outlive the row.
  expect([...fixture.stepInputs.values()]).toEqual([{ text: "{}", truncated: false }]);
  expect(reads.mock.calls.length).toBe(3); // One bounded immutable part per history.
});
