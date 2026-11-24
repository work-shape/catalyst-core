import {
  fetchTestOperation,
  listenTestInstance,
  createTestInstance
} from "./support/test-instance";

import { describe, expect, it, vi } from "vitest";

import {
  NoopAuditRecorder,
  asToolCallId,
  asAgentRunId,
  asClientInstanceId,
  createAssistantFinalMetadata,
  createPlatformId
} from "@work-shape/catalyst-core";

import { toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { eventually, required } from "./support/assertions";
import { createTestConfig, createTestUser } from "./support/fixtures";
import { createHeldModel, HELD_MODEL_PROVIDER } from "./support/held-model";
import {
  createMissingRuntime,
  createUnusedModelProvider,
  drainRunEvents,
  fetchStartConversationRun,
  fetchRunEvents,
  parseSseChunks
} from "./support/chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("exposes a thread snapshot with active run projection", async () => {
    // The model stops after its first piece, so the run stays in progress until the test has read
    // it, however fast or slow the worker takes it up.
    const model = createHeldModel();
    const config = createTestConfig();
    config.infrastructure.models = { local: { provider: HELD_MODEL_PROVIDER, model: "local" } };
    const app = await createTestInstance({
      config,
      env: {},
      capabilities: [model.capability],
      tools: []
    });

    const created = await app.call("conversations.create", {
      payload: { title: "Thread snapshot test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "snapshot should show this run while active"
    );
    const runId = started.run.id;
    const fullRun = required(
      await app.stores.agentRuns.getAgentRun({
        clientInstanceId: asClientInstanceId(config.clientInstance.id),
        runId: asAgentRunId(runId)
      })
    );

    // Wait only for readiness; identity assertions fail immediately and always release the model.
    try {
      await eventually(async () => {
        const response = await fetchTestOperation(baseUrl, "conversations.thread.get", {
          params: { conversationId: conversation.id }
        });
        expect(await response.json()).toMatchObject({
          activeRun: { run: { id: runId, status: "running" } }
        });
      });
      const snapshot = await fetchTestOperation(baseUrl, "conversations.thread.get", {
        params: { conversationId: conversation.id }
      });
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toMatchObject({
        conversation: {
          id: conversation.id
        },
        messages: [
          expect.objectContaining({
            role: "user",
            text: "snapshot should show this run while active"
          })
        ],
        activeRun: {
          run: {
            id: runId,
            ownerUserId: fullRun.ownerUserId,
            inputMessageId: fullRun.inputMessageId,
            status: "running"
          },
          projection: {
            runId,
            ownerUserId: fullRun.ownerUserId,
            inputMessageId: fullRun.inputMessageId,
            lastSequence: expect.any(Number),
            text: expect.any(String)
          }
        }
      });
    } finally {
      model.release();
    }

    await fetchRunEvents(baseUrl, conversation.id, runId);

    const completedSnapshot = await fetchTestOperation(baseUrl, "conversations.thread.get", {
      params: { conversationId: conversation.id }
    });
    expect(completedSnapshot.status).toBe(200);
    const completedBody = (await completedSnapshot.json()) as {
      activeRun?: unknown;
      completedRunProjections?: Record<
        string,
        {
          runId: string;
          status: string;
          parts: Array<{ type: string; text?: string }>;
        }
      >;
    };
    expect(completedBody.activeRun).toBeUndefined();
    expect(completedBody.completedRunProjections?.[runId]).toMatchObject({
      runId,
      ownerUserId: fullRun.ownerUserId,
      inputMessageId: fullRun.inputMessageId,
      status: "completed",
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "text"
        })
      ])
    });
    await app.close();
  });

  it("keeps the latest failed run in the thread snapshot after refresh", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner = createTestUser("user-1", clientInstanceId);
    const store = (await createTestInstance()).stores;
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store: store.usage,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: owner.id,
      createdByExternalUserId: owner.externalUserId,
      title: "Failed projection test",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const userMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "process these documents"
    });
    const run = await store.agentRuns.createAgentRun({
      id: createPlatformId<"AgentRunId">("run"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: userMessage.id,
      agentName: "test_agent",
      correlationId: "failed-projection",
      startedAt: "2026-08-11T00:00:00.000Z"
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: run.id,
        sequence: 1,
        delta: "Seven documents were processed before the failure.",
        createdAt: "2026-08-11T00:00:01.000Z"
      }
    });
    const error = {
      code: "FORBIDDEN",
      message: "Daily customer billable cost is incomplete",
      category: "app_error" as const
    };
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "run_failed",
        runId: run.id,
        sequence: 2,
        error,
        createdAt: "2026-08-11T00:00:02.000Z"
      }
    });
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "failed",
      updatedAt: "2026-08-11T00:00:02.000Z",
      failedAt: "2026-08-11T00:00:02.000Z",
      lastSequence: 2,
      error
    });

    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate() {
            return owner;
          }
        },
        stores: store,
        usageGovernance,
        auditRecorder: new NoopAuditRecorder(),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider()
      }
    });

    const snapshot = await server.call("conversations.thread.get", {
      params: { conversationId: conversation.id }
    });

    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      activeRun: {
        run: {
          id: run.id,
          status: "failed"
        },
        projection: {
          runId: run.id,
          status: "failed",
          text: "Seven documents were processed before the failure.",
          error
        }
      }
    });
    await server.close();
  });

  it("exposes completed run projections in recorded observation order", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner = createTestUser("user-1", clientInstanceId);
    const store = (await createTestInstance()).stores;
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store: store.usage,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: owner.id,
      createdByExternalUserId: owner.externalUserId,
      title: "Completed projection test",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const userMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "müssen supermärkte jegliches Pfand annehmen?"
    });
    const run = await store.agentRuns.createAgentRun({
      id: createPlatformId<"AgentRunId">("run"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: userMessage.id,
      agentName: "test_agent",
      correlationId: "completed-projection-order",
      startedAt: "2026-07-01T12:00:00.000Z"
    });
    const toolCallId = asToolCallId("call_web");
    const progressText =
      "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
    const finalText = "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.";
    const finalMessageId = createPlatformId<"MessageId">("msg");

    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: run.id,
        sequence: 1,
        createdAt: "2026-07-01T12:00:01.000Z",
        delta: progressText
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "tool_call_started",
        runId: run.id,
        sequence: 2,
        createdAt: "2026-07-01T12:00:02.000Z",
        toolCallId,
        toolName: "web_search",
        input: {
          query: "Pfand Annahmepflicht Supermarkt Deutschland"
        }
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "tool_call_completed",
        runId: run.id,
        sequence: 3,
        createdAt: "2026-07-01T12:00:03.000Z",
        toolCallId,
        toolName: "web_search",
        result: toolSuccess({
          sourceCount: 1
        }),
        modelOutput: '{"sourceCount":1}'
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: run.id,
        sequence: 4,
        createdAt: "2026-07-01T12:00:04.000Z",
        delta: finalText
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_completed",
        runId: run.id,
        sequence: 5,
        createdAt: "2026-07-01T12:00:05.000Z",
        message: {
          id: finalMessageId,
          role: "assistant",
          text: `${progressText}${finalText}`,
          metadata: createAssistantFinalMetadata({
            runId: run.id
          })
        }
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "run_completed",
        runId: run.id,
        sequence: 6,
        createdAt: "2026-07-01T12:00:06.000Z"
      }
    });
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: "2026-07-01T12:00:06.000Z",
      completedAt: "2026-07-01T12:00:06.000Z",
      lastSequence: 6
    });
    await store.conversations.appendMessage({
      id: finalMessageId,
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: `${progressText}${finalText}`,
      metadata: createAssistantFinalMetadata({
        runId: run.id
      })
    });

    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate() {
            return owner;
          }
        },
        stores: store,
        usageGovernance,
        auditRecorder: new NoopAuditRecorder(),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider()
      }
    });

    const snapshot = await server.call("conversations.thread.get", {
      params: { conversationId: conversation.id }
    });

    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json() as {
      completedRunProjections?: Record<
        string,
        {
          durationMs?: number;
          parts: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string }>;
        }
      >;
    };
    expect(body.completedRunProjections?.[run.id]?.durationMs).toBe(6_000);
    expect(body.completedRunProjections?.[run.id]?.parts).toEqual([
      {
        type: "text",
        text: progressText
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId,
        toolName: "web_search"
      }),
      {
        type: "text",
        text: finalText
      }
    ]);

    await server.close();
  });

  it("skips completed run projections when observations lack final completion text", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner = createTestUser("user-1", clientInstanceId);
    const store = (await createTestInstance()).stores;
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store: store.usage,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: owner.id,
      createdByExternalUserId: owner.externalUserId,
      title: "Incomplete completed projection test",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const userMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "müssen supermärkte jegliches Pfand annehmen?"
    });
    const run = await store.agentRuns.createAgentRun({
      id: createPlatformId<"AgentRunId">("run-incomplete"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: userMessage.id,
      agentName: "test_agent",
      correlationId: "incomplete-completed-projection",
      startedAt: "2026-07-01T12:00:00.000Z"
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: run.id,
        sequence: 1,
        createdAt: "2026-07-01T12:00:01.000Z",
        delta: "Ich prüfe kurz die aktuellen offiziellen Regeln."
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: run.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "run_completed",
        runId: run.id,
        sequence: 2,
        createdAt: "2026-07-01T12:00:02.000Z"
      }
    });
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: "2026-07-01T12:00:02.000Z",
      completedAt: "2026-07-01T12:00:02.000Z",
      lastSequence: 2
    });
    await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.",
      metadata: createAssistantFinalMetadata({
        runId: run.id
      })
    });

    const server = await createTestInstance({
      server: {
        config,
        clientInstanceId,
        authAdapter: {
          credentialMode: "ambient",
          id: "test-auth",
          async authenticate() {
            return owner;
          }
        },
        stores: store,
        usageGovernance,
        auditRecorder: new NoopAuditRecorder(),
        agentRuntime: createMissingRuntime(),
        modelProvider: createUnusedModelProvider()
      }
    });

    const snapshot = await server.call("conversations.thread.get", {
      params: { conversationId: conversation.id }
    });

    expect(snapshot.statusCode).toBe(200);
    const body = snapshot.json() as {
      completedRunProjections?: Record<string, unknown>;
      messages: Array<{ role: string; text: string }>;
    };
    expect(body.completedRunProjections?.[run.id]).toBeUndefined();
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen."
        })
      ])
    );

    await server.close();
  });

  it("streams product run observations from a sequence cursor", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    const created = await app.call("conversations.create", {
      payload: { title: "Product event stream test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const baseUrl = await listenTestInstance(app);

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "product observations should be cursor readable"
    );
    const runId = started.run.id;
    await fetchRunEvents(baseUrl, conversation.id, runId);

    const events = await fetchTestOperation(baseUrl, "conversations.runs.observe", {
      params: { conversationId: conversation.id, runId: runId },
      query: { after: "1" }
    });
    expect(events.status).toBe(200);
    const observations = parseSseChunks(await events.text());
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((observation) => Number(observation.sequence) > 1)).toBe(true);
    expect(observations).toContainEqual(
      expect.objectContaining({
        runId,
        conversationId: conversation.id,
        type: "run_completed"
      })
    );

    await app.close();
  });
});

describe("the event stream of a run", () => {
  // Fails without the second read: the stream saw no event, then the finished run, and closed
  // with nothing sent.
  it.each([
    ["a new stream", 0],
    ["a stream resumed after a reconnect", 1]
  ])(
    "delivers every event to %s when the run ends between its event read and its status read",
    async (_reader, afterSequence) => {
      const clientInstanceId = asClientInstanceId("demo-local");
      const owner = createTestUser("user-1", clientInstanceId);
      const store = (await createTestInstance()).stores;
      const config = createTestConfig();
      const conversation = await store.createConversationForTesting({
        clientInstanceId,
        createdByUserId: owner.id,
        createdByExternalUserId: owner.externalUserId,
        title: "Run that ends between two reads",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const userMessage = await store.conversations.appendMessage({
        clientInstanceId,
        conversationId: conversation.id,
        role: "user",
        text: "answer me"
      });
      const run = await store.agentRuns.createAgentRun({
        id: createPlatformId<"AgentRunId">("run"),
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId: owner.id,
        inputMessageId: userMessage.id,
        agentName: "test_agent",
        correlationId: "ends-between-reads",
        startedAt: "2026-08-11T00:00:00.000Z"
      });
      const append = (sequence: number, delta: string) =>
        store.agentRuns.appendRunObservation({
          clientInstanceId,
          runId: run.id,
          conversationId: conversation.id,
          ownerUserId: owner.id,
          event: {
            type: "message_delta",
            runId: run.id,
            sequence,
            delta,
            createdAt: "2026-08-11T00:00:01.000Z"
          }
        });
      for (let sequence = 1; sequence <= afterSequence; sequence += 1)
        await append(sequence, "Heard before the reconnect. ");

      // The worker of another process: it stores the rest of the answer and the end of the run
      // after the stream's first event read has returned, before the stream reads the run.
      const lastSequence = afterSequence + 2;
      const readEvents = store.agentRuns.listRunObservations.bind(store.agentRuns);
      let runEnded = false;
      vi.spyOn(store.agentRuns, "listRunObservations").mockImplementation(async (input) => {
        const events = await readEvents(input);
        if (runEnded) return events;
        runEnded = true;
        await append(afterSequence + 1, "The whole answer.");
        await store.agentRuns.appendRunObservation({
          clientInstanceId,
          runId: run.id,
          conversationId: conversation.id,
          ownerUserId: owner.id,
          event: {
            type: "run_completed",
            runId: run.id,
            sequence: lastSequence,
            createdAt: "2026-08-11T00:00:02.000Z"
          }
        });
        await store.agentRuns.updateAgentRunStatus({
          clientInstanceId,
          runId: run.id,
          status: "completed",
          updatedAt: "2026-08-11T00:00:02.000Z",
          completedAt: "2026-08-11T00:00:02.000Z",
          lastSequence
        });
        return events;
      });

      const server = await createTestInstance({
        server: {
          config,
          clientInstanceId,
          authAdapter: {
            credentialMode: "ambient",
            id: "test-auth",
            async authenticate() {
              return owner;
            }
          },
          stores: store,
          usageGovernance: new ModelUsageGovernance({
            store: store.usage,
            budget: config.usage.budget,
            safeguards: config.usage.safeguards,
            costs: config.usage.costs
          }),
          auditRecorder: new NoopAuditRecorder(),
          agentRuntime: createMissingRuntime(),
          modelProvider: createUnusedModelProvider()
        }
      });
      try {
        const events = parseSseChunks(
          await drainRunEvents(server, conversation.id, run.id, { afterSequence })
        );
        expect(runEnded).toBe(true);
        expect(events.map((event) => [event.sequence, event.type])).toEqual([
          [afterSequence + 1, "message_delta"],
          [lastSequence, "run_completed"]
        ]);
      } finally {
        await server.close();
      }
    }
  );
});
