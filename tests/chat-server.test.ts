import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createClientInstanceApp } from "@vivd-stage/client-assembly";
import { parseClientInstanceConfig, type UsageSafeguardsConfig } from "@vivd-stage/config-schema";
import { defineTool, toolSuccess } from "@vivd-stage/tool-sdk";

describe("client instance app vertical slice", () => {
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
        return toolSuccess({ echoed: input.text }, { modelSummary: `Echoed ${input.text}` });
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

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage('/tool demo.echo {"text":"hello"}')]
      }
    });

    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload).some((chunk) => chunk.type === "finish")).toBe(true);

    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.statusCode).toBe(200);
    const persistedMessages = messages.json() as Array<{ role: string; text: string }>;
    expect(persistedMessages.map((message) => message.text).join("\n")).toContain("Echoed hello");

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
      today: { modelCallCount: number; cost: { totalCostMicros: number } };
    };
    expect(usageBody.today).toMatchObject({
      cost: {
        totalCostMicros: 0
      }
    });
    expect(usageBody.today.modelCallCount).toBeGreaterThan(0);

    await app.close();
  });

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

    const firstMessage = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage("hello")]
      }
    });
    expect(firstMessage.statusCode).toBe(200);

    const secondMessage = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage("hello again")]
      }
    });
    expect(secondMessage.statusCode).toBe(200);
    expect(parseSseChunks(secondMessage.payload)).toContainEqual(
      expect.objectContaining({
        type: "error",
        errorText: "Daily model call safeguard has been reached"
      })
    );

    const audit = await app.server.inject({
      method: "GET",
      url: "/api/audit-events"
    });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ type: string }>).some((event) => event.type === "message.failed")).toBe(
      true
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

  it("generates a short conversation headline after the first exchange", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
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

    const sent = await app.server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: conversation.id,
        messages: [createUserUiMessage(firstMessage)]
      }
    });
    expect(sent.statusCode).toBe(200);
    expect(parseSseChunks(sent.payload).some((chunk) => chunk.type === "finish")).toBe(true);

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
      roles: ["user", "admin", "superadmin"]
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
      roles: ["user"]
    });

    const normalUsage = await app.server.inject({
      method: "GET",
      url: "/api/superadmin/usage",
      headers: {
        "x-dev-user-id": "user-1"
      }
    });
    expect(normalUsage.statusCode).toBe(403);

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
      url: "/auth/session-token",
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
      url: "/auth/session-token",
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
      url: "/auth/session-token",
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
    ).toThrow("Monthly spend budget requires configured pricing for model openai/gpt-4.1");
  });
});

type LocalizedTestString =
  | string
  | {
      en?: string;
      de?: string;
    };

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
  usagePricing?: {
    currency: string;
    models: Array<{
      providerId: string;
      model: string;
      inputPricePerMillionTokens: number;
      outputPricePerMillionTokens: number;
    }>;
  };
  developmentAuth?: unknown;
  sessionToken?: unknown;
} = {}) {
  return parseClientInstanceConfig({
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
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: input.displayName ?? "Test Agent",
        ...(input.welcomeMessage ? { welcomeMessage: input.welcomeMessage } : {}),
        instructions: "Use configured tools only.",
        modelProviderId: input.modelProviders?.[0]?.id ?? "local",
        toolNames: input.toolNames ?? [],
        initialPrompts: input.initialPrompts ?? []
      }
    ],
    modelProviders: input.modelProviders ?? [{ id: "local", type: "deterministic", model: "local" }],
    usage: {
      budget: input.usageBudget ?? {},
      safeguards: input.usageSafeguards ?? {},
      pricing: input.usagePricing
    },
    tools: input.tools ?? []
  });
}

function createUserUiMessage(text: string) {
  return {
    id: `user-${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [
      {
        type: "text",
        text
      }
    ]
  };
}

function parseSseChunks(text: string): Array<{ type?: string; errorText?: string }> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as { type?: string; errorText?: string });
}
