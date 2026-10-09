import { listenTestInstance, createTestInstance, type TestInstance } from "./support/test-instance";

import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "@vivd-catalyst/api-client";

import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  authenticatedUserFromRecord,
  type AgentRuntime,
  type AuthenticatedUser,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelProvider } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

const servers: TestInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("API Access administration", () => {
  it("manages principals and one-time credentials through the typed API client", async () => {
    const fixture = await createFixture();
    const client = await createClient(fixture.server, "superadmin");

    const created = await client.apiAccess.createServicePrincipal({
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

    const updated = await client.apiAccess.updateServicePrincipal(created.principal.id, {
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
    const createdCredential = await client.apiAccess.createCredential(created.principal.id, {
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

    const listed = await client.apiAccess.listServicePrincipals();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.credentials).toEqual([createdCredential.credential]);
    expect(JSON.stringify(listed)).not.toContain(createdCredential.secret);
    expect(JSON.stringify(listed)).not.toContain("secretHash");

    const revoked = await client.apiAccess.revokeCredential(createdCredential.credential.id);
    expect(revoked.revokedAt).toEqual(expect.any(String));

    const events = await fixture.store.audit.listAuditEvents({
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
      const response = await fixture.server.call("service_principals.list", {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.statusCode).toBe(403);
    }
    const selfGrant = await fixture.server.call("users.update", {
      params: { userId: fixture.users.admin.id },
      headers: { authorization: "Bearer admin" },
      payload: { permissions: ["api_access.manage"] }
    });
    expect(selfGrant.statusCode).toBe(403);

    const managerClient = await createClient(fixture.server, "admin-manager");
    await expect(
      managerClient.apiAccess.createServicePrincipal({
        displayLabel: "Forbidden managed principal",
        permissions: ["config_assets.read"]
      })
    ).rejects.toMatchObject({ status: 403 });

    const superadminClient = await createClient(fixture.server, "superadmin");
    const principal = await superadminClient.apiAccess.createServicePrincipal({
      displayLabel: "Managed principal",
      permissions: ["config_assets.read"]
    });
    await expect(
      managerClient.apiAccess.updateServicePrincipal(principal.principal.id, {
        displayLabel: "Forbidden update"
      })
    ).rejects.toMatchObject({ status: 403 });
    await superadminClient.apiAccess.updateServicePrincipal(principal.principal.id, {
      status: "disabled"
    });
    await expect(
      managerClient.apiAccess.updateServicePrincipal(principal.principal.id, {
        status: "active"
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.apiAccess.updateServicePrincipal(principal.principal.id, {
        permissions: ["config_assets.read", "config_assets.release"]
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.apiAccess.createCredential(principal.principal.id, { name: "Forbidden key" })
    ).rejects.toMatchObject({ status: 403 });

    const credential = await superadminClient.apiAccess.createCredential(principal.principal.id, {
      name: "Superadmin key"
    });
    await expect(
      managerClient.apiAccess.revokeCredential(credential.credential.id)
    ).rejects.toMatchObject({
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
    const response = await fixture.server.call("service_principals.create", {
      headers: { authorization: "Bearer superadmin" },
      payload: { displayLabel: "Invalid", permissions }
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects unsupported credential scopes and non-future expiry", async () => {
    const fixture = await createFixture();
    const client = await createClient(fixture.server, "superadmin");
    const principal = await client.apiAccess.createServicePrincipal({
      displayLabel: "Validation principal",
      permissions: ["config_assets.read"]
    });

    const invalidScope = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.principal.id },
      headers: { authorization: "Bearer superadmin" },
      payload: { name: "Invalid", scopes: ["governance:read"] }
    });
    expect(invalidScope.statusCode).toBe(422);

    const expired = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.principal.id },
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
  const store = (await createTestInstance()).stores;
  const records = {
    superadmin: await store.users.createUser({
      clientInstanceId,
      displayLabel: "Superadmin",
      roles: ["superadmin"]
    }),
    admin: await store.users.createUser({
      clientInstanceId,
      displayLabel: "Admin",
      roles: ["admin"]
    }),
    "admin-manager": await store.users.createUser({
      clientInstanceId,
      displayLabel: "API access manager",
      roles: ["admin"],
      permissions: ["api_access.manage"]
    }),
    user: await store.users.createUser({
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
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  const server = await createTestInstance({
    server: {
      config,
      clientInstanceId,
      authAdapter: {
        credentialMode: "explicit",
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
      stores: store,
      usageGovernance: new ModelUsageGovernance({
        store: store.usage,
        budget: config.usage.budget,
        safeguards: config.usage.safeguards,
        costs: config.usage.costs
      }),
      auditRecorder,
      configAssets: {
        store: store.configAssets,
        source: {
          async getSnapshot() {
            return { version: 0, agents: [], skills: [] };
          }
        },
        validationRefs: {
          modelProviderIds: ["local"],
          modelBindingIds: [],
          modelBindings: [],
          fastModeModelBindingIds: [],
          reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          enabledToolNames: []
        }
      },
      agentRuntime: unusedAgentRuntime(),
      modelProvider: unusedModelProvider()
    }
  });
  servers.push(server);
  return { clientInstanceId, server, store, users };
}

async function createClient(server: TestInstance, token: string) {
  const baseUrl = await listenTestInstance(server);
  return createApiClient({
    baseUrl,
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
