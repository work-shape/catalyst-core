import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApiClient } from "@vivd-catalyst/api-client";
import { createChatServer } from "@vivd-catalyst/chat-server";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  authenticatedUserFromRecord,
  type AgentRuntime,
  type AuthenticatedUser,
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

describe("API Access administration", () => {
  it("manages principals and one-time credentials through the typed API client", async () => {
    const fixture = await createFixture();
    const client = await createClient(fixture.server, "superadmin");

    const created = await client.createServicePrincipal({
      displayLabel: "Release CLI",
      description: "Configuration release automation",
      permissions: ["config_assets.read", "config_assets.release"]
    });
    expect(created).toMatchObject({
      principal: {
        displayLabel: "Release CLI",
        createdByUserId: fixture.users.superadmin.id,
        permissionRefs: [],
        permissions: ["config_assets.read", "config_assets.release"]
      },
      credentials: []
    });

    const updated = await client.updateServicePrincipal(created.principal.id, {
      displayLabel: "Disabled release CLI",
      description: null,
      status: "disabled",
      permissions: ["config_assets.read"]
    });
    expect(updated.principal).toMatchObject({
      displayLabel: "Disabled release CLI",
      status: "disabled",
      permissions: ["config_assets.read"]
    });
    expect(updated.principal.description).toBeUndefined();

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const createdCredential = await client.createApiCredential(created.principal.id, {
      name: "CI key",
      scopes: ["config_assets:read"],
      expiresAt
    });
    expect(createdCredential).toMatchObject({
      credential: {
        servicePrincipalId: created.principal.id,
        name: "CI key",
        scopes: ["config_assets:read"],
        expiresAt,
        keyPrefix: expect.any(String)
      },
      secret: expect.stringMatching(/^cat\.apic_/u)
    });

    const listed = await client.servicePrincipals();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.credentials).toEqual([createdCredential.credential]);
    expect(JSON.stringify(listed)).not.toContain(createdCredential.secret);
    expect(JSON.stringify(listed)).not.toContain("secretHash");

    const revoked = await client.revokeApiCredential(createdCredential.credential.id);
    expect(revoked.revokedAt).toEqual(expect.any(String));

    const events = await fixture.store.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "api_access.service_principal_created",
        "api_access.service_principal_updated",
        "api_access.credential_created",
        "api_access.credential_revoked"
      ])
    );
    const auditJson = JSON.stringify(events);
    expect(auditJson).toContain(createdCredential.credential.keyPrefix);
    expect(auditJson).not.toContain(createdCredential.secret);
    expect(auditJson).not.toContain("secretHash");
  });

  it("denies default admin and user access and still requires superadmin for key lifecycle", async () => {
    const fixture = await createFixture();
    for (const token of ["admin", "user"]) {
      const response = await fixture.server.inject({
        method: "GET",
        url: "/api/superadmin/api-access/service-principals",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.statusCode).toBe(403);
    }
    const selfGrant = await fixture.server.inject({
      method: "PATCH",
      url: `/api/superadmin/users/${fixture.users.admin.id}`,
      headers: { authorization: "Bearer admin" },
      payload: { permissions: ["api_access.manage"] }
    });
    expect(selfGrant.statusCode).toBe(403);

    const managerClient = await createClient(fixture.server, "admin-manager");
    await expect(
      managerClient.createServicePrincipal({
        displayLabel: "Forbidden managed principal",
        permissions: ["config_assets.read"]
      })
    ).rejects.toMatchObject({ status: 403 });

    const superadminClient = await createClient(fixture.server, "superadmin");
    const principal = await superadminClient.createServicePrincipal({
      displayLabel: "Managed principal",
      permissions: ["config_assets.read"]
    });
    await expect(
      managerClient.updateServicePrincipal(principal.principal.id, {
        displayLabel: "Forbidden update"
      })
    ).rejects.toMatchObject({ status: 403 });
    await superadminClient.updateServicePrincipal(principal.principal.id, {
      status: "disabled"
    });
    await expect(
      managerClient.updateServicePrincipal(principal.principal.id, {
        status: "active"
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.updateServicePrincipal(principal.principal.id, {
        permissions: ["config_assets.read", "config_assets.release"]
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.createApiCredential(principal.principal.id, { name: "Forbidden key" })
    ).rejects.toMatchObject({ status: 403 });

    const credential = await superadminClient.createApiCredential(principal.principal.id, {
      name: "Superadmin key"
    });
    await expect(managerClient.revokeApiCredential(credential.credential.id)).rejects.toMatchObject({
      status: 403
    });
  });

  it.each([
    ["caller management permission", ["api_access.manage"]],
    ["user administration permission", ["users.manage"]],
    ["governance permission", ["audit.view"]],
    ["unknown permission", ["unknown.permission"]]
  ])("rejects %s grants", async (_label, permissions) => {
    const fixture = await createFixture();
    const response = await fixture.server.inject({
      method: "POST",
      url: "/api/superadmin/api-access/service-principals",
      headers: { authorization: "Bearer superadmin" },
      payload: { displayLabel: "Invalid", permissions }
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects unsupported credential scopes and non-future expiry", async () => {
    const fixture = await createFixture();
    const client = await createClient(fixture.server, "superadmin");
    const principal = await client.createServicePrincipal({
      displayLabel: "Validation principal",
      permissions: ["config_assets.read"]
    });
    const path = `/api/superadmin/api-access/service-principals/${principal.principal.id}/credentials`;

    const invalidScope = await fixture.server.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer superadmin" },
      payload: { name: "Invalid", scopes: ["governance:read"] }
    });
    expect(invalidScope.statusCode).toBe(422);

    const expired = await fixture.server.inject({
      method: "POST",
      url: path,
      headers: { authorization: "Bearer superadmin" },
      payload: { name: "Expired", expiresAt: "2020-01-01T00:00:00.000Z" }
    });
    expect(expired.statusCode).toBe(422);
    expect(expired.json()).toMatchObject({
      error: { message: "API credential expiry must be in the future" }
    });
  });
});

async function createFixture() {
  const clientInstanceId = asClientInstanceId("api-access-admin-test");
  const store = new InMemoryPlatformStore();
  const records = {
    superadmin: await store.createUser({
      clientInstanceId,
      displayLabel: "Superadmin",
      roles: ["superadmin"]
    }),
    admin: await store.createUser({
      clientInstanceId,
      displayLabel: "Admin",
      roles: ["admin"]
    }),
    "admin-manager": await store.createUser({
      clientInstanceId,
      displayLabel: "API access manager",
      roles: ["admin"],
      permissions: ["api_access.manage"]
    }),
    user: await store.createUser({
      clientInstanceId,
      displayLabel: "User",
      roles: ["user"]
    })
  };
  const users = Object.fromEntries(
    Object.entries(records).map(([key, record]) => [
      key,
      {
        ...authenticatedUserFromRecord({
          user: record,
          identity: { authSource: "test", externalUserId: record.id }
        }),
        scopes: ["*"]
      }
    ])
  ) as Record<keyof typeof records, AuthenticatedUser>;
  const config = parseClientInstanceConfig({
    version: 1,
    clientInstance: {
      id: clientInstanceId,
      displayName: "API access admin test",
      environment: "development"
    },
    auth: {},
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    tools: []
  });
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter: {
      id: "api-access-admin-test",
      async authenticate(request) {
        const authorization = request.headers.authorization;
        const value = Array.isArray(authorization) ? authorization[0] : authorization;
        const token = value?.replace(/^Bearer /u, "") as keyof typeof users | undefined;
        const user = token ? users[token] : undefined;
        if (!user) {
          throw new AppError("UNAUTHENTICATED", "Unknown test user");
        }
        return { ...user, correlationId: request.correlationId };
      }
    },
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    apiAccessStore: store,
    usageGovernance: new ModelUsageGovernance({
      store,
      budget: config.usage.budget,
      safeguards: config.usage.safeguards,
      pricing: config.usage.pricing
    }),
    auditRecorder,
    configAssets: {
      store,
      source: {
        async getSnapshot() {
          return { version: 0, agents: [], skills: [] };
        }
      },
      validationRefs: {
        modelProviderIds: ["local"],
        modelBindingIds: [],
        modelBindings: [],
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
        enabledToolNames: []
      }
    },
    agentRuntime: unusedAgentRuntime(),
    modelProvider: unusedModelProvider()
  });
  servers.push(server);
  return { clientInstanceId, server, store, users };
}

async function createClient(server: FastifyInstance, token: string) {
  if (!server.server.listening) {
    await server.listen({ host: "127.0.0.1", port: 0 });
  }
  const address = server.server.address() as AddressInfo;
  return createApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    getToken: () => token
  });
}

function unusedAgentRuntime(): AgentRuntime {
  return {
    async start() {
      throw new AppError("INTERNAL", "Agent runtime should not be used");
    },
    async *observe() {
      throw new AppError("INTERNAL", "Agent runtime should not be used");
    },
    async getStatus() {
      throw new AppError("INTERNAL", "Agent runtime should not be used");
    },
    async resume() {
      throw new AppError("INTERNAL", "Agent runtime should not be used");
    },
    async cancel() {
      throw new AppError("INTERNAL", "Agent runtime should not be used");
    }
  };
}

function unusedModelProvider(): ModelProvider {
  return {
    id: "unused",
    async complete(_request, _context: RuntimeCallContext) {
      throw new AppError("INTERNAL", "Model provider should not be used");
    }
  };
}
