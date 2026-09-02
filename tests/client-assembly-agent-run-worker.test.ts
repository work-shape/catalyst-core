import { describe, expect, it } from "vitest";
import { readAgentRunWorkerConcurrency } from "../packages/client-assembly/src/agent-run-worker";

describe("client assembly agent run worker", () => {
  it("accepts only positive integer concurrency", () => {
    expect(readAgentRunWorkerConcurrency({})).toBeUndefined();
    expect(readAgentRunWorkerConcurrency({ AGENT_RUN_WORKER_CONCURRENCY: "2" })).toBe(2);
    for (const value of ["0", "-1", "1.5", "many"]) {
      expect(() => readAgentRunWorkerConcurrency({ AGENT_RUN_WORKER_CONCURRENCY: value })).toThrow(
        "AGENT_RUN_WORKER_CONCURRENCY must be a positive integer"
      );
    }
  });
});
