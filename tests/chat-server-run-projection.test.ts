import {
  fetchTestOperation,
  listenTestInstance,
  createTestInstance
} from "./support/test-instance";

import { describe, expect, it } from "vitest";

import {
  NoopAuditRecorder,
  asToolCallId,
  asClientInstanceId,
  createAssistantFinalMetadata,
  createPlatformId
} from "@vivd-catalyst/core";

import { toolSuccess } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createTestUser } from "./support/fixtures";
import {
  createMissingRuntime,
  createUnusedModelProvider,
  fetchStartConversationRun,
  fetchRunEvents,
  parseSseChunks
} from "./support/chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("exposes a thread snapshot with active run projection", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: {},
      tools: []
    });

    const created = await app.call("createConversation", {
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

    const snapshot = await fetchTestOperation(baseUrl, "getConversationThread", {
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
          status: "running"
        },
        projection: {
          runId,
          lastSequence: expect.any(Number),
          text: expect.any(String)
        }
      }
    });

    await fetchRunEvents(baseUrl, conversation.id, runId);

    const completedSnapshot = await fetchTestOperation(baseUrl, "getConversationThread", {
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
    const store = createTestInstance().stores;
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
        modelProvider: createUnusedModelProvider(),
        runRecovery: {
          staleActiveRunMs: 60_000,
          runOnStartup: false,
          watchdogIntervalMs: 60_000
        }
      }
    });

    const snapshot = await server.call("getConversationThread", {
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
    const store = createTestInstance().stores;
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

    const finalOnlyUserMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "split this PDF into three files"
    });
    const finalOnlyRun = await store.agentRuns.createAgentRun({
      id: createPlatformId<"AgentRunId">("run_final_only"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: finalOnlyUserMessage.id,
      agentName: "test_agent",
      correlationId: "completed-projection-final-only",
      startedAt: "2026-07-01T12:01:00.000Z"
    });
    const finalOnlyToolCallId = asToolCallId("call_workspace");
    const finalOnlyProgressText = "I will create the files now.";
    const finalOnlyText = "Done. I split the PDF into 3 files.";
    const finalOnlyMessageId = createPlatformId<"MessageId">("msg_final_only");

    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: finalOnlyRun.id,
        sequence: 1,
        createdAt: "2026-07-01T12:01:01.000Z",
        delta: finalOnlyProgressText
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "tool_call_started",
        runId: finalOnlyRun.id,
        sequence: 2,
        createdAt: "2026-07-01T12:01:02.000Z",
        toolCallId: finalOnlyToolCallId,
        toolName: "workspace.exec",
        input: {
          command: "split-pdf"
        }
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "tool_call_completed",
        runId: finalOnlyRun.id,
        sequence: 3,
        createdAt: "2026-07-01T12:01:03.000Z",
        toolCallId: finalOnlyToolCallId,
        toolName: "workspace.exec",
        result: toolSuccess({
          ok: true
        }),
        modelOutput: '{"ok":true}'
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_delta",
        runId: finalOnlyRun.id,
        sequence: 4,
        createdAt: "2026-07-01T12:01:04.000Z",
        delta: finalOnlyText
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "message_completed",
        runId: finalOnlyRun.id,
        sequence: 5,
        createdAt: "2026-07-01T12:01:05.000Z",
        message: {
          id: finalOnlyMessageId,
          role: "assistant",
          text: finalOnlyText,
          metadata: createAssistantFinalMetadata({
            runId: finalOnlyRun.id
          })
        }
      }
    });
    await store.agentRuns.appendRunObservation({
      clientInstanceId,
      runId: finalOnlyRun.id,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      event: {
        type: "run_completed",
        runId: finalOnlyRun.id,
        sequence: 6,
        createdAt: "2026-07-01T12:01:06.000Z"
      }
    });
    await store.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: finalOnlyRun.id,
      status: "completed",
      updatedAt: "2026-07-01T12:01:06.000Z",
      completedAt: "2026-07-01T12:01:06.000Z",
      lastSequence: 6
    });
    await store.conversations.appendMessage({
      id: finalOnlyMessageId,
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: finalOnlyText,
      metadata: createAssistantFinalMetadata({
        runId: finalOnlyRun.id
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
        modelProvider: createUnusedModelProvider(),
        runRecovery: {
          staleActiveRunMs: 60_000,
          runOnStartup: false,
          watchdogIntervalMs: 60_000
        }
      }
    });

    const snapshot = await server.call("getConversationThread", {
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
    expect(body.completedRunProjections?.[finalOnlyRun.id]?.parts).toEqual([
      {
        type: "text",
        text: finalOnlyProgressText
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: finalOnlyToolCallId,
        toolName: "workspace.exec"
      }),
      {
        type: "text",
        text: finalOnlyText
      }
    ]);

    await server.close();
  });

  it("skips completed run projections when observations lack final completion text", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner = createTestUser("user-1", clientInstanceId);
    const store = createTestInstance().stores;
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
        modelProvider: createUnusedModelProvider(),
        runRecovery: {
          staleActiveRunMs: 60_000,
          runOnStartup: false,
          watchdogIntervalMs: 60_000
        }
      }
    });

    const snapshot = await server.call("getConversationThread", {
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

    const created = await app.call("createConversation", {
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

    const events = await fetchTestOperation(baseUrl, "observeConversationRun", {
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
