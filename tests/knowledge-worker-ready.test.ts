import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CreateClientInstanceKnowledgeWorkerInput,
  runClientInstanceKnowledgeWorker
} from "@work-shape/catalyst-client-assembly";
import { JOB_WORKER_SILENT_MS, KNOWLEDGE_JOB_KINDS } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";

const probe = vi.hoisted(() => ({
  activity: vi.fn<() => Promise<{ report?: { seenAt: string } }>>(),
  enabled: vi.fn(() => true),
  close: vi.fn(),
  stop: vi.fn(),
  start: vi.fn()
}));

// Keep this a test of the public --check-ready entrypoint, including its cleanup,
// without opening a pool or waiting a real minute for the readiness deadline.
vi.mock("../packages/client-assembly/src/app", () => ({
  createClientInstanceExecutionAssembly: async () => ({
    clientInstanceId: "readiness-test",
    operationCalls: { registry: {} },
    modulesStarted: { routes: [], jobHandlers: [], schedules: [] },
    modules: { isEnabled: probe.enabled },
    store: { jobs: { readKindActivity: probe.activity } },
    logger: { info: vi.fn() },
    close: probe.close
  })
}));
vi.mock("../packages/client-assembly/src/job-worker", () => ({
  createJobWorker: () => ({ stop: probe.stop, start: probe.start })
}));

const input: CreateClientInstanceKnowledgeWorkerInput = {
  config: createTestConfig(),
  env: {},
  tools: [],
  capabilities: [],
  knowledgeWorker: "separate"
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function checkReady() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  vi.stubGlobal("process", { ...process, argv: ["node", "knowledge-worker.js", "--check-ready"] });
  probe.enabled.mockReturnValue(true);
  return runClientInstanceKnowledgeWorker(input);
}

describe("knowledge worker rollout heartbeat gate", () => {
  it.each([JOB_WORKER_SILENT_MS + 1, 1])(
    "fails when the heartbeat stays %i ms older than the rollout check",
    async (age) => {
      probe.activity.mockImplementation(async () => ({
        report: { seenAt: new Date(Date.parse("2026-10-17T12:00:00Z") - age).toISOString() }
      }));
      const result = checkReady().then(
        () => undefined,
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await result).toMatchObject({
        message: "The new knowledge worker did not report knowledge_base.index within 60 seconds"
      });
      expect(probe.activity).toHaveBeenCalledWith({
        clientInstanceId: "readiness-test",
        kind: KNOWLEDGE_JOB_KINDS.index
      });
      expect(probe.start).not.toHaveBeenCalled();
      expect(probe.stop).toHaveBeenCalledOnce();
      expect(probe.close).toHaveBeenCalledOnce();
    }
  );

  it("keeps waiting on a stale heartbeat and passes after a fresh one arrives", async () => {
    probe.activity.mockResolvedValueOnce({
      report: { seenAt: "2026-10-17T11:00:00Z" }
    });
    probe.activity.mockImplementation(async () => ({
      report: { seenAt: new Date().toISOString() }
    }));
    const result = checkReady();
    const completed = vi.fn();
    const observed = result.then(completed);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.activity).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    await observed;
    expect(completed).toHaveBeenCalledOnce();
    expect(probe.activity).toHaveBeenCalledTimes(2);
    expect(probe.start).not.toHaveBeenCalled();
    expect(probe.close).toHaveBeenCalledOnce();
  });
});
