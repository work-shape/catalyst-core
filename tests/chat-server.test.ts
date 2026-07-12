import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AddressInfo } from "net";
import {
  createClientInstanceApp as createUnseededClientInstanceApp,
  type ClientInstanceCapability
} from "@vivd-catalyst/client-assembly";
import {
  RunRecoveryWatchdog,
  createChatServer,
  type ChatServerOptions
} from "@vivd-catalyst/chat-server";
import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  NoopAuditRecorder,
  PERMISSIONS,
  StoreBackedAuditRecorder,
  asToolCallId,
  asClientInstanceId,
  createAssistantFinalMetadata,
  createPlatformId,
  isJsonObject,
  unknownToJsonValue,
  type AgentRun,
  type AgentRuntime,
  type AuthenticatedUser,
  type ChatMessage,
  type ConversationAttachment,
  type DraftAttachment,
  type AttachmentManifestEntry,
  type FileAttachmentFormat,
  type ImageFileFormat,
  type JsonObject,
  type ManagedFileId,
  type RuntimeCallContext,
  type SupportedImageMimeType
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig, type UsageSafeguardsConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("client instance app vertical slice", () => {
  it("boots and exposes safe config with zero stored assets", async () => {
    const app = await createUnseededClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const response = await app.server.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agents: [] });
    await app.close();
  });

  it("creates a user-scoped conversation and runs a configured tool", async () => {
    const config = createTestConfig({
      tools: [{ name: "demo.echo", enabled: true }],
      toolNames: ["demo.echo"]
    });
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      async execute(input) {
        return toolSuccess({ echoed: input.text });
      }
    });
    const app = await createClientInstanceApp({
      config,
      env: {},
      storeMode: "memory",
      tools: [tool]
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Tool test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const started = await injectStartConversationRun(
      app.server,
      conversation.id,
      '/tool demo.echo {"text":"hello"}'
    );
    await drainRunEvents(app.server, conversation.id, started.run.id);

    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json() as Array<{ role: string; text: string }>;
    expect(persistedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          text: expect.stringContaining('"echoed": "hello"')
        })
      ])
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).some((event) => event.type === "tool.completed")).toBe(
      true
    );

    const usage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage"
    });
    expect(usage.statusCode).toBe(200);
    const usageBody = usage.json() as {
      today: { modelCallCount: number; totalTokens: number };
    };
    expect(usageBody.today).toMatchObject({
      totalTokens: 0
    });
    expect(usageBody.today.modelCallCount).toBeGreaterThan(0);

    await app.close();
  });

  it("shows admins billed usage without internal cost policy", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "admin-1",
          users: [
            {
              id: "admin-1",
              externalUserId: "admin-1",
              displayLabel: "Admin",
              roles: ["user", "admin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        },
        usageBudget: {
          monthlySpendLimit: 200,
          costSafetyMultiplier: 1.3
        },
        usageSafeguards: {
          tokensPerMonth: 50000000
        },
        usagePricing: {
          currency: "USD",
          models: [
            {
              providerId: "local",
              model: "local",
              inputPricePerMillionTokens: 1,
              outputPricePerMillionTokens: 2
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const adminUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(adminUsage.statusCode).toBe(200);
    const adminUsageBody = adminUsage.json() as Record<string, unknown>;
    expect(adminUsageBody).toMatchObject({
      safeguards: {
        tokensPerMonth: 50000000
      },
      today: {
        modelCallCount: 0,
        totalTokens: 0,
        cost: {
          currency: "USD",
          modelBilledCostMicros: 0,
          billedCostMicros: 0,
          webSearchCostVisible: false
        }
      }
    });
    expect((adminUsageBody.today as { cost: Record<string, unknown> }).cost).not.toHaveProperty(
      "webSearchBilledCostMicros"
    );
    expect(JSON.stringify(adminUsageBody)).not.toContain("monthlySpendLimit");
    expect(JSON.stringify(adminUsageBody)).not.toContain("costSafetyMultiplier");
    expect(JSON.stringify(adminUsageBody)).not.toContain("inputPricePerMillionTokens");
    expect(JSON.stringify(adminUsageBody)).not.toContain("totalCostMicros");
    expect(JSON.stringify(adminUsageBody)).not.toContain("budgetedCostMicros");

    const adminConfig = await app.server.inject({
      method: "GET",
      url: "/api/config",
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(adminConfig.statusCode).toBe(200);
    expect(JSON.stringify(adminConfig.json())).not.toContain("monthlySpendLimit");
    expect(JSON.stringify(adminConfig.json())).not.toContain("costSafetyMultiplier");

    const superadminUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(superadminUsage.statusCode).toBe(200);
    expect(superadminUsage.json()).toMatchObject({
      safeguards: {
        tokensPerMonth: 50000000
      },
      today: {
        modelCallCount: 0,
        totalTokens: 0,
        cost: {
          currency: "USD",
          modelBilledCostMicros: 0,
          billedCostMicros: 0,
          webSearchCostVisible: false
        }
      }
    });
    expect(JSON.stringify(superadminUsage.json())).not.toContain("monthlySpendLimit");
    expect(JSON.stringify(superadminUsage.json())).not.toContain("costSafetyMultiplier");
    expect(JSON.stringify(superadminUsage.json())).not.toContain("inputPricePerMillionTokens");
    expect(JSON.stringify(superadminUsage.json())).not.toContain("totalCostMicros");
    expect(JSON.stringify(superadminUsage.json())).not.toContain("budgetedCostMicros");

    await app.close();

    const webSearchApp = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "admin-1",
          users: [
            {
              id: "admin-1",
              externalUserId: "admin-1",
              displayLabel: "Admin",
              roles: ["user", "admin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        },
        webAccess: {
          enabled: true,
          search: {
            enabled: true
          }
        },
        usagePricing: {
          currency: "USD",
          models: [
            {
              providerId: "local",
              model: "local",
              inputPricePerMillionTokens: 1,
              outputPricePerMillionTokens: 2
            }
          ],
          webSearch: [
            {
              providerId: "local",
              pricePerCall: 0.01
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });
    const webSearchUsage = await webSearchApp.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(webSearchUsage.statusCode).toBe(200);
    expect(webSearchUsage.json()).toMatchObject({
      today: {
        cost: {
          webSearchCostVisible: true,
          webSearchBilledCostMicros: 0
        }
      }
    });
    expect(JSON.stringify(webSearchUsage.json())).not.toContain("pricePerCall");
    await webSearchApp.close();
  });

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
    const completedBody = await completedSnapshot.json() as {
      activeRun?: unknown;
      completedRunProjections?: Record<string, {
        runId: string;
        status: string;
        parts: Array<{ type: string; text?: string }>;
      }>;
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
      pricing: config.usage.pricing
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
    const progressText = "Ich prüfe kurz die aktuellen offiziellen Regeln, damit die Antwort rechtlich sauber ist.";
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
        modelOutput: "{\"sourceCount\":1}"
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
        modelOutput: "{\"ok\":true}"
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
      completedRunProjections?: Record<string, {
        parts: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string }>;
      }>;
    };
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
      pricing: config.usage.pricing
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
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        text: "Kurz: Nein. Supermärkte müssen nicht jegliches Pfand annehmen."
      })
    ]));

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
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    const listedConversation = (listed.json() as Array<{ id: string; activeRun?: unknown }>)
      .find((item) => item.id === conversation.id);
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
    expect(replay.map((observation) => observation.type)).toEqual([
      "message_delta",
      "run_failed"
    ]);
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
    expect(wrongOwnerEvents.statusCode).toBe(204);

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

  it("exposes idempotent public Agent Runs start APIs and product SSE ids", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Public runs API test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missingIdempotency = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: { text: "missing idempotency key" }
      })
    });
    expect(missingIdempotency.status).toBe(422);
    await missingIdempotency.text();

    const firstStart = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-existing-run-key",
        message: { text: "start through public run API" }
      })
    });
    expect(firstStart.status).toBe(200);
    const firstStartBody = (await firstStart.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
      thread: { conversation: { id: string } };
      eventsUrl: string;
    };
    expect(firstStartBody).toMatchObject({
      thread: {
        conversation: {
          id: conversation.id
        }
      }
    });
    expect(firstStartBody.eventsUrl).toContain(
      `/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/events`
    );

    const retryStart = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-existing-run-key",
        message: { text: "this retry must not append" }
      })
    });
    expect(retryStart.status).toBe(200);
    expect(await retryStart.json()).toMatchObject({
      conversation: { id: conversation.id },
      userMessage: {
        id: firstStartBody.userMessage.id,
        text: "start through public run API"
      },
      run: { id: firstStartBody.run.id }
    });

    const events = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/events`
    );
    expect(events.status).toBe(200);
    const eventPayload = await events.text();
    expect(eventPayload).toContain("id: 1\n");
    const observations = parseSseChunks(eventPayload);
    expect(observations).toContainEqual(
      expect.objectContaining({
        runId: firstStartBody.run.id,
        conversationId: conversation.id,
        type: "run_completed",
        payload: expect.objectContaining({
          type: "run_completed"
        })
      })
    );
    expect(observations).not.toContainEqual(
      expect.objectContaining({
        type: "text-delta"
      })
    );

    const [concurrentStartA, concurrentStartB] = await Promise.all([
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-concurrent-key",
          message: { text: "concurrent public run start should append once" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-concurrent-key",
          message: { text: "duplicate concurrent public run start" }
        })
      })
    ]);
    expect(concurrentStartA.status).toBe(200);
    expect(concurrentStartB.status).toBe(200);
    const concurrentStartBodyA = (await concurrentStartA.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    const concurrentStartBodyB = (await concurrentStartB.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    expect(concurrentStartBodyB).toMatchObject({
      userMessage: {
        id: concurrentStartBodyA.userMessage.id,
        text: concurrentStartBodyA.userMessage.text
      },
      run: {
        id: concurrentStartBodyA.run.id
      }
    });
    expect([
      "concurrent public run start should append once",
      "duplicate concurrent public run start"
    ]).toContain(concurrentStartBodyA.userMessage.text);

    const concurrentEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${concurrentStartBodyA.run.id}/events`
    );
    expect(concurrentEvents.status).toBe(200);
    await concurrentEvents.text();

    const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
    expect(messages.status).toBe(200);
    const userMessages = ((await messages.json()) as Array<{ role: string; text: string }>).filter(
      (message) => message.role === "user"
    );
    expect(userMessages).toEqual([
      expect.objectContaining({
        text: "start through public run API"
      }),
      expect.objectContaining({
        text: concurrentStartBodyA.userMessage.text
      })
    ]);

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "different-key-race-draft.txt",
      contentType: "text/plain",
      content: "This draft should only be claimed by the accepted run start."
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const differentKeyStarts = await Promise.all([
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-different-key-a",
          message: { text: "different key start accepted" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-existing-run-different-key-b",
          message: { text: "different key start rejected" }
        })
      })
    ]);
    const acceptedDifferentKeyStarts = differentKeyStarts.filter(
      (response) => response.status === 200
    );
    const rejectedDifferentKeyStarts = differentKeyStarts.filter(
      (response) => response.status === 409
    );
    expect(acceptedDifferentKeyStarts).toHaveLength(1);
    expect(rejectedDifferentKeyStarts).toHaveLength(1);
    const acceptedDifferentKeyStart = (await acceptedDifferentKeyStarts[0]?.json()) as {
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    await rejectedDifferentKeyStarts[0]?.text();
    const differentKeyEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${acceptedDifferentKeyStart.run.id}/events`
    );
    expect(differentKeyEvents.status).toBe(200);
    await differentKeyEvents.text();

    const afterDifferentKeyMessages = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/messages`
    );
    expect(afterDifferentKeyMessages.status).toBe(200);
    const afterDifferentKeyUserMessages = (
      (await afterDifferentKeyMessages.json()) as Array<{
        id: string;
        role: string;
        text: string;
        metadata?: {
          agentRuntime?: {
            attachmentManifest?: {
              attachments?: Array<{ attachmentId?: string }>;
            };
          };
        };
      }>
    ).filter((message) => message.role === "user");
    const racedMessages = afterDifferentKeyUserMessages.filter((message) =>
      ["different key start accepted", "different key start rejected"].includes(message.text)
    );
    expect(racedMessages).toEqual([
      expect.objectContaining({
        id: acceptedDifferentKeyStart.userMessage.id,
        text: acceptedDifferentKeyStart.userMessage.text
      })
    ]);
    expect(racedMessages[0]?.metadata?.agentRuntime?.attachmentManifest?.attachments).toContainEqual(
      expect.objectContaining({
        attachmentId: uploadedBody.attachment.id
      })
    );

    const firstCreateAndStart = await fetch(`${baseUrl}/api/conversations/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-create-run-key",
        conversation: { title: "Created through run command" },
        message: { text: "create and start through public run API" }
      })
    });
    expect(firstCreateAndStart.status).toBe(200);
    const firstCreateAndStartBody = (await firstCreateAndStart.json()) as {
      conversation: { id: string };
      userMessage: { id: string };
      run: { id: string };
    };

    const retryCreateAndStart = await fetch(`${baseUrl}/api/conversations/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "public-create-run-key",
        conversation: { title: "Should not create another conversation" },
        message: { text: "this retry must not create another run" }
      })
    });
    expect(retryCreateAndStart.status).toBe(200);
    expect(await retryCreateAndStart.json()).toMatchObject({
      conversation: { id: firstCreateAndStartBody.conversation.id },
      userMessage: { id: firstCreateAndStartBody.userMessage.id },
      run: { id: firstCreateAndStartBody.run.id }
    });

    const [concurrentCreateA, concurrentCreateB] = await Promise.all([
      fetch(`${baseUrl}/api/conversations/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-concurrent-key",
          conversation: { title: "Concurrent create run" },
          message: { text: "concurrent create and start should create once" }
        })
      }),
      fetch(`${baseUrl}/api/conversations/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          idempotencyKey: "public-create-run-concurrent-key",
          conversation: { title: "Duplicate concurrent create run" },
          message: { text: "duplicate concurrent create and start" }
        })
      })
    ]);
    expect(concurrentCreateA.status).toBe(200);
    expect(concurrentCreateB.status).toBe(200);
    const concurrentCreateBodyA = (await concurrentCreateA.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    const concurrentCreateBodyB = (await concurrentCreateB.json()) as {
      conversation: { id: string };
      userMessage: { id: string; text: string };
      run: { id: string };
    };
    expect(concurrentCreateBodyB).toMatchObject({
      conversation: {
        id: concurrentCreateBodyA.conversation.id
      },
      userMessage: {
        id: concurrentCreateBodyA.userMessage.id,
        text: "concurrent create and start should create once"
      },
      run: {
        id: concurrentCreateBodyA.run.id
      }
    });

    const command = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${firstStartBody.run.id}/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ command: { type: "continue" } })
      }
    );
    expect(command.status).toBe(409);
    await command.text();

    await app.close();
  });

  it("does not disclose or mutate product run routes for the wrong owner", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "user-1",
          users: [
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "User One",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-2",
              externalUserId: "user-2",
              displayLabel: "User Two",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: { title: "Product route owner mismatch" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "wrong owner product route checks should not cancel this run",
      {
        headers: {
          "x-dev-user-id": "user-1"
        }
      }
    );
    const runId = started.run.id;

    const wrongOwnerEvents = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/events`,
      {
        headers: {
          "x-dev-user-id": "user-2"
        }
      }
    );
    expect(wrongOwnerEvents.status).toBe(204);
    expect(await wrongOwnerEvents.text()).toBe("");

    const wrongOwnerCancel = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dev-user-id": "user-2"
        },
        body: JSON.stringify({ reason: "wrong owner must not cancel" })
      }
    );
    expect(wrongOwnerCancel.status).toBe(404);
    await wrongOwnerCancel.text();

    expect(
      parseSseChunks(await fetchRunEvents(baseUrl, conversation.id, runId)).some(
        (chunk) => chunk.type === "run_completed"
      )
    ).toBe(true);
    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).not.toContainEqual(
      expect.objectContaining({
        type: "message.cancelled",
        metadata: expect.objectContaining({
          runId
        })
      })
    );

    await app.close();
  });

  it("cancels a backend run through the cancel route and records cancellation", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Cancel test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const started = await fetchStartConversationRun(
      baseUrl,
      conversation.id,
      "cancel this deliberately long enough response"
    );
    const runId = started.run.id;
    const events = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/events`);
    expect(events.status).toBe(200);
    const sentReader = events.body?.getReader();
    expect(sentReader).toBeDefined();
    const sentDecoder = new TextDecoder();
    let sentPayload = "";
    while (!sentPayload.includes("\"type\":\"message_delta\"")) {
      const next = await sentReader!.read();
      expect(next.done).toBe(false);
      sentPayload += sentDecoder.decode(next.value, { stream: true });
    }

    const cancelled = await fetch(
      `${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "test cancellation" })
      }
    );
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()) as { run: { status: string } }).toMatchObject({
      run: {
        status: "cancelled"
      }
    });
    while (true) {
      const next = await sentReader!.read();
      if (next.done) {
        sentPayload += sentDecoder.decode();
        break;
      }
      sentPayload += sentDecoder.decode(next.value, { stream: true });
    }

    const auditEvents = await waitForAuditEvents(app.server, "message.cancelled");
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        type: "message.cancelled",
        metadata: expect.objectContaining({
          runId,
          reason: "test cancellation"
        })
      })
    );

    const streamedPrefix = parseSseChunks(sentPayload)
      .filter((chunk) => chunk.type === "message_delta")
      .map((chunk) => chunk.payload?.delta ?? "")
      .join("");
    expect(streamedPrefix.length).toBeGreaterThan(0);
    const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
    expect(messages.status).toBe(200);
    const assistantMessages = ((await messages.json()) as Array<{
      role: string;
      text: string;
      metadata?: { agentRuntime?: Record<string, unknown> };
    }>).filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      text: streamedPrefix,
      metadata: {
        agentRuntime: {
          kind: "assistant_final",
          runId,
          finishStatus: "cancelled",
          cancellationReason: "test cancellation"
        }
      }
    });

    const snapshot = await fetch(`${baseUrl}/api/conversations/${conversation.id}/thread`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      messages: [
        expect.objectContaining({
          role: "user"
        }),
        expect.objectContaining({
          role: "assistant",
          text: streamedPrefix
        })
      ]
    });

    await app.close();
  });

  it("rejects a second send during an active run before appending a user message or claiming drafts", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Active run guard" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    await app.server.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const activePrompt = Array.from({ length: 40 }, (_, index) => `token-${index}`).join(" ");
    const firstRun = await fetchStartConversationRun(baseUrl, conversation.id, activePrompt, {
      idempotencyKey: "active-run-first"
    });

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "second-send-draft.txt",
      contentType: "text/plain",
      content: "This draft must remain unclaimed when the send is rejected."
    });
    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadedBody = uploaded.json() as { attachment: { id: string } };
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const rejectedSend = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "active-run-second",
        message: {
          text: "this second send should not be persisted"
        }
      })
    });
    expect(rejectedSend.status).toBe(409);
    await rejectedSend.text();
    await fetchRunEvents(baseUrl, conversation.id, firstRun.run.id);

    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json() as Array<{ role: string; text: string }>;
    const userMessages = persistedMessages.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.text).toBe(activePrompt);
    expect(persistedMessages).not.toContainEqual(
      expect.objectContaining({
        role: "user",
        text: "this second send should not be persisted"
      })
    );

    const drafts = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/draft-attachments`
    });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json()).toContainEqual(
      expect.objectContaining({
        id: uploadedBody.attachment.id,
        status: "ready"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    const messageCreatedEvents = (audit.json() as Array<{ type: string; metadata?: { conversationId?: string } }>)
      .filter(
        (event) =>
          event.type === "message.created" && event.metadata?.conversationId === conversation.id
      );
    expect(messageCreatedEvents).toHaveLength(1);

    await app.close();
  });

  it("cancels the current conversation run instead of letting the stream complete in the background", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    try {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/conversations",
        payload: { title: "Cancel stream test" }
      });
      expect(created.statusCode).toBe(200);
      const conversation = created.json() as { id: string };

      await app.server.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const messageTokens = Array.from({ length: 240 }, (_, index) => `cancel-token-${index}`);
      const lateToken = messageTokens.at(-1) ?? "";

      const started = await fetchStartConversationRun(baseUrl, conversation.id, messageTokens.join(" "));
      const runId = started.run.id;

      const cancelled = await fetch(`${baseUrl}/api/conversations/${conversation.id}/runs/${runId}/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ reason: "test cancellation" })
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({
        run: {
          id: runId,
          status: "cancelled"
        }
      });

      const chunks = parseSseChunks(await fetchRunEvents(baseUrl, conversation.id, runId));
      expect(chunks.some((chunk) => chunk.type === "run_cancelled")).toBe(true);
      expect(chunks.map((chunk) => chunk.payload?.delta ?? "").join("")).not.toContain(lateToken);

      await new Promise((resolve) => {
        setTimeout(resolve, 6_000);
      });

      const messages = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
      expect(messages.status).toBe(200);
      const persistedMessages = (await messages.json()) as Array<{ role: string; text: string }>;
      const assistantText = persistedMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n");
      expect(assistantText).not.toContain(lateToken);
    } finally {
      await app.close();
    }
  }, 12_000);

  it("rejects messages after the configured daily model call limit is reached", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        usageSafeguards: {
          modelCallsPerDay: 1
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Usage limit test" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const firstMessage = await injectStartConversationRun(app.server, conversation.id, "hello", {
      idempotencyKey: "usage-limit-first"
    });
    await drainRunEvents(app.server, conversation.id, firstMessage.run.id);

    const secondMessage = await injectStartConversationRun(app.server, conversation.id, "hello again", {
      idempotencyKey: "usage-limit-second"
    });
    const failedEvents = parseSseChunks(
      await drainRunEvents(app.server, conversation.id, secondMessage.run.id)
    );
    expect(failedEvents).toContainEqual(
      expect.objectContaining({
        type: "run_failed",
        payload: expect.objectContaining({
          error: expect.objectContaining({
            message: "Daily model call safeguard has been reached"
          })
        })
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "message.failed",
        metadata: expect.objectContaining({
          errorCategory: "app_error",
          errorCode: "FORBIDDEN"
        })
      })
    );

    await app.close();
  });

  it("exposes configured agent welcome message and initial prompts through safe config", async () => {
    const initialPrompts = [
      {
        title: "Review release",
        prompt: "Summarize release readiness."
      }
    ];
    const welcomeMessage = "What should we review first?";
    const app = await createClientInstanceApp({
      config: createTestConfig({ welcomeMessage, initialPrompts }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const response = await app.server.inject({
      method: "GET",
      url: "/api/config"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agents: [
        expect.objectContaining({
          name: "test_agent",
          welcomeMessage,
          initialPrompts
        })
      ]
    });

    await app.close();
  });

  it("resolves localized agent content in safe config", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        displayName: {
          en: "Application Assistant",
          de: "Antragsassistent"
        },
        welcomeMessage: {
          en: "How can I help with the financing workflow?",
          de: "Wie kann ich beim Finanzierungsworkflow helfen?"
        },
        initialPrompts: [
          {
            title: {
              en: "Summarize documents",
              de: "Dokumente zusammenfassen"
            },
            prompt: {
              en: "Summarize the documents.",
              de: "Fasse die Dokumente zusammen."
            }
          }
        ]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const response = await app.server.inject({
      method: "GET",
      url: "/api/config?locale=de"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      localization: {
        locale: "de",
        defaultLocale: "en",
        supportedLocales: ["en", "de"]
      },
      agents: [
        expect.objectContaining({
          displayName: "Antragsassistent",
          welcomeMessage: "Wie kann ich beim Finanzierungsworkflow helfen?",
          initialPrompts: [
            {
              title: "Dokumente zusammenfassen",
              prompt: "Fasse die Dokumente zusammen."
            }
          ]
        })
      ]
    });

    await app.close();
  });

  it("generates a short conversation headline from the first user message", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const firstMessage = "Please summarize the release notes";
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: firstMessage }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await injectStartConversationRun(app.server, conversation.id, firstMessage, {
      idempotencyKey: "title-generation-run"
    });
    await drainRunEvents(app.server, conversation.id, sent.run.id);

    const generatedTitle = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/title`
    });
    expect(generatedTitle.statusCode).toBe(200);
    expect(generatedTitle.json()).toMatchObject({
      id: conversation.id,
      title: "Please Summarize The Release Notes"
    });

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize The Release Notes"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).some((event) => event.type === "conversation.title_generated")).toBe(
      true
    );

    await app.close();
  });

  it("replaces a file-drop placeholder title from the first user message", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const filenameTitle = "Theo - Boardingpass - Y123.txt";
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: filenameTitle }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: filenameTitle,
      contentType: "text/plain",
      content: "Boarding pass fixture"
    });
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/conversations/${conversation.id}/draft-attachments`,
          headers: upload.headers,
          payload: upload.payload
        })
      ).statusCode
    ).toBe(200);
    await waitForReadyDraftAttachment(app.server, conversation.id);

    const sent = await injectStartConversationRun(
      app.server,
      conversation.id,
      "Please summarize this boarding pass",
      {
        idempotencyKey: "attachment-title-generation-run"
      }
    );
    await drainRunEvents(app.server, conversation.id, sent.run.id);

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Please Summarize This Boarding Pass"
      })
    );

    await app.close();
  });

  it("serves authenticated inline content for ready image attachments", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [createTestAttachmentCapability()],
      tools: []
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Image upload" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "receipt.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as { attachment: { fileId: string; status: string; format: string } };
    expect(body.attachment).toMatchObject({
      status: "ready",
      format: "gif"
    });

    const content = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });

    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("image/gif");
    expect(content.payload).toBe("GIF89a");

    await app.close();
  });

  it("serves promoted managed artifacts as conversation-scoped downloads", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const owner = createTestUser("user-1", clientInstanceId);
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    });
    const readArtifacts: Array<{ clientInstanceId: string; artifactId: string }> = [];
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
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      managedObjects: {
        async readArtifact(input) {
          readArtifacts.push(input);
          return {
            bytes: new TextEncoder().encode("final,report\n"),
            mimeType: "text/csv"
          };
        }
      }
    });
    try {
      const conversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: owner.id,
        ownerExternalUserId: owner.externalUserId,
        title: "Artifact download",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const otherConversation = await store.createConversation({
        clientInstanceId,
        ownerUserId: owner.id,
        ownerExternalUserId: owner.externalUserId,
        title: "Other conversation",
        retainedUntil: "2030-01-01T00:00:00.000Z"
      });
      const artifact = await store.createManagedArtifact({
        clientInstanceId,
        conversationId: conversation.id,
        kind: "document.csv",
        objectKey: "execution-workspaces/private/final.csv",
        filename: "final \u00e4.csv",
        mimeType: "text/csv",
        byteSize: 13,
        checksum: "sha256:final",
        metadata: {
          source: "execution_workspace"
        }
      });

      const content = await server.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/artifacts/${artifact.id}/content`
      });

      expect(content.statusCode).toBe(200);
      expect(content.headers["content-type"]).toContain("text/csv");
      expect(content.headers["content-disposition"]).toBe(
        'attachment; filename="final _.csv"; filename*=UTF-8\'\'final%20%C3%A4.csv'
      );
      expect(content.payload).toBe("final,report\n");
      expect(JSON.stringify(content.headers)).not.toContain("execution-workspaces/private");
      expect(readArtifacts).toEqual([
        {
          clientInstanceId,
          artifactId: artifact.id
        }
      ]);

      const wrongConversation = await server.inject({
        method: "GET",
        url: `/api/conversations/${otherConversation.id}/artifacts/${artifact.id}/content`
      });
      expect(wrongConversation.statusCode).toBe(404);
      expect(readArtifacts).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("deletes attachment bytes when deleting a conversation", async () => {
    const deletedFileObjectKeys: string[] = [];
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      capabilities: [
        createTestAttachmentCapability({
          onConversationAttachmentsDeleted(deletion) {
            deletedFileObjectKeys.push(...deletion.fileObjectKeys);
          }
        })
      ],
      tools: []
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Attachment retention" }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };
    const upload = createMultipartFilePayload({
      fieldName: "file",
      filename: "retention.gif",
      contentType: "image/gif",
      content: "GIF89a"
    });

    const uploaded = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/draft-attachments`,
      headers: upload.headers,
      payload: upload.payload
    });
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as { attachment: { fileId: string } };
    const contentBeforeDelete = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });
    expect(contentBeforeDelete.statusCode).toBe(200);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/conversations/${conversation.id}`
    });
    expect(deleted.statusCode).toBe(200);
    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.deleted",
        metadata: expect.objectContaining({
          attachmentCount: 1,
          fileCount: 1
        })
      })
    );
    expect(deletedFileObjectKeys).toEqual([body.attachment.fileId]);

    const contentAfterDelete = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/files/${body.attachment.fileId}/content`
    });
    expect(contentAfterDelete.statusCode).toBe(404);

    await app.close();
  });

  it("generates a title when the first user message invokes a tool", async () => {
    const config = createTestConfig({
      tools: [{ name: "demo.echo", enabled: true }],
      toolNames: ["demo.echo"]
    });
    const tool = defineTool({
      name: "demo.echo",
      description: "Echo text for tests.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
      async execute(input) {
        return toolSuccess({ echoed: input.text });
      }
    });
    const app = await createClientInstanceApp({
      config,
      env: {},
      storeMode: "memory",
      tools: [tool]
    });
    const firstMessage = '/tool demo.echo {"text":"boarding pass"}';
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: firstMessage }
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json() as { id: string };

    const sent = await injectStartConversationRun(app.server, conversation.id, firstMessage, {
      idempotencyKey: "tool-title-generation-run"
    });
    await drainRunEvents(app.server, conversation.id, sent.run.id);

    const listed = await app.server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toContainEqual(
      expect.objectContaining({
        id: conversation.id,
        title: "Tool result review"
      })
    );

    await app.close();
  });

  it("switches between configured development users without exposing a dev-user listing route", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "usage-viewer-1",
              externalUserId: "usage-viewer-1",
              displayLabel: "Usage Viewer",
              roles: ["user"],
              permissionRefs: ["demo-tools"],
              permissions: ["usage.view"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const developmentUsersRoute = await app.server.inject({
      method: "GET",
      url: "/auth/development/users"
    });
    expect(developmentUsersRoute.statusCode).toBe(404);

    const defaultMe = await app.server.inject({
      method: "GET",
      url: "/api/me"
    });
    expect(defaultMe.statusCode).toBe(200);
    expect(defaultMe.json()).toMatchObject({
      displayLabel: "Superadmin",
      externalUserId: "superadmin-1",
      roles: ["user", "admin", "superadmin"],
      permissions: PERMISSIONS.filter((permission) => permission !== "config_assets.release")
    });

    const normalMe = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalMe.statusCode).toBe(200);
    expect(normalMe.json()).toMatchObject({
      displayLabel: "Normal User",
      externalUserId: "user-1",
      roles: ["user"],
      permissions: []
    });

    const normalUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalUsage.statusCode).toBe(403);

    const grantedUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "usage-viewer-1"
      }
    });
    expect(grantedUsage.statusCode).toBe(200);

    const unknownUser = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "missing-user"
      }
    });
    expect(unknownUser.statusCode).toBe(401);

    await app.close();
  });

  it("lets a user update their own profile without changing authorization fields", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "user-1",
              externalUserId: "user-1",
              displayLabel: "Normal User",
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const updated = await app.server.inject({
      method: "PATCH",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "user-1"
      },
      payload: {
        displayLabel: "Updated User",
        email: "escalation@example.test",
        roles: ["superadmin"]
      }
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody = updated.json() as { displayLabel: string; email?: string; roles: string[] };
    expect(updatedBody).toMatchObject({
      displayLabel: "Updated User",
      roles: ["user"]
    });
    expect(updatedBody.email).not.toBe("escalation@example.test");

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.profile_updated"])
    );

    await app.close();
  });

  it("rejects self-service password changes outside standalone auth", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const changed = await app.server.inject({
      method: "POST",
      url: "/api/me/password",
      payload: {
        currentPassword: "old-password",
        newPassword: "new-password"
      }
    });
    expect(changed.statusCode).toBe(422);
    expect((changed.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });

  it("lets a signed-in user delete their own account and owned conversations", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    });
    const user = await store.resolveUserIdentity({
      clientInstanceId,
      authSource: STANDALONE_AUTH_SOURCE,
      externalUserId: "auth-delete-me",
      displayLabel: "Delete Me",
      email: "delete-me@example.test",
      emailVerified: true,
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      correlationId: "corr_delete_me"
    });
    const otherUser = await store.resolveUserIdentity({
      clientInstanceId,
      authSource: "development",
      externalUserId: "other-user",
      displayLabel: "Other User",
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      correlationId: "corr_other"
    });
    const conversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: user.id,
      ownerExternalUserId: user.externalUserId,
      title: "Delete this conversation",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    await store.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "remove this message"
    });
    const otherConversation = await store.createConversation({
      clientInstanceId,
      ownerUserId: otherUser.id,
      ownerExternalUserId: otherUser.externalUserId,
      title: "Keep this conversation",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const deletedPasswordSignIns: Array<{ externalUserId: string }> = [];
    const server = await createChatServer({
      config,
      clientInstanceId,
      authAdapter: {
        id: "test-auth",
        async authenticate(request) {
          if (request.headers["x-service-principal"]) {
            return {
              ...user,
              scopes: ["*"],
              principal: {
                kind: "service",
                id: "svc-customer-api",
                displayLabel: "Customer API",
                clientInstanceId,
                authSource: "customer-api"
              },
              delegatedActor: {
                kind: "service_principal",
                id: "svc-customer-api",
                authSource: "customer-api"
              }
            };
          }
          return { ...user, scopes: ["*"] };
        }
      },
      conversationStore: store,
      auditEventStore: store,
      userStore: store,
      usageGovernance,
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      standaloneAuth: {
        baseUrl: "http://127.0.0.1:4100/api/auth",
        async handleRequest() {
          return new Response(null, { status: 404 });
        },
        async setPassword() {},
        async setOrCreatePasswordSignIn() {
          throw new AppError("INTERNAL", "Password sign-in should not be created");
        },
        async changePassword() {},
        async deletePasswordSignIn(input) {
          deletedPasswordSignIns.push(input);
        }
      }
    });

    const delegatedDelete = await server.inject({
      method: "DELETE",
      url: "/api/me",
      headers: {
        "x-service-principal": "1"
      }
    });
    expect(delegatedDelete.statusCode).toBe(403);

    const deleted = await server.inject({
      method: "DELETE",
      url: "/api/me"
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    expect(deletedPasswordSignIns).toEqual([{ externalUserId: "auth-delete-me" }]);

    await expect(store.listUsers({ clientInstanceId })).resolves.not.toContainEqual(
      expect.objectContaining({ id: user.id })
    );
    await expect(store.getConversation(clientInstanceId, conversation.id)).resolves.toMatchObject({
      status: "deleted"
    });
    await expect(store.getConversation(clientInstanceId, otherConversation.id)).resolves.toMatchObject({
      status: "active"
    });
    await expect(
      store.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    const audit = await store.listAuditEvents({ clientInstanceId });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "conversation.deleted",
          metadata: expect.objectContaining({
            requestedBy: "account_deletion"
          })
        }),
        expect.objectContaining({
          type: "user.deleted",
          metadata: expect.objectContaining({
            requestedBy: "self",
            conversationCount: 1
          })
        })
      ])
    );

    await server.close();
  });

  it("lets admins administer non-superadmin users without escalating superadmin access", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "admin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "admin-1",
              externalUserId: "admin-1",
              displayLabel: "Admin",
              roles: ["user", "admin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const seededSuperadmin = await app.server.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(seededSuperadmin.statusCode).toBe(200);

    const usersBefore = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    const usersBeforeBody = usersBefore.json() as Array<{ id: string; roles: string[] }>;
    const superadminUser = usersBeforeBody.find((user) => user.roles.includes("superadmin"));
    expect(superadminUser).toBeUndefined();

    const superadminVisibleUsers = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(superadminVisibleUsers.statusCode).toBe(200);
    const superadminVisibleUsersBody = superadminVisibleUsers.json() as Array<{
      id: string;
      roles: string[];
    }>;
    const superadminManagedUser = superadminVisibleUsersBody.find((user) =>
      user.roles.includes("superadmin")
    );
    expect(superadminManagedUser).toBeDefined();

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Admin Created User",
        email: "admin-created@example.test",
        roles: ["user", "admin"],
        permissionRefs: ["demo-tools"],
        permissions: ["config_assets.write"]
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ permissions: ["config_assets.write"] });
    const createdUser = created.json() as { id: string };

    const releasePermissionCreate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Release User",
        roles: ["user"],
        permissions: ["config_assets.release"]
      }
    });
    expect(releasePermissionCreate.statusCode).toBe(422);
    expect(releasePermissionCreate.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: "Release permission can only be carried by service tokens"
      }
    });

    const releasePermissionUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${createdUser.id}`,
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        permissions: ["config_assets.release"]
      }
    });
    expect(releasePermissionUpdate.statusCode).toBe(422);
    expect(releasePermissionUpdate.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const escalatedCreate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        displayLabel: "Escalated User",
        roles: ["user", "admin", "superadmin"]
      }
    });
    expect(escalatedCreate.statusCode).toBe(403);
    expect((escalatedCreate.json() as { error: { message: string } }).error.message).toContain(
      "Only superadmins can assign superadmin access"
    );

    const escalatedUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${createdUser.id}`,
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        roles: ["user", "admin", "superadmin"]
      }
    });
    expect(escalatedUpdate.statusCode).toBe(403);

    const superadminUpdate = await app.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${superadminManagedUser?.id}`,
      headers: {
        "x-dev-user-id": "admin-1"
      },
      payload: {
        status: "disabled"
      }
    });
    expect(superadminUpdate.statusCode).toBe(403);
    expect((superadminUpdate.json() as { error: { message: string } }).error.message).toContain(
      "Only superadmins can manage superadmin users"
    );

    const adminDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/superadmin/users/${createdUser.id}`,
      headers: {
        "x-dev-user-id": "admin-1"
      }
    });
    expect(adminDelete.statusCode).toBe(403);
    expect((adminDelete.json() as { error: { message: string } }).error.message).toContain(
      "superadmin role"
    );

    const selfDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/superadmin/users/${superadminManagedUser?.id}`,
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(selfDelete.statusCode).toBe(422);
    expect((selfDelete.json() as { error: { message: string } }).error.message).toContain(
      "cannot delete their own user account"
    );

    await app.close();
  });

  it("administers users and shares conversations across linked auth identities", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const usersBefore = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(usersBefore.statusCode).toBe(200);
    expect(usersBefore.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayLabel: "Superadmin",
          identities: [
            expect.objectContaining({
              authSource: "development",
              externalUserId: "superadmin-1"
            })
          ]
        })
      ])
    );

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    for (const identity of [
      {
        authSource: "session-token",
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true
      },
      {
        authSource: "development",
        externalUserId: "jane-dev",
        displayLabel: "Jane Standalone",
        email: "jane@example.test",
        emailVerified: true
      }
    ]) {
      const linked = await app.server.inject({
        method: "PUT",
        url: `/api/superadmin/users/${administeredUser.id}/identities`,
        headers: {
          "x-dev-user-id": "superadmin-1"
        },
        payload: identity
      });
      expect(linked.statusCode).toBe(200);
    }

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared context"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.created", "user.identity_upserted"])
    );

    await app.close();
  });

  it("automatically links identities with a matching verified email to one shared user", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            },
            {
              id: "jane-dev-source",
              externalUserId: "jane-dev",
              displayLabel: "Jane Standalone",
              email: "jane@example.test",
              emailVerified: true,
              roles: ["user"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Shared by verified email"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as { id: string; ownerUserId: string };
    expect(conversation.ownerUserId).toBe(administeredUser.id);

    const standaloneConversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        "x-dev-user-id": "jane-dev-source"
      }
    });
    expect(standaloneConversations.statusCode).toBe(200);
    expect(standaloneConversations.json()).toEqual([
      expect.objectContaining({
        id: conversation.id,
        ownerUserId: administeredUser.id
      })
    ]);

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.identity_linked"])
    );

    const duplicate = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      headers: {
        "x-dev-user-id": "superadmin-1"
      },
      payload: {
        displayLabel: "Jane Duplicate",
        email: "jane@example.test",
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(duplicate.statusCode).toBe(200);

    const ambiguousIssued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane-other",
        displayLabel: "Jane Other",
        email: "jane@example.test",
        emailVerified: true,
        roles: ["user"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(ambiguousIssued.statusCode).toBe(200);
    const ambiguousToken = (ambiguousIssued.json() as { chatSessionToken: string }).chatSessionToken;

    const ambiguousConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${ambiguousToken}`
      },
      payload: {
        title: "Ambiguous email must not share history"
      }
    });
    expect(ambiguousConversation.statusCode).toBe(200);
    expect((ambiguousConversation.json() as { ownerUserId: string }).ownerUserId).not.toBe(
      administeredUser.id
    );

    await app.close();
  });

  it("keeps chat session tokens scoped away from governance routes despite elevated roles", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-admin",
        displayLabel: "Customer Admin",
        roles: ["user", "admin", "superadmin"],
        permissionRefs: ["demo-tools"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const conversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(conversations.statusCode).toBe(200);

    const usage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(usage.statusCode).toBe(403);
    expect((usage.json() as { error: { message: string } }).error.message).toContain(
      "Missing auth scope 'governance:read'"
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(audit.statusCode).toBe(403);

    await app.close();
  });

  it("honors explicit chat session token scopes for conversation writes", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "read-only-user",
        displayLabel: "Read Only User",
        roles: ["user"],
        permissionRefs: ["demo-tools"],
        scopes: ["conversation:read"]
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const conversations = await app.server.inject({
      method: "GET",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      }
    });
    expect(conversations.statusCode).toBe(200);

    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Should not be created"
      }
    });
    expect(created.statusCode).toBe(403);
    expect((created.json() as { error: { message: string } }).error.message).toContain(
      "Missing auth scope 'conversation:write'"
    );

    await app.close();
  });

  it("audits delegated service-principal conversation actions for the subject user", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        sessionToken: {
          issuer: "demo-client-instance",
          ttlSeconds: 900
        },
        developmentAuth: {
          enabled: true,
          defaultUserId: "superadmin-1",
          users: [
            {
              id: "superadmin-1",
              externalUserId: "superadmin-1",
              displayLabel: "Superadmin",
              roles: ["user", "admin", "superadmin"],
              permissionRefs: ["demo-tools"]
            }
          ]
        }
      }),
      env: {
        CHAT_SESSION_TOKEN_SECRET: "a-development-session-token-secret",
        CHAT_SERVER_CREDENTIAL: "server-credential"
      },
      storeMode: "memory",
      tools: []
    });

    const issued = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/session-tokens",
      headers: {
        "x-server-credential": "server-credential"
      },
      payload: {
        externalUserId: "customer-jane",
        displayLabel: "Jane Reviewer",
        roles: ["user"],
        permissionRefs: ["demo-tools"],
        delegatedActor: {
          kind: "service_principal",
          id: "svc-customer-api",
          displayLabel: "Customer API",
          authSource: "customer-app"
        }
      }
    });
    expect(issued.statusCode).toBe(200);
    const token = (issued.json() as { chatSessionToken: string }).chatSessionToken;

    const createdConversation = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        title: "Delegated action"
      }
    });
    expect(createdConversation.statusCode).toBe(200);
    const conversation = createdConversation.json() as {
      id: string;
      ownerUserId: string;
      ownerExternalUserId: string;
    };
    expect(conversation.ownerExternalUserId).toBe("customer-jane");
    expect(conversation.ownerUserId).not.toBe("svc-customer-api");

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events",
      headers: {
        "x-dev-user-id": "superadmin-1"
      }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toContainEqual(
      expect.objectContaining({
        type: "conversation.created",
        subject: conversation.id,
        actor: expect.objectContaining({
          userId: conversation.ownerUserId,
          principalKind: "service",
          principalId: "svc-customer-api",
          principalDisplayLabel: "Customer API",
          subjectUserId: conversation.ownerUserId,
          delegatedActor: expect.objectContaining({
            kind: "service_principal",
            id: "svc-customer-api",
            authSource: "customer-app"
          })
        })
      })
    );

    await app.close();
  });

  it("creates and resets standalone password sign-ins from superadmin user administration", async () => {
    const clientInstanceId = asClientInstanceId("demo-local");
    const store = new InMemoryPlatformStore();
    const config = createTestConfig();
    const usageGovernance = new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    });
    const createdPasswordSignIns: Array<{
      email: string;
      displayLabel: string;
      password: string;
    }> = [];
    const resetPasswords: Array<{ externalUserId: string; password: string }> = [];
    const deletedPasswordSignIns: Array<{ externalUserId: string }> = [];
    const server = await createChatServer({
      config,
      clientInstanceId,
      authAdapter: {
        id: "test-auth",
        async authenticate() {
          return createTestUser("superadmin-1", clientInstanceId);
        }
      },
      conversationStore: store,
      auditEventStore: store,
      userStore: store,
      usageGovernance,
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store }),
      agentRuntime: createMissingRuntime(),
      modelProvider: createUnusedModelProvider(),
      standaloneAuth: {
        baseUrl: "http://127.0.0.1:4100/api/auth",
        async handleRequest() {
          return new Response(null, { status: 404 });
        },
        async setOrCreatePasswordSignIn(input) {
          createdPasswordSignIns.push({
            email: input.email,
            displayLabel: input.displayLabel,
            password: input.password
          });
          return {
            externalUserId: `auth-${input.email}`,
            displayLabel: input.displayLabel,
            email: input.email.toLowerCase(),
            emailVerified: true
          };
        },
        async setPassword(input) {
          resetPasswords.push(input);
        },
        async changePassword() {},
        async deletePasswordSignIn(input) {
          deletedPasswordSignIns.push(input);
        }
      }
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: {
        displayLabel: "Jane Reviewer",
        email: "Jane@Example.Test",
        roles: ["user", "admin"],
        permissionRefs: ["demo-tools"],
        passwordSignIn: {
          password: "initial-password"
        }
      }
    });
    expect(created.statusCode).toBe(200);
    const createdUser = created.json() as {
      id: string;
      identities: Array<{ authSource: string; externalUserId: string; email?: string }>;
    };
    expect(createdPasswordSignIns).toEqual([
      {
        email: "Jane@Example.Test",
        displayLabel: "Jane Reviewer",
        password: "initial-password"
      }
    ]);
    expect(createdUser.identities).toEqual([
      expect.objectContaining({
        authSource: "better-auth",
        externalUserId: "auth-Jane@Example.Test",
        email: "jane@example.test"
      })
    ]);

    const reset = await server.inject({
      method: "POST",
      url: `/api/superadmin/users/${createdUser.id}/password`,
      payload: {
        password: "replacement-password"
      }
    });
    expect(reset.statusCode).toBe(200);
    expect(resetPasswords).toEqual([
      {
        externalUserId: "auth-Jane@Example.Test",
        password: "replacement-password"
      }
    ]);

    const profileOnly = await server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: {
        displayLabel: "Sam Reviewer",
        email: "sam@example.test",
        roles: ["user"]
      }
    });
    expect(profileOnly.statusCode).toBe(200);
    const profileOnlyUser = profileOnly.json() as { id: string };

    const setFirstPassword = await server.inject({
      method: "POST",
      url: `/api/superadmin/users/${profileOnlyUser.id}/password`,
      payload: {
        password: "first-password"
      }
    });
    expect(setFirstPassword.statusCode).toBe(200);
    expect(createdPasswordSignIns).toContainEqual({
      email: "sam@example.test",
      displayLabel: "Sam Reviewer",
      password: "first-password"
    });

    const listed = await server.inject({
      method: "GET",
      url: "/api/superadmin/users"
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: profileOnlyUser.id,
          identities: [
            expect.objectContaining({
              authSource: "better-auth",
              externalUserId: "auth-sam@example.test"
            })
          ]
        })
      ])
    );

    const audit = await server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.password_sign_in_created", "user.password_reset"])
    );

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/superadmin/users/${createdUser.id}`
    });
    expect(deleted.statusCode).toBe(200);
    expect(deletedPasswordSignIns).toEqual([{ externalUserId: "auth-Jane@Example.Test" }]);

    const listedAfterDelete = await server.inject({
      method: "GET",
      url: "/api/superadmin/users"
    });
    expect(listedAfterDelete.statusCode).toBe(200);
    expect(listedAfterDelete.json()).not.toContainEqual(
      expect.objectContaining({
        id: createdUser.id
      })
    );

    const auditAfterDelete = await server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(auditAfterDelete.statusCode).toBe(200);
    expect((auditAfterDelete.json() as Array<{ type: string }>).map((event) => event.type)).toEqual(
      expect.arrayContaining(["governance.user_delete_authorized", "user.deleted"])
    );

    await server.close();
  });

  it("rejects password resets when standalone auth is not enabled", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });

    const created = await app.server.inject({
      method: "POST",
      url: "/api/superadmin/users",
      payload: {
        displayLabel: "Jane Reviewer",
        roles: ["user"]
      }
    });
    expect(created.statusCode).toBe(200);
    const administeredUser = created.json() as { id: string };

    const reset = await app.server.inject({
      method: "POST",
      url: `/api/superadmin/users/${administeredUser.id}/password`,
      payload: {
        password: "replacement-password"
      }
    });
    expect(reset.statusCode).toBe(422);
    expect((reset.json() as { error: { message: string } }).error.message).toContain(
      "standalone auth"
    );

    await app.close();
  });

  it("rejects startup when an agent references an unregistered tool implementation", async () => {
    await expect(
      createClientInstanceApp({
        config: createTestConfig({
          tools: [{ name: "demo.echo", enabled: true }],
          toolNames: ["demo.echo"]
        }),
        env: {},
        storeMode: "memory",
        tools: []
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Client instance assembly is invalid"
    });
  });

  it("registers workspace tools through the client assembly path", async () => {
    const workspaceToolNames = [
      "workspace.exec",
      "workspace.list_files",
      "workspace.import_files",
      "workspace.read_file",
      "workspace.promote_artifact",
      "workspace.preview_images"
    ];
    const app = await createClientInstanceApp({
      config: createTestConfig({
        tools: workspaceToolNames.map((name) => ({ name, enabled: true })),
        toolNames: workspaceToolNames,
        executionWorkspaces: {
          enabled: true
        }
      }),
      env: {
        EXECUTION_WORKSPACE_OBJECT_ROOT: "/tmp/vivd-catalyst-test-workspace-objects"
      },
      storeMode: "memory",
      tools: []
    });

    await app.close();
  });

  it("rejects startup without DATABASE_URL unless memory mode is explicit", async () => {
    await expect(
      createClientInstanceApp({
        config: createTestConfig(),
        env: {},
        tools: []
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "DATABASE_URL is required for the platform store; set STORE=memory only for explicit local/test memory mode"
    });
  });

  it("rejects startup when an enabled tool requires approval before resume support exists", async () => {
    const approvalTool = defineTool({
      name: "demo.approval",
      description: "Approval-only test tool.",
      inputSchema: z.object({}),
      permission: {
        mode: "approval_required",
        reason: "Needs approval"
      },
      async execute() {
        return toolSuccess({});
      }
    });

    await expect(
      createClientInstanceApp({
        config: createTestConfig({
          tools: [{ name: "demo.approval", enabled: true }],
          toolNames: ["demo.approval"]
        }),
        env: {},
        storeMode: "memory",
        tools: [approvalTool]
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Client instance assembly is invalid"
    });
  });

  it("rejects spend budgets without pricing for configured provider models", () => {
    expect(() =>
      createTestConfig({
        modelProviders: [
          {
            id: "openai",
            type: "openai-compatible",
            model: "gpt-4.1",
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnvName: "OPENAI_API_KEY"
          }
        ],
        usageBudget: {
          monthlySpendLimit: 200,
          costSafetyMultiplier: 1.3
        },
        usagePricing: {
          currency: "USD",
          models: []
        }
      })
    ).toThrow("Spend budget requires configured pricing for model openai/gpt-4.1");
  });

});

type LocalizedTestString =
  | string
  | {
      en?: string;
      de?: string;
    };

async function createStaleRunRecoveryFixture(
  input: {
    staleActiveRunMs?: number;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("demo-local");
  const owner = createTestUser("user-1", clientInstanceId);
  const store = new InMemoryPlatformStore();
  const config = createTestConfig();
  const usageGovernance = new ModelUsageGovernance({
    store,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    pricing: config.usage.pricing
  });
  const options: ChatServerOptions = {
    config,
    clientInstanceId,
    authAdapter: {
      id: "test-auth",
      async authenticate(request) {
        const rawUserId = request.headers["x-test-user"];
        const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
        return createTestUser(userId ?? owner.id, clientInstanceId);
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
      staleActiveRunMs: input.staleActiveRunMs ?? 1,
      runOnStartup: false,
      watchdogIntervalMs: 60_000
    }
  };
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId: owner.id,
    ownerExternalUserId: owner.externalUserId,
    title: "Recovered run",
    retainedUntil: "2030-01-01T00:00:00.000Z"
  });
  const message = await store.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: "recover this stale run"
  });
  const run = await createPersistedRecoveryRun(
    { store, clientInstanceId, owner, conversation, message },
    {
      status: "running"
    }
  );
  const server = await createChatServer(options);
  return {
    clientInstanceId,
    conversation,
    message,
    options,
    owner,
    run,
    server,
    store
  };
}

async function createPersistedRecoveryRun(
  fixture: {
    store: InMemoryPlatformStore;
    clientInstanceId: ReturnType<typeof asClientInstanceId>;
    owner: AuthenticatedUser;
    conversation?: { id: AgentRun["conversationId"] };
    message?: ChatMessage;
  },
  input: { status: AgentRun["status"] }
): Promise<AgentRun> {
  const conversation =
    fixture.conversation ??
    (await fixture.store.createConversation({
      clientInstanceId: fixture.clientInstanceId,
      ownerUserId: fixture.owner.id,
      ownerExternalUserId: fixture.owner.externalUserId,
      title: `Recovered ${input.status}`,
      retainedUntil: "2030-01-01T00:00:00.000Z"
    }));
  const message =
    fixture.message ??
    (await fixture.store.appendMessage({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: `recover ${input.status}`
    }));
  const run = await fixture.store.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId: fixture.clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: fixture.owner.id,
    inputMessageId: message.id,
    agentName: "test_agent",
    correlationId: `corr-${input.status}`,
    startedAt: "2020-01-01T00:00:00.000Z"
  });
  await fixture.store.appendRunObservation({
    clientInstanceId: fixture.clientInstanceId,
    runId: run.id,
    conversationId: conversation.id,
    ownerUserId: fixture.owner.id,
    event: {
      type: "message_delta",
      runId: run.id,
      sequence: 1,
      createdAt: "2020-01-01T00:00:01.000Z",
      delta: "before restart"
    }
  });
  if (input.status === "running") {
    return (await fixture.store.getAgentRun({
      clientInstanceId: fixture.clientInstanceId,
      runId: run.id
    })) as AgentRun;
  }

  const terminalAt = "2020-01-01T00:00:02.000Z";
  return fixture.store.updateAgentRunStatus({
    clientInstanceId: fixture.clientInstanceId,
    runId: run.id,
    status: input.status,
    updatedAt: terminalAt,
    lastSequence: 1,
    ...(input.status === "completed" ? { completedAt: terminalAt } : {}),
    ...(input.status === "cancelled" ? { cancelledAt: terminalAt } : {}),
    ...(input.status === "failed"
      ? {
          failedAt: terminalAt,
          error: {
            code: "TEST_FAILURE",
            message: "Test failure",
            category: "app_error"
          }
        }
      : {})
  });
}

async function expectRunStatus(
  store: InMemoryPlatformStore,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  runId: AgentRun["id"],
  status: AgentRun["status"]
): Promise<void> {
  await expect(store.getAgentRun({ clientInstanceId, runId })).resolves.toMatchObject({ status });
}

function createTestUser(
  id: string,
  clientInstanceId: ReturnType<typeof asClientInstanceId>
): AuthenticatedUser {
  return {
    id,
    externalUserId: id,
    displayLabel: id === "user-1" ? "User" : "Other user",
    roles: ["user", "admin", "superadmin"],
    permissionRefs: ["demo-tools"],
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  };
}

function createMissingRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async *observe() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async getStatus() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async resume() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    },
    async cancel() {
      throw new AppError("NOT_FOUND", "Agent runtime has no local run state");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by recovery tests");
    }
  };
}

function createTestConfig(input: {
  toolNames?: string[];
  tools?: Array<{ name: string; enabled?: boolean }>;
  displayName?: LocalizedTestString;
  welcomeMessage?: LocalizedTestString;
  initialPrompts?: Array<{ title: LocalizedTestString; prompt: LocalizedTestString }>;
  modelProviders?: Array<
    | { id: string; type: "deterministic"; model: string }
    | {
        id: string;
        type: "openai-compatible";
        model: string;
        baseUrl: string;
        apiKeyEnvName: string;
      }
  >;
  usageBudget?: {
    monthlySpendLimit?: number;
    costSafetyMultiplier?: number;
  };
  usageSafeguards?: UsageSafeguardsConfig;
  executionWorkspaces?: unknown;
	  usagePricing?: {
	    currency: string;
	    models: Array<{
	      providerId: string;
	      model: string;
	      inputPricePerMillionTokens: number;
	      outputPricePerMillionTokens: number;
	    }>;
    webSearch?: Array<{
      providerId: string;
      model?: string;
      pricePerCall: number;
    }>;
  };
  webAccess?: unknown;
  developmentAuth?: unknown;
  sessionToken?: unknown;
} = {}) {
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: "demo-local",
      displayName: "Demo",
      environment: "development"
    },
    auth: {
      development: input.developmentAuth ?? {
        enabled: true,
        user: {
          id: "user-1",
          externalUserId: "user-1",
          displayLabel: "User",
          roles: ["user", "admin", "superadmin"],
          permissionRefs: ["demo-tools"]
        }
      },
      ...(input.sessionToken ? { sessionToken: input.sessionToken } : {})
    },
    modelProviders: input.modelProviders ?? [{ id: "local", type: "deterministic", model: "local" }],
    usage: {
      budget: input.usageBudget ?? {},
      safeguards: input.usageSafeguards ?? {},
      pricing: input.usagePricing
    },
    ...(input.webAccess ? { webAccess: input.webAccess } : {}),
    ...(input.executionWorkspaces ? { executionWorkspaces: input.executionWorkspaces } : {}),
    tools: input.tools ?? []
  });
  testAssetsByConfig.set(config, {
    defaultAgentName: "test_agent",
    agent: toJsonObject({
      name: "test_agent",
      displayName: input.displayName ?? "Test Agent",
      ...(input.welcomeMessage ? { welcomeMessage: input.welcomeMessage } : {}),
      instructions: "Use configured tools only.",
      modelProviderId: input.modelProviders?.[0]?.id ?? "local",
      toolNames: input.toolNames ?? [],
      initialPrompts: input.initialPrompts ?? []
    })
  });
  return config;
}

const testAssetsByConfig = new WeakMap<
  object,
  { defaultAgentName: string; agent: JsonObject }
>();

async function createClientInstanceApp(
  input: Parameters<typeof createUnseededClientInstanceApp>[0]
): Promise<Awaited<ReturnType<typeof createUnseededClientInstanceApp>>> {
  const app = await createUnseededClientInstanceApp(input);
  const assets = testAssetsByConfig.get(app.config);
  if (assets) {
    await app.store.applyConfigAssetMutations({
      clientInstanceId: asClientInstanceId(app.config.clientInstance.id),
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: assets.defaultAgentName,
          config: assets.agent
        },
        { type: "setDefaultAgent", agentName: assets.defaultAgentName }
      ]
    });
  }
  return app;
}

function toJsonObject(input: object): JsonObject {
  const value = unknownToJsonValue(input);
  if (!isJsonObject(value)) {
    throw new Error("Expected JSON object fixture");
  }
  return value;
}

type TestServer = Awaited<ReturnType<typeof createClientInstanceApp>>["server"];

interface StartedRunBody {
  conversation: { id: string };
  userMessage: { id: string; text: string };
  run: { id: string; status: string; lastSequence: number };
  eventsUrl: string;
}

async function injectStartConversationRun(
  server: TestServer,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await server.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/runs`,
    headers: options.headers,
    payload: {
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as StartedRunBody;
}

async function drainRunEvents(
  server: TestServer,
  conversationId: string,
  runId: string,
  options: {
    headers?: Record<string, string>;
    afterSequence?: number;
  } = {}
): Promise<string> {
  const response = await server.inject({
    method: "GET",
    url: `/api/conversations/${conversationId}/runs/${runId}/events${
      options.afterSequence === undefined ? "" : `?after=${options.afterSequence}`
    }`,
    headers: options.headers
  });
  expect(response.statusCode).toBe(200);
  return response.payload;
}

async function fetchStartConversationRun(
  baseUrl: string,
  conversationId: string,
  text: string,
  options: {
    headers?: Record<string, string>;
    idempotencyKey?: string;
  } = {}
): Promise<StartedRunBody> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers
    },
    body: JSON.stringify({
      idempotencyKey: options.idempotencyKey ?? `test-run-${Math.random().toString(36).slice(2)}`,
      message: {
        text
      }
    })
  });
  expect(response.status).toBe(200);
  return (await response.json()) as StartedRunBody;
}

async function fetchRunEvents(baseUrl: string, conversationId: string, runId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/runs/${runId}/events`);
  expect(response.status).toBe(200);
  return response.text();
}

function parseSseChunks(
  text: string
): Array<{
  type?: string;
  sequence?: number;
  runId?: string;
  conversationId?: string;
  payload?: {
    type?: string;
    delta?: string;
    error?: {
      code?: string;
      category?: string;
      message?: string;
    };
  };
}> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as {
      type?: string;
      payload?: { type?: string; delta?: string };
    });
}

async function waitForAuditEvents(
  server: TestServer,
  type: string
): Promise<Array<{ type: string; metadata?: Record<string, unknown> }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const audit = await server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    const events = audit.json() as Array<{ type: string; metadata?: Record<string, unknown> }>;
    if (events.some((event) => event.type === type)) {
      return events;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return [];
}

function createMultipartFilePayload(input: {
  fieldName: string;
  filename: string;
  contentType: string;
  content: string;
}): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `vivd-test-${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.filename}"`,
      `Content-Type: ${input.contentType}`,
      "",
      input.content,
      `--${boundary}--`,
      ""
    ].join("\r\n")
  );
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.byteLength)
    },
    payload
  };
}

function createTestAttachmentCapability(options: {
  onConversationAttachmentsDeleted?(deletion: {
    attachmentCount: number;
    fileObjectKeys: string[];
    artifactObjectKeys: string[];
  }): void;
} = {}): ClientInstanceCapability {
  const attachmentsByConversation = new Map<string, DraftAttachment[]>();
  const files = new Map<
    string,
    {
      filename: string;
      mimeType?: string;
      bytes: Uint8Array;
    }
  >();

  return {
    name: "test-attachments",
    create(context) {
      return {
        attachments: [{
          name: "test-attachments",
          maxFileBytes: 1024 * 1024,
          acceptedFileTypes: ["text/plain", "image/gif"],
          acceptsFile() {
            return true;
          },
          async listDraftAttachments(conversationId) {
            return attachmentsByConversation.get(conversationId) ?? [];
          },
          async uploadDraftAttachment(input) {
            const fileId = createPlatformId<"ManagedFileId">("file");
            const attachment: DraftAttachment = {
              id: createPlatformId<"ConversationAttachmentId">("att"),
              clientInstanceId: context.clientInstanceId,
              conversationId: input.conversationId,
              fileId,
              filename: input.filename,
              mimeType: input.mimeType,
              byteSize: input.bytes.byteLength,
              checksum: "test-checksum",
              status: "ready",
              format: formatForMimeType(input.mimeType),
              artifactRefs: {},
              processingMetadata: {},
              warnings: [],
              error: null,
              processingAttempts: 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            files.set(fileId, {
              filename: input.filename,
              mimeType: input.mimeType,
              bytes: input.bytes
            });
            const conversationAttachments =
              attachmentsByConversation.get(input.conversationId) ?? [];
            conversationAttachments.push(attachment);
            attachmentsByConversation.set(input.conversationId, conversationAttachments);
            return attachment;
          },
          async retryDraftAttachment() {
            throw new Error("Retry is not implemented by the test attachment capability");
          },
          async deleteDraftAttachment(input) {
            const conversationAttachments = attachmentsByConversation.get(input.conversationId) ?? [];
            const remaining = conversationAttachments.filter(
              (attachment) => attachment.id !== input.attachmentId
            );
            attachmentsByConversation.set(input.conversationId, remaining);
            const deleted = conversationAttachments.find(
              (attachment) => attachment.id === input.attachmentId
            );
            if (!deleted) {
              throw new Error("Attachment is not available");
            }
            return {
              ...deleted,
              deletedAt: new Date().toISOString()
            };
          },
          async deleteConversationAttachments(input) {
            const conversationAttachments = attachmentsByConversation.get(input.conversationId) ?? [];
            attachmentsByConversation.set(input.conversationId, []);
            for (const attachment of conversationAttachments) {
              files.delete(attachment.fileId);
            }
            const deletion = {
              attachmentCount: conversationAttachments.length,
              fileObjectKeys: conversationAttachments.map((attachment) => attachment.fileId),
              artifactObjectKeys: []
            };
            options.onConversationAttachmentsDeleted?.(deletion);
            return deletion;
          },
          async readConversationFile(input) {
            const file = files.get(input.fileId);
            if (!file) {
              throw new Error("File is not available");
            }
            return {
              fileId: input.fileId as ManagedFileId,
              filename: file.filename,
              mimeType: file.mimeType,
              byteSize: file.bytes.byteLength,
              bytes: file.bytes
            };
          },
          blockingDraftAttachmentMessage() {
            return undefined;
          },
          createAttachmentManifest(attachments) {
            return {
              version: 1,
              attachments: attachments.flatMap((attachment) =>
                manifestEntryForAttachment(attachment)
              )
            };
          },
          isInlineDisplayMimeType(mimeType) {
            return mimeType === "image/gif";
          }
        }]
      };
    }
  };
}

function manifestEntryForAttachment(attachment: ConversationAttachment): AttachmentManifestEntry[] {
  if (attachment.mimeType === "image/gif") {
    return [
      {
        kind: "image" as const,
        fileId: attachment.fileId,
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: "image/gif" as SupportedImageMimeType,
        byteSize: attachment.byteSize,
        status: "ready" as const,
        readable: false as const,
        modelVisibility: {
          type: "image" as const,
          mimeType: "image/gif" as SupportedImageMimeType
        },
        modelContext: {
          section: "Attached images",
          text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, mimeType: image/gif, size: ${attachment.byteSize} bytes). The image is loaded directly into visual context when the provider supports image inputs.`
        },
        metadata: {
          fileId: attachment.fileId,
          filename: attachment.filename,
          mimeType: "image/gif" as SupportedImageMimeType,
          byteSize: attachment.byteSize,
          format: "gif" as ImageFileFormat,
          checksum: attachment.checksum
        }
      }
    ];
  }

  return [
    {
      kind: "document" as const,
      fileId: attachment.fileId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      status: "ready" as const,
      readable: true as const,
      modelContext: {
        section: "Attached files",
        text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, size: ${attachment.byteSize} bytes).`
      },
      metadata: {
        fileId: attachment.fileId,
        filename: attachment.filename,
        mimeType: attachment.mimeType ?? null,
        byteSize: attachment.byteSize,
        format: attachment.format === "txt" ? "txt" : null,
        warnings: []
      }
    }
  ];
}

function formatForMimeType(mimeType: string | undefined): FileAttachmentFormat | undefined {
  if (mimeType === "image/gif") {
    return "gif";
  }
  if (mimeType === "text/plain") {
    return "txt";
  }
  return undefined;
}

async function waitForReadyDraftAttachment(
  server: Awaited<ReturnType<typeof createClientInstanceApp>>["server"],
  conversationId: string
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await server.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/draft-attachments`
    });
    expect(response.statusCode).toBe(200);
    const attachments = response.json() as Array<{ status: string }>;
    if (attachments.some((attachment) => attachment.status === "ready")) {
      return;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for draft attachment preprocessing");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
