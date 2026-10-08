import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { createClientInstanceApp as createUnseededClientInstanceApp } from "@vivd-catalyst/client-assembly";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { createTestConfig, createClientInstanceApp } from "./chat-server-harness";
import { injectStartConversationRun, drainRunEvents } from "./chat-server-run-harness";

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

  it("offers and accepts only the agent's own model and its user-selectable models", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        agentModelBindingId: "own",
        // "retired" no longer exists and agents may no longer use "internal": both are ignored.
        agentUserSelectableModelBindingIds: ["offered", "retired", "internal"],
        modelBindings: [
          { id: "own", providerId: "local", model: "own-model" },
          // Offering a binding needs no `userSelectable` flag in release config.
          { id: "offered", providerId: "local", model: "offered-model" },
          { id: "eligible", providerId: "local", model: "eligible-model", userSelectable: true },
          { id: "internal", providerId: "local", model: "internal-model", agentSelectable: false }
        ]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(config.json().agents[0].selectableModels).toEqual([
      { bindingId: "own", model: "own-model", selectableReasoningEfforts: [] },
      { bindingId: "offered", model: "offered-model", selectableReasoningEfforts: [] }
    ]);

    const start = (modelBindingId: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/conversations/runs",
        payload: {
          idempotencyKey: `start-${modelBindingId}`,
          modelBindingId,
          message: { text: "Hello" }
        }
      });
    // Not offered by this agent; the binding-level `userSelectable` flag has no effect.
    for (const modelBindingId of ["eligible", "internal", "retired"]) {
      const rejected = await start(modelBindingId);
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.message).toBe(
        `Model binding '${modelBindingId}' is not available for user selection`
      );
    }
    // A rejected model leaves no conversation behind.
    const conversations = await app.server.inject({ method: "GET", url: "/api/conversations" });
    expect(conversations.json()).toEqual([]);

    for (const modelBindingId of ["own", "offered"]) {
      const started = await start(modelBindingId);
      expect(started.statusCode).toBe(200);
      const { conversation, run } = started.json() as {
        conversation: { id: string };
        run: { id: string };
      };
      await drainRunEvents(app.server, conversation.id, run.id);
    }
    await app.close();
  });

  it("accepts only the reasoning efforts the model that runs offers to users", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        agentModelBindingId: "own",
        agentUserSelectableModelBindingIds: ["offered"],
        modelBindings: [
          {
            id: "own",
            providerId: "local",
            model: "own-model",
            reasoningEffort: "medium",
            userSelectableReasoningEfforts: ["high", "low"]
          },
          { id: "offered", providerId: "local", model: "offered-model" }
        ]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(config.json().agents[0].selectableModels).toEqual([
      {
        bindingId: "own",
        model: "own-model",
        reasoningEffort: "medium",
        // The default stays selectable so the user can return to it.
        selectableReasoningEfforts: ["low", "medium", "high"]
      },
      { bindingId: "offered", model: "offered-model", selectableReasoningEfforts: [] }
    ]);

    const start = (reasoningEffort: string, modelBindingId?: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/conversations/runs",
        payload: {
          idempotencyKey: `start-${modelBindingId ?? "own"}-${reasoningEffort}`,
          modelBindingId,
          reasoningEffort,
          message: { text: "Hello" }
        }
      });
    // "xhigh" is not offered by the agent's own model, and "offered" offers no choice at all.
    for (const rejected of [await start("xhigh"), await start("low", "offered")]) {
      expect(rejected.statusCode).toBe(422);
      expect(rejected.json().error.message).toMatch(/is not available for user selection$/u);
    }
    const conversations = await app.server.inject({ method: "GET", url: "/api/conversations" });
    expect(conversations.json()).toEqual([]);

    for (const reasoningEffort of ["high", "medium"]) {
      const started = await start(reasoningEffort);
      expect(started.statusCode).toBe(200);
      const { conversation, run } = started.json() as {
        conversation: { id: string };
        run: { id: string };
      };
      await drainRunEvents(app.server, conversation.id, run.id);
    }
    await app.close();
  });

  it("rejects model bindings that are not available for user selection", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig({
        agentModelBindingId: "selectable",
        modelBindings: [
          {
            id: "selectable",
            providerId: "local",
            model: "selectable-model",
            userSelectable: true
          },
          {
            id: "internal",
            providerId: "local",
            model: "internal-model",
            agentSelectable: false
          }
        ]
      }),
      env: {},
      storeMode: "memory",
      tools: []
    });
    const created = await app.server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { title: "Model selection" }
    });
    const conversation = created.json() as { id: string };

    const rejected = await app.server.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/runs`,
      payload: {
        idempotencyKey: "reject-internal-model",
        modelBindingId: "internal",
        message: { text: "Do not persist this" }
      }
    });

    expect(rejected.statusCode).toBe(422);
    const messages = await app.server.inject({
      method: "GET",
      url: `/api/conversations/${conversation.id}/messages`
    });
    expect(messages.json()).toEqual([]);
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
    expect(
      (audit.json() as Array<{ type: string }>).some((event) => event.type === "tool.completed")
    ).toBe(true);

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

  it("shows admins billable usage without internal rate-card policy", async () => {
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
          monthlySpendLimit: 200
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
      spendBudget: {
        currency: "USD",
        monthlyLimitMicros: 200000000
      },
      safeguards: {
        tokensPerMonth: 50000000
      },
      today: {
        modelCallCount: 0,
        totalTokens: 0,
        cost: {
          status: "settled",
          currency: "USD",
          uncachedInputBillableCostMicros: 0,
          cachedInputBillableCostMicros: 0,
          outputBillableCostMicros: 0,
          billableCostMicros: 0,
          complete: true,
          webSearchCostVisible: false
        }
      }
    });
    expect((adminUsageBody.today as { cost: Record<string, unknown> }).cost).not.toHaveProperty(
      "webSearchBillableCostMicros"
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
      spendBudget: {
        currency: "USD",
        monthlyLimitMicros: 200000000
      },
      safeguards: {
        tokensPerMonth: 50000000
      },
      today: {
        modelCallCount: 0,
        totalTokens: 0,
        cost: {
          status: "settled",
          currency: "USD",
          uncachedInputBillableCostMicros: 0,
          cachedInputBillableCostMicros: 0,
          outputBillableCostMicros: 0,
          billableCostMicros: 0,
          complete: true,
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
          webSearchBillableCostMicros: 0
        }
      }
    });
    expect(JSON.stringify(webSearchUsage.json())).not.toContain("pricePerCall");
    await webSearchApp.close();
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

  it("limits safe config agents to those available in Personal Workspaces", async () => {
    const app = await createClientInstanceApp({
      config: createTestConfig(),
      env: {},
      storeMode: "memory",
      tools: []
    });
    try {
      const clientInstanceId = asClientInstanceId(app.config.clientInstance.id);
      const names = ["personal", "restricted"];
      await app.store.applyConfigAssetMutations({
        clientInstanceId,
        mutations: names.map((name) => ({
          type: "upsert" as const,
          kind: "agent" as const,
          name,
          config: {
            name,
            displayName: name,
            instructions: "Use configured tools only.",
            modelProviderId: "local",
            toolNames: [],
            initialPrompts: []
          }
        }))
      });
      const readAgentNames = async () =>
        (
          (await app.server.inject({ method: "GET", url: "/api/config" })).json() as {
            agents: Array<{ name: string }>;
          }
        ).agents.map((agent) => agent.name);
      expect(await readAgentNames()).toEqual(["personal", "restricted", "test_agent"]);

      await app.store.setAgentAvailability({
        clientInstanceId,
        agentName: "personal",
        availability: { mode: "selected", personalWorkspaces: true, collaborationWorkspaceIds: [] }
      });
      await app.store.setAgentAvailability({
        clientInstanceId,
        agentName: "restricted",
        availability: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
      });
      expect(await readAgentNames()).toEqual(["personal", "test_agent"]);
    } finally {
      await app.close();
    }
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
          monthlySpendLimit: 200
        },
        usagePricing: {
          currency: "USD",
          models: []
        }
      })
    ).toThrow("Spend budget requires configured customer pricing for model openai/gpt-4.1");
  });
});
