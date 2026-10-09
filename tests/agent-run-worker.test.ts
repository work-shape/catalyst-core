import type { PlatformStores } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { describe, expect, it, vi } from "vitest";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  type AgentRun,
  type AgentRunAuthorization,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { createStaticConfigAssetSource } from "@vivd-catalyst/core/testing";
import {
  AgentRunWorker,
  StoreBackedAgentRuntime,
  createWorkerLocalAgentRunExecutor
} from "@vivd-catalyst/agent-runtime";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("agent run worker", () => {
  it("lets only one competing worker claim a queued run", async () => {
    const fixture = await createQueuedRun("claim-race");
    const [first, second] = await Promise.all([
      fixture.store.agentRuns.claimNextAgentRun({
        clientInstanceId: fixture.clientInstanceId,
        workerId: "worker-a",
        leaseToken: "lease-a",
        now: "2026-09-02T12:00:00.000Z",
        leaseExpiresAt: "2026-09-02T12:10:00.000Z"
      }),
      fixture.store.agentRuns.claimNextAgentRun({
        clientInstanceId: fixture.clientInstanceId,
        workerId: "worker-b",
        leaseToken: "lease-b",
        now: "2026-09-02T12:00:00.000Z",
        leaseExpiresAt: "2026-09-02T12:10:00.000Z"
      })
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("extends a live lease and rejects writes from a stale token", async () => {
    const fixture = await createQueuedRun("lease-fence");
    const claimed = await claim(fixture, "current-token");
    const extendedLease = minutesFromNow(11);
    const heartbeat = await fixture.store.agentRuns.heartbeatAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "current-token",
      heartbeatAt: "2026-09-02T12:01:00.000Z",
      leaseExpiresAt: extendedLease
    });
    expect(heartbeat.leaseExpiresAt).toBe(extendedLease);

    await expect(
      fixture.store.agentRuns.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: claimed.id,
        leaseToken: "stale-token",
        event: completedEvent(claimed.id, 1, "2026-09-02T12:02:00.000Z")
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cancels queued work without executing and marks claimed work for cancellation", async () => {
    const queued = await createQueuedRun("queued-cancel");
    const cancelled = await queued.store.agentRuns.requestAgentRunCancellation({
      clientInstanceId: queued.clientInstanceId,
      runId: queued.run.id,
      requestedAt: "2026-09-02T12:01:00.000Z",
      reason: "No longer needed"
    });
    expect(cancelled).toMatchObject({ status: "cancelled", lastSequence: 1 });
    expect(
      await queued.store.agentRuns.claimNextAgentRun({
        clientInstanceId: queued.clientInstanceId,
        workerId: "worker",
        leaseToken: "unused",
        now: "2026-09-02T12:02:00.000Z",
        leaseExpiresAt: "2026-09-02T12:12:00.000Z"
      })
    ).toBeUndefined();

    const running = await createQueuedRun("running-cancel");
    await claim(running, "running-token");
    const cancelling = await running.store.agentRuns.requestAgentRunCancellation({
      clientInstanceId: running.clientInstanceId,
      runId: running.run.id,
      requestedAt: "2026-09-02T12:03:00.000Z",
      reason: "Stop"
    });
    expect(cancelling).toMatchObject({
      status: "cancelling",
      leaseToken: "running-token",
      cancellationReason: "Stop"
    });
    for (const event of [
      {
        type: "tool_permission_requested" as const,
        runId: running.run.id,
        sequence: 1,
        createdAt: "2026-09-02T12:04:00.000Z",
        toolCallId: "toolcall-cancel" as never,
        toolName: "tool",
        reason: "Approve"
      },
      completedEvent(running.run.id, 1, "2026-09-02T12:04:00.000Z"),
      {
        type: "run_failed" as const,
        runId: running.run.id,
        sequence: 1,
        createdAt: "2026-09-02T12:04:00.000Z",
        error: { code: "LATE", message: "Late failure", category: "internal_error" as const }
      }
    ]) {
      await expect(
        running.store.agentRuns.appendClaimedRunObservation({
          clientInstanceId: running.clientInstanceId,
          runId: running.run.id,
          leaseToken: "running-token",
          event
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    await running.store.agentRuns.appendClaimedRunObservation({
      clientInstanceId: running.clientInstanceId,
      runId: running.run.id,
      leaseToken: "running-token",
      event: {
        type: "run_cancelled",
        runId: running.run.id,
        sequence: 1,
        createdAt: "2026-09-02T12:04:00.000Z",
        reason: "Stop"
      }
    });
  });

  it("finishes cancellation when it races with a terminal worker event", async () => {
    const fixture = await createQueuedRun("cancellation-terminal-race");
    const appendObservation = fixture.store.agentRuns.appendClaimedRunObservation.bind(
      fixture.store.agentRuns
    );
    let cancellationInjected = false;
    vi.spyOn(fixture.store.agentRuns, "appendClaimedRunObservation").mockImplementation(
      async (input) => {
        if (!cancellationInjected && input.event.type !== "run_cancelled") {
          cancellationInjected = true;
          await fixture.store.agentRuns.requestAgentRunCancellation({
            clientInstanceId: fixture.clientInstanceId,
            runId: fixture.run.id,
            requestedAt: "2026-09-02T12:00:30.000Z",
            reason: "Stop during completion"
          });
        }
        return appendObservation(input);
      }
    );
    const worker = createWorker(fixture, async function* (input) {
      yield completedEvent(input.preparedRun!.id, 1, "2026-09-02T12:01:00.000Z");
    });

    const result = await worker.runOnce();

    expect(result.run).toMatchObject({
      status: "cancelled",
      cancellationReason: "Stop during completion"
    });
    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual(["run_cancelled"]);
  });

  it("recovers an expired lease once and never replays it", async () => {
    const fixture = await createQueuedRun("expired-lease");
    const claimed = await claim(fixture, "expired-token", "2026-09-02T12:01:00.000Z");
    const recoveryInput = {
      clientInstanceId: fixture.clientInstanceId,
      leaseExpiredBefore: "2026-09-02T12:02:00.000Z",
      recoveredAt: "2026-09-02T12:02:00.000Z",
      error: {
        code: "AGENT_RUN_RUNTIME_INTERRUPTED",
        message: "Worker disappeared",
        category: "runtime_interrupted" as const
      },
      limit: 10
    };
    const recovered = await fixture.store.agentRuns.recoverExpiredAgentRuns(recoveryInput);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: "failed", lastSequence: 1 });
    expect(await fixture.store.agentRuns.recoverExpiredAgentRuns(recoveryInput)).toEqual([]);
    await expect(
      fixture.store.agentRuns.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: claimed.id,
        leaseToken: "expired-token",
        event: completedEvent(claimed.id, 1, "2026-09-02T12:03:00.000Z")
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("resumes durable observation after a sequence cursor", async () => {
    const fixture = await createQueuedRun("observation-resume");
    const claimed = await claim(fixture, "observation-token");
    await fixture.store.agentRuns.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "observation-token",
      event: {
        type: "message_delta",
        runId: claimed.id,
        sequence: 1,
        createdAt: "2026-09-02T12:01:00.000Z",
        delta: "partial"
      }
    });
    await fixture.store.agentRuns.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "observation-token",
      event: completedEvent(claimed.id, 2, "2026-09-02T12:02:00.000Z")
    });
    const runtime = new StoreBackedAgentRuntime({
      store: fixture.store.agentRuns,
      pollIntervalMs: 1
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.observe(claimed.id, fixture.context, { afterSequence: 1 })) {
      events.push(event);
    }
    expect(events.map((event) => [event.type, event.sequence])).toEqual([["run_completed", 2]]);
  });

  it("lets another authorized viewer observe a run without ending it", async () => {
    const fixture = await createQueuedRun("observation-viewer");
    const claimed = await claim(fixture, "viewer-token");
    await fixture.store.agentRuns.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "viewer-token",
      event: completedEvent(claimed.id, 1, "2026-09-02T12:01:00.000Z")
    });
    const runtime = new StoreBackedAgentRuntime({
      store: fixture.store.agentRuns,
      pollIntervalMs: 1
    });
    const viewerContext: RuntimeCallContext = {
      ...fixture.context,
      user: { ...fixture.context.user, id: "user-viewer", externalUserId: "external-viewer" },
      subjectUserId: undefined
    };
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.observe(claimed.id, viewerContext)) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["run_completed"]);
  });

  it("dispatches the stored model binding and locale", async () => {
    const fixture = await createQueuedRun("dispatch-data", {
      modelBindingId: "binding-fast",
      locale: "de"
    });
    let seen: { modelBindingId?: string; locale?: string } | undefined;
    const worker = createWorker(fixture, async function* (input, context) {
      seen = { modelBindingId: input.modelBindingId, locale: context.locale };
      yield completedEvent(input.preparedRun!.id, 1, "2026-09-02T12:01:00.000Z");
    });
    await worker.runOnce();
    expect(seen).toEqual({ modelBindingId: "binding-fast", locale: "de" });
  });

  it("preserves the original scopes and delegated principal while loading the current user", async () => {
    const fixture = await createQueuedRun("dispatch-authorization", {
      authorization: {
        principal: {
          kind: "service",
          id: "service-1",
          displayLabel: "Automation",
          clientInstanceId: asClientInstanceId("worker-dispatch-authorization"),
          authSource: "api-key"
        },
        subjectUserId: "user-dispatch-authorization",
        delegatedActor: {
          kind: "service_principal",
          id: "service-1",
          displayLabel: "Automation",
          authSource: "api-key"
        },
        scopes: ["conversation:read"]
      }
    });
    fixture.user.scopes = ["*"];
    let seen: RuntimeCallContext | undefined;
    const worker = createWorker(fixture, async function* (input, context) {
      seen = context;
      yield completedEvent(input.preparedRun!.id, 1, "2026-09-02T12:01:00.000Z");
    });
    await worker.runOnce();
    expect(seen).toMatchObject({
      subjectUserId: fixture.user.id,
      scopes: ["conversation:read"],
      principal: { kind: "service", id: "service-1" },
      delegatedActor: { id: "service-1" },
      user: {
        scopes: ["conversation:read"],
        principal: { kind: "service", id: "service-1" },
        delegatedActor: { id: "service-1" }
      }
    });
  });

  it("fails closed when a queued run has no authorization projection", async () => {
    const fixture = await createQueuedRun("missing-authorization", { authorization: null });
    const worker = createWorker(fixture, async function* () {
      throw new Error("must not execute");
    });
    const result = await worker.runOnce();
    expect(result.run).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN", category: "app_error" }
    });
  });

  it("terminalizes permission requests instead of exposing an unresumable approval", async () => {
    const fixture = await createQueuedRun("permission-unsupported");
    const worker = createWorker(fixture, async function* (input) {
      yield {
        type: "tool_permission_requested",
        runId: input.preparedRun!.id,
        sequence: 1,
        createdAt: new Date().toISOString(),
        toolCallId: "toolcall-1" as never,
        toolName: "dangerous-tool",
        reason: "Approval required"
      };
    });
    const result = await worker.runOnce();
    expect(result.run).toMatchObject({
      status: "failed",
      error: { code: "AGENT_RUN_PERMISSION_UNSUPPORTED" }
    });
    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual(["run_failed"]);
  });

  it("writes one interrupted terminal event when a graceful stop aborts active work", async () => {
    const fixture = await createQueuedRun("graceful-stop");
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = createWorker(fixture, async function* (_input, context) {
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal!.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true }
        );
      });
    });
    const loop = worker.start();
    await executionStarted;
    await worker.stop({ interruptActive: true });
    await loop;

    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations).toMatchObject([
      {
        type: "run_failed",
        sequence: 1,
        payload: { error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED" } }
      }
    ]);
  });

  it("lets active work finish when a stop drains within the timeout", async () => {
    const fixture = await createQueuedRun("drain-completes");
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const worker = createWorker(fixture, async function* (input, context) {
      context.signal!.addEventListener("abort", () => (aborted = true), { once: true });
      started();
      await released;
      if (!aborted) yield completedEvent(input.preparedRun!.id, 1, new Date().toISOString());
    });
    const loop = worker.start();
    await executionStarted;
    const stopped = worker.stop({ drainTimeoutMs: 60_000 });
    release();
    await stopped;
    await loop;

    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual(["run_completed"]);
  });

  it("interrupts active work once the drain timeout elapses", async () => {
    const fixture = await createQueuedRun("drain-timeout");
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = createWorker(fixture, async function* (_input, context) {
      started();
      await new Promise<void>((_resolve, reject) => {
        context.signal!.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true }
        );
      });
    });
    const loop = worker.start();
    await executionStarted;
    await worker.stop({ drainTimeoutMs: 10 });
    await loop;

    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations).toMatchObject([
      {
        type: "run_failed",
        sequence: 1,
        payload: { error: { code: "AGENT_RUN_RUNTIME_INTERRUPTED" } }
      }
    ]);
  });

  it("fences a late worker after lease recovery so it cannot add a second terminal event", async () => {
    const fixture = await createQueuedRun("worker-loss");
    let now = "2026-09-02T12:00:00.000Z";
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker = createWorker(
      fixture,
      async function* (input) {
        started();
        await waiting;
        yield completedEvent(input.preparedRun!.id, 1, now);
      },
      { now: () => now, leaseDurationMs: 100, heartbeatIntervalMs: 10000 }
    );
    const running = worker.runOnce({ recoverExpired: false });
    await executionStarted;
    now = "2026-09-02T12:00:01.000Z";
    expect(await worker.recoverExpiredRuns()).toHaveLength(1);
    release();
    await running;

    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual(["run_failed"]);
  });

  it("runs the real Local Runtime with the worker as its only run-state writer", async () => {
    const fixture = await createQueuedRun("local-runtime");
    const updateStatus = vi.spyOn(fixture.store.agentRuns, "updateAgentRunStatus");
    const provider: ModelProviderConfig = {
      id: "worker-provider",
      type: "deterministic",
      model: "worker-model"
    };
    const execute = createWorkerLocalAgentRunExecutor({
      assetSource: createStaticConfigAssetSource({
        defaultAgentName: "test-agent",
        agents: [
          {
            name: "test-agent",
            displayName: "Test agent",
            instructions: "Answer briefly.",
            modelProviderId: provider.id,
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [provider],
      defaultModelProvider: provider,
      modelProvider: {
        id: provider.id,
        async complete() {
          return {
            text: "Done.",
            toolCalls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              source: "not_reported",
              webSearchCallCount: 0
            }
          };
        }
      },
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: {
        async authorize() {
          throw new Error("No tools expected");
        },
        async execute() {
          throw new Error("No tools expected");
        }
      },
      usageGovernance: new ModelUsageGovernance({
        store: fixture.store.usage,
        budget: {},
        safeguards: {}
      })
    });
    const worker = createWorker(fixture, execute);
    const result = await worker.runOnce();

    expect(result.run).toMatchObject({ status: "completed", lastSequence: 3 });
    expect(updateStatus).not.toHaveBeenCalled();
    const observations = await fixture.store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual([
      "message_delta",
      "message_completed",
      "run_completed"
    ]);
    const messages = await fixture.store.conversations.listMessages({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversationId
    });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });
});

interface Fixture {
  store: PlatformStores;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  run: AgentRun;
  user: AuthenticatedUser;
  context: RuntimeCallContext;
}

async function createQueuedRun(
  suffix: string,
  options: {
    modelBindingId?: string;
    locale?: "de";
    authorization?: AgentRunAuthorization | null;
  } = {}
): Promise<Fixture> {
  const store = (await createTestInstance()).stores;
  const clientInstanceId = asClientInstanceId(`worker-${suffix}`);
  const user: AuthenticatedUser = {
    id: `user-${suffix}`,
    externalUserId: `external-${suffix}`,
    displayLabel: "Worker Test User",
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  };
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: user.id,
    createdByExternalUserId: user.externalUserId,
    title: "Worker test",
    retainedUntil: "2027-09-02T00:00:00.000Z"
  });
  const inputMessageId = asMessageId(`msg-${suffix}`);
  await store.conversations.appendMessage({
    id: inputMessageId,
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "Do the work"
  });
  const run = await store.agentRuns.createAgentRun({
    id: asAgentRunId(`run-${suffix}`),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId,
    agentName: "test-agent",
    modelBindingId: options.modelBindingId,
    locale: options.locale,
    authorization:
      "authorization" in options
        ? (options.authorization ?? undefined)
        : {
            principal: {
              kind: "user",
              id: user.id,
              externalUserId: user.externalUserId,
              displayLabel: user.displayLabel,
              clientInstanceId,
              authSource: user.authSource
            },
            subjectUserId: user.id,
            scopes: ["run:start"]
          },
    status: "queued",
    correlationId: `corr-${suffix}`,
    startedAt: "2026-09-02T12:00:00.000Z"
  });
  const context: RuntimeCallContext = {
    user,
    clientInstanceId,
    correlationId: run.correlationId,
    locale: options.locale
  };
  return { store, clientInstanceId, conversationId: conversation.id, run, user, context };
}

function createWorker(
  fixture: Fixture,
  execute: ConstructorParameters<typeof AgentRunWorker>[0]["execute"],
  options: Partial<ConstructorParameters<typeof AgentRunWorker>[0]> = {}
): AgentRunWorker {
  return new AgentRunWorker({
    clientInstanceId: fixture.clientInstanceId,
    store: fixture.store.agentRuns,
    conversationHistory: fixture.store.conversations,
    loadCurrentUser: async () => fixture.user,
    execute,
    pollIntervalMs: 1,
    ...options
  });
}

/** The store measures a lease against the database clock, so a live lease ends after today. */
function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function claim(
  fixture: Fixture,
  leaseToken: string,
  leaseExpiresAt = minutesFromNow(10)
): Promise<AgentRun> {
  const run = await fixture.store.agentRuns.claimNextAgentRun({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "worker",
    leaseToken,
    now: "2026-09-02T12:00:00.000Z",
    leaseExpiresAt
  });
  if (!run) throw new AppError("INTERNAL", "Expected queued test run");
  return run;
}

function completedEvent(
  runId: AgentRun["id"],
  sequence: number,
  createdAt: string
): AgentRuntimeEvent {
  return { type: "run_completed", runId, sequence, createdAt };
}
