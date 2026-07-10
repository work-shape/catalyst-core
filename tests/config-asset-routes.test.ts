import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HmacSessionTokenAuthAdapter, HmacSessionTokenIssuer } from "@vivd-catalyst/auth";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  type AgentRuntime,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("config asset admin routes", () => {
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

async function createFixture() {
  const clientInstanceId = asClientInstanceId("config-routes-test");
  const store = new InMemoryPlatformStore();
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "Config routes test",
      environment: "development"
    },
    auth: {},
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    tools: [
      { name: "known.tool", enabled: true },
      { name: "read_skill", enabled: true }
    ]
  });
  const authOptions = {
    secret: "a-development-session-token-secret",
    clientInstanceId,
    issuer: "config-routes-test",
    ttlSeconds: 900
  };
  const issuer = new HmacSessionTokenIssuer(authOptions);
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId,
    store
  });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: new HmacSessionTokenAuthAdapter(authOptions),
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
        modelProviderIds: ["local"],
        modelBindingIds: [],
        enabledToolNames: ["known.tool", "read_skill"]
      }
    },
    agentRuntime: createUnusedAgentRuntime(),
    modelProvider: createUnusedModelProvider(),
    sessionToken: {
      issuer,
      serverCredential: "server-credential"
    }
  });
  servers.push(server);
  return { clientInstanceId, server, store };
}

async function mintToken(
  server: FastifyInstance,
  overrides: {
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
    permissions: overrides.permissions ?? ["config_assets.read", "config_assets.write"],
    scopes: overrides.scopes ?? ["config_assets:read", "config_assets:write"],
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
    url: "/api/superadmin/session-tokens",
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
