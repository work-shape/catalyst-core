import { describe, expect, it } from "vitest";
import { RunRecoveryWatchdog } from "@vivd-catalyst/chat-server";
import {
  createStaleRunRecoveryFixture,
  createPersistedRecoveryRun,
  expectRunStatus,
  parseSseChunks
} from "./chat-server-run-harness";
import { personalConversationListUrl } from "./chat-server-harness";

describe("client instance app vertical slice", () => {
  it("recovers a stale durable active run in thread snapshots without duplicate terminal observations", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;

    const snapshot = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/thread`
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      activeRun: {
        run: {
          id: run.id,
          status: "failed",
          lastSequence: 2
        },
        projection: {
          runId: run.id,
          status: "failed",
          lastSequence: 2,
          text: "before restart",
          error: {
            code: "AGENT_RUN_RUNTIME_INTERRUPTED",
            category: "runtime_interrupted"
          }
        }
      }
    });

    await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/thread`
    });
    const observations = await store.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      ownerUserId: fixture.owner.id
    });
    expect(observations.map((observation) => observation.type)).toEqual([
      "message_delta",
      "run_failed"
    ]);
    expect(observations.map((observation) => observation.sequence)).toEqual([1, 2]);

    await server.close();
  });

  it("recovers stale durable active runs while listing conversations", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;

    const listed = await server.inject({
      method: "GET",
      url: await personalConversationListUrl(server)
    });
    expect(listed.statusCode).toBe(200);
    const listedConversation = (listed.json() as Array<{ id: string; activeRun?: unknown }>).find(
      (item) => item.id === conversation.id
    );
    expect(listedConversation).toBeDefined();
    expect(listedConversation).not.toHaveProperty("activeRun");

    const recoveredRun = await store.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(recoveredRun).toMatchObject({
      status: "failed",
      lastSequence: 2,
      error: {
        code: "AGENT_RUN_RUNTIME_INTERRUPTED",
        category: "runtime_interrupted"
      }
    });

    await server.close();
  });

  it("recovers a stale durable active run for observation cursors after the last pre-crash sequence", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;

    const events = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/runs/${run.id}/events?after=1`
    });
    expect(events.statusCode).toBe(200);
    const chunks = parseSseChunks(events.payload);
    expect(chunks).toEqual([
      expect.objectContaining({
        type: "run_failed",
        sequence: 2,
        runId: run.id,
        conversationId: conversation.id
      })
    ]);

    const recoveredRun = await store.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(recoveredRun).toMatchObject({
      status: "failed",
      lastSequence: 2,
      error: {
        code: "AGENT_RUN_RUNTIME_INTERRUPTED",
        category: "runtime_interrupted"
      }
    });

    const replay = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/runs/${run.id}/events?after=1`
    });
    expect(replay.statusCode).toBe(200);
    expect(parseSseChunks(replay.payload)).toEqual([
      expect.objectContaining({
        type: "run_failed",
        sequence: 2
      })
    ]);

    await server.close();
  });

  it("recovers a fresh durable active run when local runtime observation state is missing", async () => {
    const fixture = await createStaleRunRecoveryFixture({
      staleActiveRunMs: 60 * 60 * 1000
    });
    const { server, store, conversation, run } = fixture;
    await store.updateAgentRunStatus({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      status: "running",
      updatedAt: new Date().toISOString(),
      lastSequence: 1
    });

    const events = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/runs/${run.id}/events?after=1`
    });
    expect(events.statusCode).toBe(200);
    expect(parseSseChunks(events.payload)).toEqual([
      expect.objectContaining({
        type: "run_failed",
        sequence: 2,
        runId: run.id,
        conversationId: conversation.id,
        payload: expect.objectContaining({
          error: expect.objectContaining({
            code: "AGENT_RUN_RUNTIME_INTERRUPTED",
            category: "runtime_interrupted"
          })
        })
      })
    ]);

    await expectRunStatus(store, fixture.clientInstanceId, run.id, "failed");
    await server.close();
  });

  it("recovers a fresh durable active run when cancellation finds missing local runtime state", async () => {
    const fixture = await createStaleRunRecoveryFixture({
      staleActiveRunMs: 60 * 60 * 1000
    });
    const { server, store, conversation, run } = fixture;
    await store.updateAgentRunStatus({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      status: "running",
      updatedAt: new Date().toISOString(),
      lastSequence: 1
    });

    const cancelled = await server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/runs/${run.id}/cancel`,
      payload: { reason: "User stopped a missing local run" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      run: {
        id: run.id,
        status: "failed",
        lastSequence: 2,
        error: {
          code: "AGENT_RUN_RUNTIME_INTERRUPTED",
          category: "runtime_interrupted"
        }
      }
    });

    const replay = await store.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      ownerUserId: fixture.owner.id
    });
    expect(replay.map((observation) => observation.type)).toEqual(["message_delta", "run_failed"]);
    await server.close();
  });

  it("does not disclose or mutate another user's stale durable run during recovery-visible reads", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;

    const wrongOwnerEvents = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/runs/${run.id}/events?after=1`,
      headers: {
        "x-test-user": "other-user"
      }
    });
    expect(wrongOwnerEvents.statusCode).toBe(404);

    const wrongOwnerSnapshot = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/thread`,
      headers: {
        "x-test-user": "other-user"
      }
    });
    expect(wrongOwnerSnapshot.statusCode).toBe(404);

    const unchangedRun = await store.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(unchangedRun).toMatchObject({
      status: "running",
      lastSequence: 1
    });
    const observations = await store.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      ownerUserId: fixture.owner.id
    });
    expect(observations).toHaveLength(1);

    await server.close();
  });

  it("does not mutate completed, cancelled, or failed durable runs during recovery sweeps", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const terminalFixture = {
      store: fixture.store,
      clientInstanceId: fixture.clientInstanceId,
      owner: fixture.owner
    };
    const completed = await createPersistedRecoveryRun(terminalFixture, {
      status: "completed"
    });
    const cancelled = await createPersistedRecoveryRun(terminalFixture, {
      status: "cancelled"
    });
    const failed = await createPersistedRecoveryRun(terminalFixture, {
      status: "failed"
    });

    const watchdog = new RunRecoveryWatchdog(fixture.options, undefined, {
      staleActiveRunMs: 1,
      runOnStartup: false,
      watchdogIntervalMs: 60_000
    });
    const summary = await watchdog.sweep(new Date("2026-01-01T00:00:00.000Z"));
    expect(summary.checked).toBe(1);
    expect(summary.recovered).toBe(1);

    await expectRunStatus(fixture.store, fixture.clientInstanceId, completed.id, "completed");
    await expectRunStatus(fixture.store, fixture.clientInstanceId, cancelled.id, "cancelled");
    await expectRunStatus(fixture.store, fixture.clientInstanceId, failed.id, "failed");

    await fixture.server.close();
  });
});
