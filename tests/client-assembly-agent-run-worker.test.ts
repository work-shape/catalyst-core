import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS,
  readAgentRunWorkerConcurrency,
  readAgentRunWorkerDrainTimeoutMs
} from "../packages/client-assembly/src/agent-run-worker";

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

  it("defaults the drain timeout and accepts only non-negative integers", () => {
    expect(readAgentRunWorkerDrainTimeoutMs({})).toBe(DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS);
    expect(readAgentRunWorkerDrainTimeoutMs({ AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS: "0" })).toBe(0);
    expect(readAgentRunWorkerDrainTimeoutMs({ AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS: "20000" })).toBe(
      20000
    );
    for (const value of ["-1", "1.5", "soon"]) {
      expect(() =>
        readAgentRunWorkerDrainTimeoutMs({ AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS: value })
      ).toThrow("AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS must be a non-negative integer");
    }
  });
});
