import { describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  NoopAuditRecorder,
  asToolCallId,
  asClientInstanceId,
  createAssistantFinalMetadata,
  createPlatformId
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { toolSuccess } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig, createClientInstanceApp, createTestUser } from "./chat-server-harness";
import {
  createMissingRuntime,
  createUnusedModelProvider,
  fetchStartConversationRun,
  fetchRunEvents,
  parseSseChunks
} from "./chat-server-run-harness";

describe("client instance app vertical slice", () => {
  it("exposes a thread snapshot with active run projection", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Thread snapshot test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "snapshot should show this run while active"
    );
    const runId = started.run.id;

    const snapshot = await fetch(`${baseUrl}/api/conversations/${conversation.id}/thread`);
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

    const completedSnapshot = await fetch(`${baseUrl}/api/conversations/${conversation.id}/thread`);
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

  it("exposes completed run projections in recorded observation order", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const owner = createTestUser("user-1", clientInstanceId);
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: owner.id,
      ownerExternalUserId: owner.externalUserId,
      title: "Completed projection test",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const userMessage = await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "müssen supermärkte jegliches Pfand annehmen?"
    });
    const run = await store.createAgentRun({
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

    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: "2026-07-01T12:00:06.000Z",
      completedAt: "2026-07-01T12:00:06.000Z",
      lastSequence: 6
    });
    await store.appendMessage({
      id: finalMessageId,
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: `${progressText}${finalText}`,
      metadata: createAssistantFinalMetadata({
        runId: run.id
      })
    });

    const finalOnlyUserMessage = await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "split this PDF into three files"
    });
    const finalOnlyRun = await store.createAgentRun({
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

    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.updateAgentRunStatus({
      clientInstanceId,
      runId: finalOnlyRun.id,
      status: "completed",
      updatedAt: "2026-07-01T12:01:06.000Z",
      completedAt: "2026-07-01T12:01:06.000Z",
      lastSequence: 6
    });
    await store.appendMessage({
      id: finalOnlyMessageId,
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: finalOnlyText,
      metadata: createAssistantFinalMetadata({
        runId: finalOnlyRun.id
      })
    });

    const server = await createChatServer({
      config,
      clientInstanceId,
      authAdapter: {
        id: "test-auth",
        async authenticate() {
          return owner;
        }
      },
      conversationStore: store,
      auditEventStore: store,
      userStore: store,
      usageGovernance,
      auditRecorder: new NoopAuditRecorder(),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      runRecovery: {
        staleActiveRunMs: 60_000,
        runOnStartup: false,
        watchdogIntervalMs: 60_000
      }
    });

    const snapshot = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/thread`
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
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      costs: config.usage.costs
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: owner.id,
      ownerExternalUserId: owner.externalUserId,
      title: "Incomplete completed projection test",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const userMessage = await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "müssen supermärkte jegliches Pfand annehmen?"
    });
    const run = await store.createAgentRun({
      id: createPlatformId<"AgentRunId">("run-incomplete"),
      clientInstanceId,
      conversationId: conversation.id,
      ownerUserId: owner.id,
      inputMessageId: userMessage.id,
      agentName: "test_agent",
      correlationId: "incomplete-completed-projection",
      startedAt: "2026-07-01T12:00:00.000Z"
    });
    await store.appendRunObservation({
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
    await store.appendRunObservation({
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
    await store.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: "2026-07-01T12:00:02.000Z",
      completedAt: "2026-07-01T12:00:02.000Z",
      lastSequence: 2
    });
    await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen.",
      metadata: createAssistantFinalMetadata({
        runId: run.id
      })
    });

    const server = await createChatServer({
      config,
      clientInstanceId,
      authAdapter: {
        id: "test-auth",
        async authenticate() {
          return owner;
        }
      },
      conversationStore: store,
      auditEventStore: store,
      userStore: store,
      usageGovernance,
      auditRecorder: new NoopAuditRecorder(),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      runRecovery: {
        staleActiveRunMs: 60_000,
        runOnStartup: false,
        watchdogIntervalMs: 60_000
      }
    });

    const snapshot = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/thread`
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
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Product event stream test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "product observations should be cursor readable"
    );
    const runId = started.run.id;
    await fetchRunEvents(baseUrl, conversation.id, runId);

    const events = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/events?after=1`
    );
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
