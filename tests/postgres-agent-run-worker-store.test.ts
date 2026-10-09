import { type TestPostgresStore, createTestInstance } from "./support/test-instance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asMessageId,
  type AgentRun,
  type ClientInstanceId
} from "@vivd-catalyst/core";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres agent run worker store", () => {
  let store: TestPostgresStore;
  let secondStore: TestPostgresStore;

  beforeAll(async () => {
    store = (
      await createTestInstance({ postgres: { databaseUrl: databaseUrl!, runMigrations: true } })
    ).stores;
    secondStore = (
      await createTestInstance({
        postgres: {
          databaseUrl: databaseUrl!,
          runMigrations: false
        }
      })
    ).stores;
  });

  afterAll(async () => {
    await secondStore?.close();
    await store?.close();
  });

  it("claims a queued run once across separate connections", async () => {
    const fixture = await createQueuedRun(store);
    const [first, second] = await Promise.all([
      store.claimNextAgentRun(claimInput(fixture, "worker-a", "lease-a")),
      secondStore.claimNextAgentRun(claimInput(fixture, "worker-b", "lease-b"))
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].find(Boolean)).toMatchObject({
      id: fixture.run.id,
      status: "running"
    });
  });

  it("fences observation and terminal writes by lease token", async () => {
    const fixture = await createQueuedRun(store);
    const claimed = await store.claimNextAgentRun(claimInput(fixture, "worker-a", "current-token"));
    expect(claimed).toBeDefined();
    await expect(
      secondStore.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: fixture.run.id,
        leaseToken: "stale-token",
        event: {
          type: "run_completed",
          runId: fixture.run.id,
          sequence: 1,
          createdAt: "2026-09-02T12:01:00.000Z"
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await store.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id,
      leaseToken: "current-token",
      event: {
        type: "run_completed",
        runId: fixture.run.id,
        sequence: 1,
        createdAt: "2026-09-02T12:01:00.000Z"
      }
    });
    await expect(
      secondStore.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: fixture.run.id,
        leaseToken: "current-token",
        event: {
          type: "run_failed",
          runId: fixture.run.id,
          sequence: 2,
          createdAt: "2026-09-02T12:02:00.000Z",
          error: { code: "LATE", message: "Late worker", category: "internal_error" }
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("terminalizes an expired lease once", async () => {
    const fixture = await createQueuedRun(store);
    await store.claimNextAgentRun(
      claimInput(fixture, "worker-a", "expired-token", "2026-09-02T12:00:01.000Z")
    );
    const input = {
      clientInstanceId: fixture.clientInstanceId,
      leaseExpiredBefore: "2026-09-02T12:01:00.000Z",
      recoveredAt: "2026-09-02T12:01:00.000Z",
      error: {
        code: "AGENT_RUN_RUNTIME_INTERRUPTED",
        message: "Lease expired",
        category: "runtime_interrupted" as const
      },
      limit: 10
    };
    expect(await store.recoverExpiredAgentRuns(input)).toHaveLength(1);
    expect(await secondStore.recoverExpiredAgentRuns(input)).toEqual([]);
    await expect(
      store.listRunObservations({
        clientInstanceId: fixture.clientInstanceId,
        runId: fixture.run.id
      })
    ).resolves.toMatchObject([
      { type: "run_failed", sequence: 1, payload: { error: { category: "runtime_interrupted" } } }
    ]);
  });

  it("keeps cancellation monotonic against late permission and completion writes", async () => {
    const fixture = await createQueuedRun(store);
    await store.claimNextAgentRun(claimInput(fixture, "worker-a", "cancel-token"));
    await secondStore.requestAgentRunCancellation({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id,
      requestedAt: new Date().toISOString(),
      reason: "Stop"
    });
    const createdAt = new Date().toISOString();
    await expect(
      store.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: fixture.run.id,
        leaseToken: "cancel-token",
        event: {
          type: "tool_permission_requested",
          runId: fixture.run.id,
          sequence: 1,
          createdAt,
          toolCallId: "toolcall-cancel" as never,
          toolName: "tool",
          reason: "Approve"
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      store.appendClaimedRunObservation({
        clientInstanceId: fixture.clientInstanceId,
        runId: fixture.run.id,
        leaseToken: "cancel-token",
        event: {
          type: "run_completed",
          runId: fixture.run.id,
          sequence: 1,
          createdAt
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await store.appendClaimedRunObservation({
      clientInstanceId: fixture.clientInstanceId,
      runId: fixture.run.id,
      leaseToken: "cancel-token",
      event: {
        type: "run_cancelled",
        runId: fixture.run.id,
        sequence: 1,
        createdAt,
        reason: "Stop"
      }
    });
    await expect(
      store.getAgentRun({ clientInstanceId: fixture.clientInstanceId, runId: fixture.run.id })
    ).resolves.toMatchObject({ status: "cancelled", lastSequence: 1 });
  });
});

async function createQueuedRun(store: TestPostgresStore): Promise<{
  clientInstanceId: ClientInstanceId;
  run: AgentRun;
}> {
  const id = globalThis.crypto.randomUUID();
  const clientInstanceId = asClientInstanceId(`agent-worker-${id}`);
  const user = await store.createUser({ clientInstanceId, displayLabel: "Agent worker owner" });
  const workspace = await store.ensurePersonalWorkspace({ clientInstanceId, userId: user.id });
  const conversation = await store.createConversation({
    visibility: "workspace",
    clientInstanceId,
    collaborationWorkspaceId: workspace.id,
    createdByUserId: user.id,
    createdByExternalUserId: `external-${id}`,
    title: "Agent worker test",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const inputMessageId = asMessageId(`msg-${id}`);
  await store.appendMessage({
    id: inputMessageId,
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "Run it"
  });
  const run = await store.createAgentRun({
    id: asAgentRunId(`run-${id}`),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId,
    agentName: "worker-test",
    modelBindingId: "binding-test",
    locale: "de",
    authorization: {
      principal: {
        kind: "user",
        id: user.id,
        externalUserId: `external-${id}`,
        displayLabel: user.displayLabel,
        clientInstanceId,
        authSource: "test"
      },
      subjectUserId: user.id,
      scopes: ["run:start"]
    },
    status: "queued",
    correlationId: `corr-${id}`,
    startedAt: "2026-09-02T12:00:00.000Z"
  });
  return { clientInstanceId, run };
}

function claimInput(
  fixture: { clientInstanceId: ClientInstanceId },
  workerId: string,
  leaseToken: string,
  leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
) {
  return {
    clientInstanceId: fixture.clientInstanceId,
    workerId,
    leaseToken,
    now: new Date().toISOString(),
    leaseExpiresAt
  };
}
