import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  OperationExecutionStop,
  createAuthorizer,
  createOperationRegistry,
  asAgentRunId,
  asConversationId,
  asToolCallId,
  type AuthenticatedUser,
  type OperationCall,
  type OperationCallRuntime,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import {
  createDecidedToolCallRunner,
  executeApprovedOperation,
  runOperation,
  type RunOperationDeps
} from "@work-shape/catalyst-tool-execution";
import {
  change,
  clientInstanceId,
  createServer,
  errorOf,
  person
} from "./support/operation-server";
import { registeredTestOperations as operations } from "./support/operations";
import { settleOnFakeClock, useFakeClockBesidePostgres } from "./support/fake-clock";

import { deferred } from "./support/assertions";

afterEach(() => vi.useRealTimers());

it.each([true, false])(
  "ends an over-long HTTP call before the sweep and replays its stored timeout (honours abort: %s)",
  async (honoursAbort) => {
    const timeoutMs = 5 * 60 * 1000;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let runtime: OperationCallRuntime | undefined;
    let dispatches = 0;
    const { server, runs, auditTypes } = await createServer({
      register: (route) =>
        route.operation(operations.testRunChange, {
          timeoutMs,
          execute: async (item, context) => {
            dispatches += 1;
            runtime = context.runtime;
            if (honoursAbort) runtime.signal?.addEventListener("abort", release, { once: true });
            entered();
            await held;
            return { name: item.name };
          }
        })
    });
    // Start the server before installing the clock; all database work under it is driven.
    await server.call("operations.list_runs", {}, person());
    useFakeClockBesidePostgres();
    const call = () => server.call("testRunChange", change("slow", "ok", "deadline"), person());
    const first = call();
    try {
      await settleOnFakeClock(started);
      const dispatchedAt = Date.now();
      await vi.advanceTimersByTimeAsync(timeoutMs + 123);
      const response = await settleOnFakeClock(first);
      const [stored] = await settleOnFakeClock(runs());
      expect(stored).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
      expect(response.statusCode).toBe(504);
      expect(errorOf(response)).toMatchObject(stored?.error ?? {});
      expect(response.headers["operation-run-id"]).toBe(stored?.id);
      expect(runtime?.signal?.aborted).toBe(true);
      expect(runtime?.signal?.reason).toBeInstanceOf(OperationExecutionStop);
      expect(runtime?.signal?.reason).toMatchObject({ kind: "timeout" });
      expect(runtime?.deadline?.getTime()).toBeLessThanOrEqual(dispatchedAt + timeoutMs);

      const replay = await settleOnFakeClock(call());
      expect(replay.statusCode).toBe(response.statusCode);
      expect(errorOf(replay)).toMatchObject(stored?.error ?? {});
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.headers["operation-run-id"]).toBe(stored?.id);
      expect(dispatches).toBe(1);

      // An implementation that ignores abort cannot replace the timeout with its late output.
      release();
      await settleOnFakeClock(held);
      expect(await settleOnFakeClock(runs())).toEqual([stored]);
      expect(await settleOnFakeClock(auditTypes(stored?.id ?? ""))).toEqual([
        "operation.authorization_checked:success",
        "operation.failed:failed",
        "operation.started:success"
      ]);
    } finally {
      release();
      await settleOnFakeClock(first);
    }
  }
);

it("answers the sweep's stored interruption when the deadline loses the terminal update", async () => {
  const entered = deferred<void>();
  const held = deferred<void>();
  const { server, runs } = await createServer({
    register: (route) =>
      route.operation(operations.testRunChange, {
        timeoutMs: 300_000,
        execute: async (item) => {
          entered.resolve();
          await held.promise;
          return { name: item.name };
        }
      })
  });
  await server.call("operations.list_runs", {}, person());
  useFakeClockBesidePostgres();
  const call = () => server.call("testRunChange", change("swept", "ok", "sweep-first"), person());
  const first = call();
  try {
    await settleOnFakeClock(entered.promise);
    const [running] = await settleOnFakeClock(runs());
    if (!running) throw new Error("Missing running call");
    const interrupted = await settleOnFakeClock(
      server.stores.operationRuns.markInterrupted({
        clientInstanceId,
        id: running.id
      })
    );
    expect(interrupted?.error?.code).toBe("interrupted");
    await vi.advanceTimersByTimeAsync(300_123);
    const response = await settleOnFakeClock(first);
    const replay = await settleOnFakeClock(call());
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)).toMatchObject({
      code: "OPERATION_IN_PROGRESS",
      details: { operationRunId: running.id, interrupted: true }
    });
    expect(errorOf(replay)).toMatchObject({
      code: errorOf(response).code,
      message: errorOf(response).message,
      details: errorOf(response).details
    });
    expect(replay.statusCode).toBe(response.statusCode);
    expect(await settleOnFakeClock(runs())).toEqual([interrupted]);
  } finally {
    held.resolve();
    await settleOnFakeClock(first);
  }
});

/** A direct non-HTTP caller using the same run store as an assembled instance. */
async function direct(execute: OperationDefinition["execute"], timeoutMs = 300_000) {
  const { server } = await createServer();
  const registry = createOperationRegistry();
  registry.register({
    name: "deadline.probe",
    effect: "changing",
    action: null,
    scope: null,
    auth: "user",
    authorize: () => ({ allowed: true }),
    resource: () => undefined,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    timeoutMs,
    execute
  });
  const actor: AuthenticatedUser = {
    id: "deadline-user",
    externalUserId: "deadline-user",
    displayLabel: "Deadline user",
    clientInstanceId,
    authSource: "test",
    roles: ["user"],
    permissionRefs: []
  };
  const deps: RunOperationDeps = {
    clientInstanceId,
    registry,
    runs: server.stores.operationRuns,
    authorizer: createAuthorizer(),
    events: { emit: async () => ({ outcome: "allow", guardrails: [] }) },
    audit: {
      record: async () => {
        throw new Error("Unexpected implementation audit");
      }
    },
    policy: {
      instanceDefaults: { reading: "allow", changing: "allow" },
      centralSettings: () => []
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      }
    }
  };
  const call: OperationCall = {
    operation: "deadline.probe",
    effect: "changing",
    input: {},
    actor,
    origin: { kind: "user" },
    correlationId: "deadline-probe",
    idempotencyKey: "direct-probe"
  };
  return {
    deps,
    actor,
    call,
    run: (runtime: OperationCallRuntime = {}) => runOperation(call, deps, runtime)
  };
}

it("persists timeout before aborting a connector that answers success on abort", async () => {
  const entered = deferred<void>();
  const finishing = deferred<void>();
  const persist = deferred<void>();
  const answered = deferred<void>();
  let signal: AbortSignal | undefined;
  let persisted = false;
  let persistedAtAbort: boolean | undefined;
  const f = await direct(async (_input, context) => {
    signal = context.runtime.signal;
    signal?.addEventListener(
      "abort",
      () => {
        persistedAtAbort = persisted;
        answered.resolve();
      },
      { once: true }
    );
    entered.resolve();
    await answered.promise;
    return { success: true };
  });
  const finish = f.deps.runs.finish.bind(f.deps.runs);
  vi.spyOn(f.deps.runs, "finish").mockImplementation(async (input) => {
    finishing.resolve();
    await persist.promise;
    const result = await finish(input);
    persisted = true;
    return result;
  });
  useFakeClockBesidePostgres();
  const first = f.run();
  try {
    await settleOnFakeClock(entered.promise);
    await vi.advanceTimersByTimeAsync(300_123);
    await settleOnFakeClock(finishing.promise);
    expect(signal?.aborted).toBe(false);
    persist.resolve();
    const outcome = await settleOnFakeClock(first);
    await settleOnFakeClock(answered.promise);
    expect(persistedAtAbort).toBe(true);
    expect(outcome.run).toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
    expect(
      await settleOnFakeClock(f.deps.runs.get({ clientInstanceId, id: outcome.run.id }))
    ).toEqual(outcome.run);
  } finally {
    persist.resolve();
    answered.resolve();
    await settleOnFakeClock(first);
  }
});

it.each(["en", "de"] as const)("names the effective timeout limit in %s", async (locale) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await direct(async () => {
    entered.resolve();
    await release.promise;
    return {};
  });
  useFakeClockBesidePostgres();
  const deadline = new Date(Date.now() + 120_000);
  const first = f.run({ deadline, locale });
  try {
    await settleOnFakeClock(entered.promise);
    await vi.advanceTimersByTimeAsync(120_123);
    const result = await settleOnFakeClock(first);
    expect(result.result).toMatchObject({
      status: "failed",
      error: {
        code: "TIMEOUT",
        message:
          locale === "de"
            ? `'deadline.probe' hat die Grenze runtime.deadline (${deadline.toISOString()}) erreicht`
            : `'deadline.probe' reached the limit runtime.deadline (${deadline.toISOString()})`
      }
    });
  } finally {
    release.resolve();
    await settleOnFakeClock(first);
  }
});

it.each(["en", "de"] as const)(
  "never dispatches after admission consumes definition.timeoutMs (%s)",
  async (locale) => {
    const execute = vi.fn(async () => ({}));
    const f = await direct(execute);
    useFakeClockBesidePostgres();
    f.deps.policy.centralSettings = async () => {
      await vi.advanceTimersByTimeAsync(300_123);
      return [];
    };
    const outcome = await settleOnFakeClock(f.run({ locale }));
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.run).toMatchObject({
      status: "failed",
      error: {
        code: "TIMEOUT",
        unexecuted: true,
        message:
          locale === "de"
            ? "'deadline.probe' hat die Grenze definition.timeoutMs (300000 ms) erreicht"
            : "'deadline.probe' reached the limit definition.timeoutMs (300000 ms)"
      }
    });
  }
);

it.each(["deadline", "exact-deadline", "abort"] as const)(
  "never dispatches when %s arrives during admission",
  async (stop) => {
    const execute = vi.fn(async () => ({}));
    const f = await direct(execute);
    const controller = new AbortController();
    useFakeClockBesidePostgres();
    const deadline = new Date(Date.now() + 120_000);
    if (stop === "exact-deadline") f.deps.now = () => deadline;
    f.deps.policy.centralSettings = async () => {
      if (stop === "abort") controller.abort();
      else if (stop === "deadline") await vi.advanceTimersByTimeAsync(120_123);
      return [];
    };
    const outcome = await settleOnFakeClock(f.run({ deadline, signal: controller.signal }));
    expect(execute).not.toHaveBeenCalled();
    expect(outcome.run.error?.unexecuted).toBe(true);
    expect(outcome.run.error?.message).toContain(
      stop === "abort" ? "runtime.signal" : "runtime.deadline"
    );
    expect(outcome.run.error?.code).not.toBe("interrupted");
  }
);

it("keeps the check-before-calling-again warning for direct and resumed tool interruptions", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await direct(async () => {
    entered.resolve();
    await release.promise;
    return {};
  });
  const origin = {
    kind: "agent",
    agentName: "probe",
    toolName: f.call.operation,
    agentRunId: asAgentRunId("probe-run"),
    conversationId: asConversationId("probe-conversation"),
    toolCallId: asToolCallId("probe-call")
  } as const;
  f.call.origin = origin;
  f.deps.agentToolNames = () => [f.call.operation];
  const controller = new AbortController();
  const first = f.run({ signal: controller.signal });
  try {
    await entered.promise;
    controller.abort();
    const outcome = await first;
    expect(outcome.run.error?.code).toBe("interrupted");
    const { toolResultFromOperationResult } = await import("@work-shape/catalyst-tool-execution");
    const names = {
      toolName: f.call.operation,
      agentName: "probe",
      correlationId: f.call.correlationId
    };
    expect(toolResultFromOperationResult(outcome, names)).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("check before calling again")
      }
    });
    f.deps.approvedToolCall = async () => ({
      execution: "interrupted",
      run: outcome.run,
      outcome,
      error: outcome.run.error ?? { code: "interrupted", message: "Interrupted" }
    });
    // The resumed path can carry an outcome and must still preserve the warning.
    vi.spyOn(f.deps.runs, "get").mockResolvedValue({
      ...outcome.run,
      status: "pending_approval",
      decision: { mode: "approved", by: f.actor.id, at: new Date().toISOString() }
    });
    const decided = createDecidedToolCallRunner(f.deps);
    expect(
      await decided(
        {
          request: { ...origin, input: {} },
          operationRunId: outcome.run.id,
          frozenInput: {}
        },
        { user: f.actor, clientInstanceId, correlationId: "probe" }
      )
    ).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("check before calling again")
      }
    });
  } finally {
    release.resolve();
    await first;
  }
});

it("records an abort during the approved run claim as unexecuted", async () => {
  const execute = vi.fn(async () => ({}));
  const f = await direct(execute);
  f.deps.policy.instanceDefaults.changing = "approval";
  f.deps.approvals = { request: async () => ({ approvalRequestId: "deadline-approval" }) };
  const waiting = await f.run();
  expect(waiting.run.status).toBe("pending_approval");
  const controller = new AbortController();
  const resume = f.deps.runs.resume.bind(f.deps.runs);
  vi.spyOn(f.deps.runs, "resume").mockImplementation(async (input) => {
    const run = await resume(input);
    controller.abort();
    return run;
  });
  const ended = await executeApprovedOperation(
    { runId: waiting.run.id, call: f.call },
    { id: f.actor.id, label: f.actor.displayLabel, at: new Date().toISOString() },
    f.deps,
    { signal: controller.signal }
  );
  expect(execute).not.toHaveBeenCalled();
  expect(ended).toMatchObject({
    execution: "failed",
    run: {
      status: "failed",
      error: {
        code: "CONFLICT",
        unexecuted: true,
        message: expect.stringContaining("runtime.signal")
      }
    }
  });
});
