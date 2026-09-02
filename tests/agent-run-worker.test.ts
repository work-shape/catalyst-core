import { describe, expect, it } from "vitest";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  type AgentRun,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationId,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { AgentRunWorker, StoreBackedAgentRuntime } from "@vivd-catalyst/agent-runtime";

describe("agent run worker", () => {
  it("lets only one competing worker claim a queued run", async () => {
    const fixture = await createQueuedRun("claim-race");
    const [first, second] = await Promise.all([
      fixture.store.claimNextAgentRun({
        clientInstanceId: fixture.clientInstanceId,
        workerId: "worker-a",
        leaseToken: "lease-a",
        now: "2026-09-02T12:00:00.000Z",
        leaseExpiresAt: "2026-09-02T12:10:00.000Z"
      }),
      fixture.store.claimNextAgentRun({
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
    const heartbeat = await fixture.store.heartbeatAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "current-token",
      heartbeatAt: "2026-09-02T12:01:00.000Z",
      leaseExpiresAt: "2026-09-02T12:11:00.000Z"
    });
    expect(heartbeat.leaseExpiresAt).toBe("2026-09-02T12:11:00.000Z");

    await expect(
      fixture.store.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: claimed.id,
        leaseToken: "stale-token",
        event: completedEvent(claimed.id, 1, "2026-09-02T12:02:00.000Z")
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cancels queued work without executing and marks claimed work for cancellation", async () => {
    const queued = await createQueuedRun("queued-cancel");
    const cancelled = await queued.store.requestAgentRunCancellation({
      clientInstanceId: queued.clientInstanceId,
      runId: queued.run.id,
      requestedAt: "2026-09-02T12:01:00.000Z",
      reason: "No longer needed"
    });
    expect(cancelled).toMatchObject({ status: "cancelled", lastSequence: 1 });
    expect(
      await queued.store.claimNextAgentRun({
        clientInstanceId: queued.clientInstanceId,
        workerId: "worker",
        leaseToken: "unused",
        now: "2026-09-02T12:02:00.000Z",
        leaseExpiresAt: "2026-09-02T12:12:00.000Z"
      })
    ).toBeUndefined();

    const running = await createQueuedRun("running-cancel");
    await claim(running, "running-token");
    const cancelling = await running.store.requestAgentRunCancellation({
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
    const recovered = await fixture.store.recoverExpiredAgentRuns(recoveryInput);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: "failed", lastSequence: 1 });
    expect(await fixture.store.recoverExpiredAgentRuns(recoveryInput)).toEqual([]);
    await expect(
      fixture.store.appendClaimedRunObservation({
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
    await fixture.store.appendClaimedRunObservation({
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
    await fixture.store.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: claimed.id,
      leaseToken: "observation-token",
      event: completedEvent(claimed.id, 2, "2026-09-02T12:02:00.000Z")
    });
    const runtime = new StoreBackedAgentRuntime({ store: fixture.store, pollIntervalMs: 1 });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.observe(claimed.id, fixture.context, { afterSequence: 1 })) {
      events.push(event);
    }
    expect(events.map((event) => [event.type, event.sequence])).toEqual([["run_completed", 2]]);
  });

  it("dispatches the stored model binding and locale", async () => {
    const fixture = await createQueuedRun("dispatch-data", {
      modelBindingId: "binding-fast",
      locale: "de-DE"
    });
    let seen: { modelBindingId?: string; locale?: string } | undefined;
    const worker = createWorker(fixture, async function* (input, context) {
      seen = { modelBindingId: input.modelBindingId, locale: context.locale };
      yield completedEvent(input.preparedRun!.id, 1, "2026-09-02T12:01:00.000Z");
    });
    await worker.runOnce();
    expect(seen).toEqual({ modelBindingId: "binding-fast", locale: "de-DE" });
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

    const observations = await fixture.store.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual(["run_failed"]);
  });
});

interface Fixture {
  store: InMemoryPlatformStore;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  run: AgentRun;
  user: AuthenticatedUser;
  context: RuntimeCallContext;
}

async function createQueuedRun(
  suffix: string,
  options: { modelBindingId?: string; locale?: "de-DE" } = {}
): Promise<Fixture> {
  const store = new InMemoryPlatformStore();
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
  await store.appendMessage({
    id: inputMessageId,
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "Do the work"
  });
  const run = await store.createAgentRun({
    id: asAgentRunId(`run-${suffix}`),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId,
    agentName: "test-agent",
    modelBindingId: options.modelBindingId,
    locale: options.locale,
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
  execute: (
    input: Parameters<ConstructorParameters<typeof AgentRunWorker>[0]["execute"]>[0],
    context: RuntimeCallContext
  ) => AsyncIterable<AgentRuntimeEvent>,
  options: Partial<ConstructorParameters<typeof AgentRunWorker>[0]> = {}
): AgentRunWorker {
  return new AgentRunWorker({
    clientInstanceId: fixture.clientInstanceId,
    store: fixture.store,
    conversationHistory: fixture.store,
    loadCurrentUser: async () => fixture.user,
    execute,
    pollIntervalMs: 1,
    ...options
  });
}

async function claim(
  fixture: Fixture,
  leaseToken: string,
  leaseExpiresAt = "2026-09-02T12:10:00.000Z"
): Promise<AgentRun> {
  const run = await fixture.store.claimNextAgentRun({
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
