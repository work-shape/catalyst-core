import { describe, expect, it, vi } from "vitest";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { RunRecoveryWatchdog } from "@vivd-catalyst/chat-server";
import { createStaticConfigAssetSource } from "@vivd-catalyst/core/testing";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  createStaleRunRecoveryFixture,
  createPersistedRecoveryRun,
  drainRunEvents,
  expectRunStatus,
  injectStartConversationRun,
  parseSseChunks
} from "./support/chat-server-run-harness";
import { personalConversationListInput } from "./support/fixtures";

describe("client instance app vertical slice", () => {
  it("reads a stale run without recovery and cancels it explicitly before thread snapshots without duplicate terminal observations", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;
    const before = await server.call("getConversationThread", {
      params: { conversationId: conversation.id }
    });
    expect(before.json().activeRun.run.status).toBe("running");
    expect(
      await store.agentRuns.listRunObservations({
        clientInstanceId: fixture.clientInstanceId,
        runId: run.id
      })
    ).toHaveLength(1);
    await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      payload: {}
    });

    const snapshot = await server.call("getConversationThread", {
      params: { conversationId: conversation.id }
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

    await server.call("getConversationThread", { params: { conversationId: conversation.id } });
    const observations = await store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(observations.map((observation) => observation.type)).toEqual([
      "message_delta",
      "run_failed"
    ]);
    expect(observations.map((observation) => observation.sequence)).toEqual([1, 2]);

    await server.close();
  });

  it("reads stale runs without recovery and cancels them explicitly before listing conversations", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;
    const before = await server.call("getConversationThread", {
      params: { conversationId: conversation.id }
    });
    expect(before.json().activeRun.run.status).toBe("running");
    expect(
      await store.agentRuns.listRunObservations({
        clientInstanceId: fixture.clientInstanceId,
        runId: run.id
      })
    ).toHaveLength(1);
    await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      payload: {}
    });

    const listed = await server.call(
      "listConversations",
      await personalConversationListInput(server)
    );
    expect(listed.statusCode).toBe(200);
    const listedConversation = listed
      .json<{ items: Array<{ id: string; activeRun?: unknown }> }>()
      .items.find((item) => item.id === conversation.id);
    expect(listedConversation).toBeDefined();
    expect(listedConversation).not.toHaveProperty("activeRun");

    const recoveredRun = await store.agentRuns.getAgentRun({
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

  it("cancels a stale durable active run before reading observation cursors after the last pre-crash sequence", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;
    const before = await server.call("getConversationThread", {
      params: { conversationId: conversation.id }
    });
    expect(before.json().activeRun.run.status).toBe("running");
    expect(
      await store.agentRuns.listRunObservations({
        clientInstanceId: fixture.clientInstanceId,
        runId: run.id
      })
    ).toHaveLength(1);
    await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      payload: {}
    });

    const events = await server.call("observeConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      query: { after: "1" }
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

    const recoveredRun = await store.agentRuns.getAgentRun({
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

    const replay = await server.call("observeConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      query: { after: "1" }
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

  it("cancels a fresh durable active run before observing when local runtime state is missing", async () => {
    const fixture = await createStaleRunRecoveryFixture({
      staleActiveRunMs: 60 * 60 * 1000
    });
    const { server, store, conversation, run } = fixture;
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      status: "running",
      updatedAt: new Date().toISOString(),
      lastSequence: 1
    });

    await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      payload: {}
    });

    const events = await server.call("observeConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      query: { after: "1" }
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
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      status: "running",
      updatedAt: new Date().toISOString(),
      lastSequence: 1
    });

    const cancelled = await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
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

    const replay = await store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(replay.map((observation) => observation.type)).toEqual(["message_delta", "run_failed"]);
    await server.close();
  });

  it("recovers a run the last process left active when a local runtime starts, and accepts a new message", async () => {
    const agent = {
      name: "test_agent",
      displayName: "Test Agent",
      instructions: "Answer.",
      modelProviderId: "test-provider",
      toolNames: [],
      skillNames: [],
      initialPrompts: []
    };
    const assetSource = createStaticConfigAssetSource({
      defaultAgentName: agent.name,
      agents: [agent]
    });
    const provider = { id: "test-provider", type: "deterministic" as const, model: "test-model" };
    // Far from the stale cutoff: only the startup recovery can end this run.
    const fixture = await createStaleRunRecoveryFixture({
      staleActiveRunMs: 100 * 365 * 24 * 60 * 60 * 1000,
      runOnStartup: true,
      runtime: (store) => ({
        assetSource,
        agentRuntime: new LocalAgentRuntime({
          assetSource,
          modelProviders: [provider],
          defaultModelProvider: provider,
          conversationHistory: store.conversations,
          agentRunStore: store.agentRuns,
          runObservationStore: store.agentRuns,
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
              throw new Error("No tool is configured");
            },
            async execute() {
              throw new Error("No tool is configured");
            }
          },
          usageGovernance: new ModelUsageGovernance({
            store: store.usage,
            budget: {},
            safeguards: {}
          })
        })
      })
    });
    const { server, store, conversation, run } = fixture;
    await store.configAssets.applyConfigAssetMutations({
      clientInstanceId: fixture.clientInstanceId,
      mutations: [
        { type: "upsert", kind: "agent", name: agent.name, config: agent },
        { type: "setDefaultAgent", agentName: agent.name }
      ]
    });

    // The first request starts the server, and with it the watchdog.
    expect(
      (await server.call("getConversationThread", { params: { conversationId: conversation.id } }))
        .statusCode
    ).toBe(200);
    await vi.waitFor(() => expectRunStatus(store, fixture.clientInstanceId, run.id, "failed"));

    const next = await injectStartConversationRun(server, conversation.id, "after the restart");
    expect(next.run.id).not.toBe(run.id);
    await drainRunEvents(server, conversation.id, next.run.id);
    expect(
      (await server.call("getConversationThread", { params: { conversationId: conversation.id } }))
        .json<{ messages: Array<{ role: string; text: string }> }>()
        .messages.at(-1)
    ).toMatchObject({ role: "assistant", text: "Done." });

    await server.close();
  });

  it("leaves a run alone while a worker holds a live lease, even without local runtime state", async () => {
    const fixture = await createStaleRunRecoveryFixture({
      staleActiveRunMs: 60 * 60 * 1000
    });
    const { server, store, conversation, run } = fixture;
    const now = Date.now();
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id,
      status: "queued",
      updatedAt: new Date(now).toISOString(),
      lastSequence: 1
    });
    await store.agentRuns.claimNextAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      workerId: "worker-a",
      leaseToken: "lease-a",
      now: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + 10 * 60 * 1000).toISOString()
    });

    const events = await server.call("observeConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      query: { after: "1" }
    });
    expect(parseSseChunks(events.payload).map((chunk) => chunk.type)).not.toContain("run_failed");

    const cancelled = await server.call("cancelConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      payload: { reason: "Stop" }
    });
    expect(cancelled.statusCode).toBe(404);

    await expectRunStatus(store, fixture.clientInstanceId, run.id, "running");
    await server.close();
  });

  it("does not disclose or mutate another user's stale durable run during recovery-visible reads", async () => {
    const fixture = await createStaleRunRecoveryFixture();
    const { server, store, conversation, run } = fixture;

    const wrongOwnerEvents = await server.call("observeConversationRun", {
      params: { conversationId: conversation.id, runId: run.id },
      query: { after: "1" },
      headers: {
        "x-test-user": "other-user"
      }
    });
    expect(wrongOwnerEvents.statusCode).toBe(404);

    const wrongOwnerSnapshot = await server.call("getConversationThread", {
      params: { conversationId: conversation.id },
      headers: {
        "x-test-user": "other-user"
      }
    });
    expect(wrongOwnerSnapshot.statusCode).toBe(404);

    const unchangedRun = await store.agentRuns.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    });
    expect(unchangedRun).toMatchObject({
      status: "running",
      lastSequence: 1
    });
    const observations = await store.agentRuns.listRunObservations({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
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
