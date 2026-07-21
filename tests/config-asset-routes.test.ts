import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ApiKeyAccessTokenExchange,
  CompositeAuthAdapter,
  HmacServiceAccessTokenAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter
} from "@vivd-catalyst/auth";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AgentConfig,
  type AgentRuntime,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { findConfigAssetAgentValidationIssues } from "../packages/client-assembly/src/assembly-validation";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("config asset admin routes", () => {
  it("issues session tokens through the current and legacy endpoints", async () => {
    const fixture = await createFixture();

    await expect(mintToken(fixture.server)).resolves.toEqual(expect.any(String));
    await expect(
      mintToken(fixture.server, { endpoint: "/auth/session-token" })
    ).resolves.toEqual(expect.any(String));
  });

  it("exchanges an API key for subjectless config access without creating a product user", async () => {
    const fixture = await createFixture({ serviceAccess: true });
    expect(await fixture.store.listUsers({ clientInstanceId: fixture.clientInstanceId })).toEqual([]);

    const exchange = await fixture.server.inject({
      method: "POST",
      url: "/api/auth/access-token",
      headers: { authorization: `Bearer ${fixture.apiKey}` }
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json()).toMatchObject({
      accessToken: expect.any(String),
      expiresAt: expect.any(String)
    });
    const token = (exchange.json() as { accessToken: string }).accessToken;

    const imported = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [agentConfig("Released by service principal")],
        skills: []
      }
    });
    expect(imported.statusCode).toBe(200);
    const exported = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/export"
    });
    expect(exported.statusCode).toBe(200);

    const humanRoute = await request(fixture.server, token, {
      method: "GET",
      url: "/api/conversations"
    });
    expect(humanRoute.statusCode).toBe(403);
    expect(await fixture.store.listUsers({ clientInstanceId: fixture.clientInstanceId })).toEqual([]);

    const revisions = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets/agent/assistant/revisions"
    });
    expect(revisions.json()).toMatchObject([
      {
        actor: {
          principalKind: "service",
          principalDisplayLabel: "Catalyst CLI",
          credentialId: fixture.credentialId
        }
      }
    ]);
    const events = await fixture.store.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    expect(events.find((event) => event.type === "config_assets.replaced")?.actor).toMatchObject({
      principalKind: "service",
      credentialId: fixture.credentialId
    });
  });

  it("mints a service token and supports CRUD, revisions, revert, and export/import", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);

    const created = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Original instructions") }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ version: 1, revision: 1 });

    const fetched = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets/agent/assistant"
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      kind: "agent",
      name: "assistant",
      revision: 1,
      config: { instructions: "Original instructions" }
    });

    const overview = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets"
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      version: 1,
      assets: [{ kind: "agent", name: "assistant", revision: 1 }],
      references: {
        modelProviderIds: ["local"],
        modelBindingIds: [],
        modelBindings: [],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        enabledToolNames: ["known.tool", "read_skill"]
      }
    });

    const updated = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Changed instructions"), baseVersion: 1 }
    });
    expect(updated.json()).toEqual({ version: 2, revision: 2 });

    const revisionsBeforeRevert = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets/agent/assistant/revisions"
    });
    expect(revisionsBeforeRevert.statusCode).toBe(200);
    expect(revisionsBeforeRevert.json()).toMatchObject([
      {
        revision: 1,
        operation: "create",
        config: { instructions: "Original instructions" }
      },
      {
        revision: 2,
        operation: "update",
        config: { instructions: "Changed instructions" }
      }
    ]);

    const reverted = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/assets/agent/assistant/revert",
      payload: { revision: 1, baseVersion: 2 }
    });
    expect(reverted.json()).toEqual({ version: 3, revision: 3 });
    const fetchedAfterRevert = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets/agent/assistant"
    });
    expect(fetchedAfterRevert.json()).toMatchObject({
      revision: 3,
      config: { instructions: "Original instructions" }
    });

    const defaultAgent = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/default-agent",
      payload: { agentName: "assistant", baseVersion: 3 }
    });
    expect(defaultAgent.json()).toEqual({ version: 4 });
    const exported = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/export"
    });
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json() as {
      defaultAgentName?: string;
      agents: Array<Record<string, unknown>>;
      skills: Array<Record<string, unknown>>;
    };
    expect(bundle).toMatchObject({
      defaultAgentName: "assistant",
      agents: [{ name: "assistant", instructions: "Original instructions" }],
      skills: []
    });

    const deleted = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/assets/agent/assistant/delete",
      payload: { baseVersion: 4 }
    });
    expect(deleted.json()).toEqual({ version: 5 });

    const imported = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: 5,
        defaultAgentName: bundle.defaultAgentName,
        agents: bundle.agents,
        skills: bundle.skills
      }
    });
    expect(imported.json()).toEqual({ version: 6 });
    const roundTripped = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/export"
    });
    expect(roundTripped.json()).toMatchObject({
      version: 6,
      defaultAgentName: "assistant",
      agents: bundle.agents,
      skills: bundle.skills
    });

    const events = await fixture.store.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "config_asset.updated",
        "config_asset.reverted",
        "config_asset.default_agent_set",
        "config_asset.deleted",
        "config_assets.replaced"
      ])
    );
  });

  it("merges provided assets when requested and defaults old clients to mirror mode", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const initial = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [
          agentConfig("Initial", { name: "assistant" }),
          agentConfig("Remote only", { name: "remote-only" })
        ],
        skills: []
      }
    });
    expect(initial.json()).toEqual({ version: 1 });

    const merged = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: 1,
        mode: "merge",
        agents: [agentConfig("Merged", { name: "assistant" })],
        skills: []
      }
    });
    expect(merged.json()).toEqual({ version: 2 });
    const afterMerge = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/export"
    });
    expect(afterMerge.json()).toMatchObject({
      version: 2,
      defaultAgentName: "assistant",
      agents: [
        { name: "assistant", instructions: "Merged" },
        { name: "remote-only", instructions: "Remote only" }
      ]
    });

    const mirrored = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: 2,
        defaultAgentName: "assistant",
        agents: [agentConfig("Mirrored", { name: "assistant" })],
        skills: []
      }
    });
    expect(mirrored.json()).toEqual({ version: 3 });
    const afterMirror = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/export"
    });
    expect(afterMirror.json()).toMatchObject({
      version: 3,
      agents: [{ name: "assistant", instructions: "Mirrored" }]
    });
  });

  it("returns 409 for a stale base version", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Current") }
    });

    const stale = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Stale"), baseVersion: 0 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("rejects broken skill references without advancing the config version", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const skill = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/skill/review",
      payload: {
        config: {
          name: "review",
          title: "Review",
          description: "Review the request",
          content: "# Review"
        }
      }
    });
    expect(skill.json()).toEqual({ version: 1, revision: 1 });
    const agent = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        baseVersion: 1,
        config: agentConfig("Uses the review skill", {
          toolNames: ["read_skill"],
          skillNames: ["review"]
        })
      }
    });
    expect(agent.json()).toEqual({ version: 2, revision: 1 });

    const referencedDelete = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/assets/skill/review/delete",
      payload: { baseVersion: 2 }
    });
    expect(referencedDelete.statusCode).toBe(422);
    expect(referencedDelete.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [{ message: "Agent 'assistant' references missing skill 'review'" }]
        }
      }
    });

    const missingReadSkill = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        baseVersion: 2,
        config: agentConfig("Uses the review skill", { skillNames: ["review"] })
      }
    });
    expect(missingReadSkill.statusCode).toBe(422);
    expect(missingReadSkill.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            {
              message: "Agent 'assistant' references skills but does not allow 'read_skill'"
            }
          ]
        }
      }
    });

    const overview = await request(fixture.server, token, {
      method: "GET",
      url: "/api/admin/config/assets"
    });
    expect(overview.json()).toMatchObject({ version: 2 });
  });

  it("rejects chat-scoped tokens and service users without write permission", async () => {
    const fixture = await createFixture();
    const chatToken = await mintToken(fixture.server, {
      scopes: ["me:read"],
      permissions: ["config_assets.write"],
      delegatedActor: undefined
    });
    const missingScope = await request(fixture.server, chatToken, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Denied") }
    });
    expect(missingScope.statusCode).toBe(403);

    const readOnlyToken = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      permissions: ["config_assets.read"]
    });
    const missingPermission = await request(fixture.server, readOnlyToken, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config: agentConfig("Denied") }
    });
    expect(missingPermission.statusCode).toBe(403);
    expect(missingPermission.json()).toMatchObject({
      error: { code: "FORBIDDEN" }
    });
  });

  it("enforces editable agent fields on interactive writes", async () => {
    const fixture = await createFixture({
      agentConfiguration: {
        enabled: true,
        editableAgentFields: ["displayName"]
      }
    });
    const token = await mintToken(fixture.server);
    const initial = agentConfig("Release-managed instructions");
    const imported = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: null,
        defaultAgentName: "assistant",
        agents: [initial],
        skills: []
      }
    });
    expect(imported.statusCode).toBe(200);

    const displayNameUpdate = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        baseVersion: 1,
        config: { ...initial, displayName: "Renamed Assistant" }
      }
    });
    expect(displayNameUpdate.statusCode).toBe(200);

    const protectedUpdate = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        baseVersion: 2,
        config: {
          ...initial,
          displayName: "Renamed Assistant",
          instructions: "Changed interactively"
        }
      }
    });
    expect(protectedUpdate.statusCode).toBe(403);
    expect(protectedUpdate.json()).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Interactive changes are not allowed for agent field: instructions"
      }
    });
  });

  it("requires the release-sync permission for bundle replacement", async () => {
    const fixture = await createFixture();
    const interactiveToken = await mintToken(fixture.server, {
      scopes: ["config_assets:read", "config_assets:write"],
      permissions: ["config_assets.read", "config_assets.write"]
    });
    const response = await request(fixture.server, interactiveToken, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: { baseVersion: null, agents: [], skills: [] }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("requires pricing for every non-deterministic agent model when spend budgets are enabled", async () => {
    const fixture = await createFixture({ pricingCoverage: true });
    const token = await mintToken(fixture.server);
    const unpriced = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        config: agentConfig("Unpriced", { modelProviderId: "provider-b" })
      }
    });

    expect(unpriced.statusCode).toBe(422);
    expect(unpriced.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("pricing")
      }
    });

    const priced = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        config: agentConfig("Priced", { modelProviderId: "provider-a" })
      }
    });
    expect(priced.statusCode).toBe(200);
  });

  it("rejects web_search when materialization is disabled and accepts a capable provider", async () => {
    const disabledFixture = await createFixture({ webSearch: "disabled" });
    const disabledToken = await mintToken(disabledFixture.server);
    const disabled = await request(disabledFixture.server, disabledToken, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        config: agentConfig("Search", {
          modelProviderId: "openai",
          toolNames: ["web_search"]
        })
      }
    });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json()).toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        details: {
          issues: [
            {
              message: "Agent 'assistant' references web_search but web access is disabled"
            }
          ]
        }
      }
    });

    const enabledFixture = await createFixture({ webSearch: "enabled" });
    const enabledToken = await mintToken(enabledFixture.server);
    const enabled = await request(enabledFixture.server, enabledToken, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: {
        config: agentConfig("Search", {
          modelProviderId: "openai",
          toolNames: ["web_search"]
        })
      }
    });
    expect(enabled.statusCode).toBe(200);
  });

  it.each([
    ["unknown tool", agentConfig("Invalid", { toolNames: ["missing.tool"] })],
    ["unknown skill", agentConfig("Invalid", { skillNames: ["missing-skill"] })],
    ["unknown model provider", agentConfig("Invalid", { modelProviderId: "missing-provider" })]
  ])("rejects an agent with an %s reference", async (_label, config) => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const response = await request(fixture.server, token, {
      method: "PUT",
      url: "/api/admin/config/assets/agent/assistant",
      payload: { config }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });

  it("rejects duplicate import names and a missing default agent", async () => {
    const fixture = await createFixture();
    const token = await mintToken(fixture.server);
    const duplicate = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: null,
        agents: [agentConfig("One"), agentConfig("Two")],
        skills: []
      }
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });

    const missingDefault = await request(fixture.server, token, {
      method: "POST",
      url: "/api/admin/config/import",
      payload: {
        baseVersion: null,
        defaultAgentName: "missing",
        agents: [agentConfig("Valid")],
        skills: []
      }
    });
    expect(missingDefault.statusCode).toBe(422);
    expect(missingDefault.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" }
    });
  });
});

async function createFixture(
  input: {
    agentConfiguration?: Record<string, unknown>;
    pricingCoverage?: boolean;
    webSearch?: "disabled" | "enabled";
    serviceAccess?: boolean;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("config-routes-test");
  const store = new InMemoryPlatformStore();
  const modelProviders = input.pricingCoverage
    ? [
        {
          id: "provider-a",
          type: "openai-compatible" as const,
          model: "model-a"
        },
        {
          id: "provider-b",
          type: "openai-compatible" as const,
          model: "model-b"
        }
      ]
    : input.webSearch
      ? [
          {
            id: "openai",
            type: "openai-compatible" as const,
            api: "responses" as const,
            model: "gpt-test"
          }
        ]
      : [{ id: "local", type: "deterministic" as const, model: "local" }];
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config routes test",
      environment: "development"
    },
    auth: {},
    administration: {
      agentConfiguration: {
        enabled: true,
        editableAgentFields: [
          "displayName",
          "instructions",
          "modelProviderId",
          "modelBindingId",
          "reasoningEffort",
          "toolNames",
          "skillNames",
          "initialPrompts"
        ],
        allowAgentCreation: true,
        allowAgentDeletion: true,
        allowDefaultAgentChange: true,
        allowSkillEditing: true,
        ...input.agentConfiguration
      }
    },
    modelProviders,
    ...(input.pricingCoverage
      ? {
          usage: {
            budget: { monthlySpendLimit: 100 },
            pricing: {
              models: [
                {
                  providerId: "provider-a",
                  model: "model-a",
                  inputPricePerMillionTokens: 1,
                  outputPricePerMillionTokens: 2
                }
              ]
            }
          }
        }
      : {}),
    ...(input.webSearch
      ? {
          webAccess: {
            enabled: input.webSearch === "enabled",
            search: { enabled: input.webSearch === "enabled" }
          }
        }
      : {}),
    tools: [
      { name: "known.tool", enabled: true },
      { name: "read_skill", enabled: true },
      ...(input.webSearch ? [{ name: "web_search", enabled: true }] : [])
    ]
  });
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-routes-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const servicePrincipal = input.serviceAccess
    ? await store.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Catalyst CLI",
        permissions: ["config_assets.read", "config_assets.release"]
      })
    : undefined;
  const createdCredential = servicePrincipal
    ? await store.createApiCredential({
        clientInstanceId,
        servicePrincipalId: servicePrincipal.id,
        name: "test key",
        scopes: ["config_assets:read", "config_assets:release"]
      })
    : undefined;
  const serviceAccessOptions = input.serviceAccess
    ? {
        secret: "a-development-service-access-secret-with-enough-length",
        clientInstanceId,
        apiAccessStore: store
      }
    : undefined;
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId,
    store
  });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: serviceAccessOptions
      ? new IdentityResolvingAuthAdapter(
          new CompositeAuthAdapter([
            new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions),
            new HmacSessionTokenAuthAdapter(authOptions)
          ]),
          store
        )
      : new HmacSessionTokenAuthAdapter(authOptions),
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    usageGovernance: new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    }),
    auditRecorder,
    configAssets: {
      store,
      validationRefs: {
        modelProviderIds: modelProviders.map((provider) => provider.id),
        modelBindingIds: [],
        modelBindings: [],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        enabledToolNames: [
          "known.tool",
          "read_skill",
          ...(input.webSearch ? ["web_search"] : [])
        ]
      },
      ...(input.webSearch
        ? {
            validateAgents: (agents: AgentConfig[]) =>
              findConfigAssetAgentValidationIssues(config, agents)
          }
        : {})
    },
    agentRuntime: createUnusedAgentRuntime(),
    modelProvider: createUnusedModelProvider(),
    sessionToken: {
      issuer,
      serverCredential: "server-credential"
    },
    ...(serviceAccessOptions
      ? {
          serviceAccessToken: {
            exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
          }
        }
      : {})
  });
  servers.push(server);
  return {
    clientInstanceId,
    server,
    store,
    apiKey: createdCredential?.secret,
    credentialId: createdCredential?.credential.id
  };
}

async function mintToken(
  server: FastifyInstance,
  overrides: {
    endpoint?: string;
    scopes?: string[];
    permissions?: string[];
    delegatedActor?:
      | {
          kind: "service_principal";
          id: string;
          authSource: string;
        }
      | undefined;
  } = {}
): Promise<string> {
  const payload = {
    externalUserId: "config-cli",
    displayLabel: "Config CLI",
    roles: ["user"],
    permissions: overrides.permissions ?? [
      "config_assets.read",
      "config_assets.write",
      "config_assets.release"
    ],
    scopes: overrides.scopes ?? [
      "config_assets:read",
      "config_assets:write",
      "config_assets:release"
    ],
    ...("delegatedActor" in overrides
      ? { delegatedActor: overrides.delegatedActor }
      : {
          delegatedActor: {
            kind: "service_principal" as const,
            id: "config-cli",
            authSource: "server-credential"
          }
        })
  };
  const response = await server.inject({
    method: "POST",
    url: overrides.endpoint ?? "/api/superadmin/session-tokens",
    headers: { "x-server-credential": "server-credential" },
    payload
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { chatSessionToken: string }).chatSessionToken;
}

function request(
  server: FastifyInstance,
  token: string,
  input: { method: "GET" | "POST" | "PUT"; url: string; payload?: unknown }
) {
  return server.inject({
    ...input,
    headers: { authorization: `Bearer ${token}` }
  });
}

function agentConfig(
  instructions: string,
  overrides: {
    name?: string;
    modelProviderId?: string;
    toolNames?: string[];
    skillNames?: string[];
  } = {}
) {
  return {
    name: overrides.name ?? "assistant",
    displayName: "Assistant",
    instructions,
    modelProviderId: overrides.modelProviderId ?? "local",
    toolNames: overrides.toolNames ?? [],
    skillNames: overrides.skillNames ?? [],
    initialPrompts: []
  };
}

function createUnusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used by config asset tests");
    }
  };
}

function createUnusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used by config asset tests");
    }
  };
}
