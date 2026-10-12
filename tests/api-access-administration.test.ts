import { listenTestInstance, createTestInstance, type TestInstance } from "./support/test-instance";

import { afterEach, describe, expect, it } from "vitest";

import { completedOutput, createApiClient, listAll } from "@vivd-catalyst/api-client";
import { apiErrorResponseSchema, apiOperations } from "@vivd-catalyst/api-contract";
import { openApiJsonOperation } from "./support/operations";
import { inspect } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { fileTestDatabaseUrl } from "./support/test-database";

import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asServicePrincipalId,
  authenticatedUserFromRecord,
  type AgentRuntime,
  type AuthenticatedUser,
  type Logger,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { FakeModelProvider as ModelProvider } from "./support/model-gateway";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

const servers: TestInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("API Access administration", () => {
  it("manages principals and one-time credentials through the typed API client", async () => {
    const fixture = await createFixture();
    const client = await createClient(fixture.server, "superadmin");

    const created = completedOutput(
      await client.service_principals.create({
        body: {
          name: "release",
          displayLabel: "Release CLI",
          description: "Configuration release automation",
          permissions: ["config_assets.read", "config_assets.release"]
        }
      })
    );
    expect(created).toMatchObject({
      principal: {
        name: "release",
        displayLabel: "Release CLI",
        createdByUserId: fixture.users.superadmin.id,
        permissionRefs: [],
        permissions: ["config_assets.read", "config_assets.release"]
      },
      credentials: []
    });

    const updated = completedOutput(
      await client.service_principals.update({
        params: { servicePrincipalId: created.principal.id },
        body: {
          displayLabel: "Disabled release CLI",
          description: null,
          status: "disabled",
          permissions: ["config_assets.read"]
        }
      })
    );
    // Fails with a schema that strips what it does not know: a rename was answered 200 and
    // changed nothing, so its caller believed the principal had the new name.
    const renamed = await fixture.server.call("service_principals.update", {
      params: { servicePrincipalId: created.principal.id },
      headers: { authorization: "Bearer superadmin" },
      payload: { name: "renamed", displayLabel: "Renamed" }
    });
    expect(renamed.statusCode, renamed.body).toBe(422);
    // The name is the principal's for good: an update has no field for it.
    expect(updated.principal).toMatchObject({
      name: "release",
      displayLabel: "Disabled release CLI",
      status: "disabled",
      permissions: ["config_assets.read"]
    });
    await expect(
      client.service_principals.create({ body: { name: "release", displayLabel: "Second" } })
    ).rejects.toMatchObject({ status: 409 });
    expect(updated.principal.description).toBeUndefined();

    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    // The answer is the key itself: this call is never held, so the client answers it plain.
    const createdCredential = await client.api_credentials.create({
      params: { servicePrincipalId: created.principal.id },
      body: {
        name: "CI key",
        scopes: ["config_assets:read"],
        expiresAt
      }
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

    const listed = await listAll((paging) => client.service_principals.list({ query: paging }));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.credentials).toEqual([createdCredential.credential]);
    expect(JSON.stringify(listed)).not.toContain(createdCredential.secret);
    expect(JSON.stringify(listed)).not.toContain("secretHash");

    const revoked = completedOutput(
      await client.api_credentials.revoke({
        params: { credentialId: createdCredential.credential.id }
      })
    );
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
      managerClient.service_principals.create({
        body: {
          displayLabel: "Forbidden managed principal",
          permissions: ["config_assets.read"]
        }
      })
    ).rejects.toMatchObject({ status: 403 });

    const superadminClient = await createClient(fixture.server, "superadmin");
    const principal = completedOutput(
      await superadminClient.service_principals.create({
        body: {
          displayLabel: "Managed principal",
          permissions: ["config_assets.read"]
        }
      })
    );
    await expect(
      managerClient.service_principals.update({
        params: { servicePrincipalId: principal.principal.id },
        body: {
          displayLabel: "Forbidden update"
        }
      })
    ).rejects.toMatchObject({ status: 403 });
    await superadminClient.service_principals.update({
      params: { servicePrincipalId: principal.principal.id },
      body: {
        status: "disabled"
      }
    });
    await expect(
      managerClient.service_principals.update({
        params: { servicePrincipalId: principal.principal.id },
        body: {
          status: "active"
        }
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.service_principals.update({
        params: { servicePrincipalId: principal.principal.id },
        body: {
          permissions: ["config_assets.read", "config_assets.release"]
        }
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      managerClient.api_credentials.create({
        params: { servicePrincipalId: principal.principal.id },
        body: { name: "Forbidden key" }
      })
    ).rejects.toMatchObject({ status: 403 });

    const credential = await superadminClient.api_credentials.create({
      params: { servicePrincipalId: principal.principal.id },
      body: {
        name: "Superadmin key"
      }
    });
    await expect(
      managerClient.api_credentials.revoke({ params: { credentialId: credential.credential.id } })
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
    const principal = completedOutput(
      await client.service_principals.create({
        body: {
          displayLabel: "Validation principal",
          permissions: ["config_assets.read"]
        }
      })
    );

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

// The four changes are registered operations. These tests fail without that: the plain routes
// wrote no Operation Run, answered no run id and knew no Idempotency-Key.
describe("API Access changes as Operation Runs", () => {
  it("keeps the key of a new credential in no stored row and no log line", async () => {
    const fixture = await createFixture();
    const principal = await createPrincipal(fixture, "Key holder");
    const create = () =>
      fixture.server.call("api_credentials.create", {
        params: { servicePrincipalId: principal.id },
        headers: { ...superadmin, "idempotency-key": "create-key-once" },
        payload: { name: "CI key", scopes: ["config_assets:read"] }
      });

    const first = await create();
    expect(first.statusCode).toBe(200);
    const { secret, credential } = createdCredentialSchema.parse(first.json());
    // The part of the key nobody but its holder knows: what follows the prefix.
    const random = secret.slice(credential.keyPrefix.length);
    expect(random).toMatch(/^[0-9a-f]{32,}$/u);

    const rows = await storedRows();
    const tables = [...new Set(rows.map((row) => row.table))];
    expect(tables).toEqual(
      expect.arrayContaining(["operation_runs", "audit_events", "api_credentials"])
    );
    // The key whole, its random part, the first 12 characters of that part, which the stored
    // display prefix does not hold, and each of them as base64 and base64url.
    const traces = keyTraces(secret, random);
    expect(traces).toHaveLength(9);
    expect(credential.keyPrefix).not.toContain(random.slice(0, 12));
    const holding = (found: { table: string; text: string }[]) =>
      found
        .filter((row) => traces.some((trace) => row.text.includes(trace)))
        .map((row) => row.table);
    expect(holding(rows)).toEqual([]);
    // The hash of the key rests with the credential and nowhere else.
    const [stored] = rows.filter((row) => row.table === "api_credentials");
    const { secret_hash: secretHash } = z
      .object({ secret_hash: z.string().min(16) })
      .parse(JSON.parse(stored?.text ?? "{}"));
    expect(rows.filter((row) => row.text.includes(secretHash)).map((row) => row.table)).toEqual([
      "api_credentials"
    ]);
    // The rows were read: the prefix, which is no secret, is in the audit row of the creation.
    expect(
      rows.some((row) => row.table === "audit_events" && row.text.includes(credential.keyPrefix))
    ).toBe(true);
    const loggedTraces = () => traces.filter((trace) => fixture.logged.join("\n").includes(trace));
    expect(loggedTraces()).toEqual([]);

    const runs = await fixture.runs("api_credentials.create");
    expect(runs).toHaveLength(1);
    expect(first.headers["operation-run-id"]).toBe(runs[0]?.id);
    expect(runs[0]).toMatchObject({ status: "done", idempotencyKey: "create-key-once" });
    expect(runs[0]?.output).toBeUndefined();
    expect(runs[0]?.resultRef).toBeUndefined();

    // The same call again is told that the answer is gone. It mints nothing and shows nothing.
    const again = await create();
    expect(again.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(again.json()).error).toMatchObject({
      code: "OUTPUT_NOT_RETAINED",
      details: { operationRunId: runs[0]?.id }
    });
    expect(again.headers["operation-run-id"]).toBe(runs[0]?.id);
    expect(again.payload).not.toContain(random);
    expect(await fixture.runs("api_credentials.create")).toHaveLength(1);
    expect(
      await fixture.store.apiAccess.listApiCredentials({
        clientInstanceId: fixture.clientInstanceId,
        servicePrincipalId: asServicePrincipalId(principal.id)
      })
    ).toHaveLength(1);
    expect(holding(await storedRows())).toEqual([]);
    expect(loggedTraces()).toEqual([]);

    // The key of the first call with another input is another call, and it is refused.
    const other = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.id },
      headers: { ...superadmin, "idempotency-key": "create-key-once" },
      payload: { name: "Another key" }
    });
    expect(other.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(other.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  // Fails without input assembled from the declared parts: the query replaced the body's field
  // before the handler's check, so a key with the query's expiry was issued.
  it("takes a field of the body from the body, whatever the query string says", async () => {
    const fixture = await createFixture();
    const principal = await createPrincipal(fixture, "Query");
    const future = new Date(Date.now() + 60_000).toISOString();
    const refused = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.id },
      headers: superadmin,
      undeclaredQuery: { expiresAt: future, name: "From the query" },
      payload: { name: "Expired", expiresAt: "2020-01-01T00:00:00.000Z" }
    });
    expect(refused.statusCode).toBe(422);
    expect(apiErrorResponseSchema.parse(refused.json()).error.message).toBe(
      "API credential expiry must be in the future"
    );
    // A stray query string is ignored and not refused, as on a plain route.
    const created = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.id },
      headers: superadmin,
      undeclaredQuery: {
        name: "From the query",
        scopes: "config_assets:release",
        servicePrincipalId: "spn_other"
      },
      payload: { name: "From the body", scopes: ["config_assets:read"] }
    });
    expect(created.statusCode).toBe(200);
    const stored = await fixture.store.apiAccess.listApiCredentials({
      clientInstanceId: fixture.clientInstanceId,
      servicePrincipalId: asServicePrincipalId(principal.id)
    });
    expect(stored.map(({ name, scopes, expiresAt }) => ({ name, scopes, expiresAt }))).toEqual([
      { name: "From the body", scopes: ["config_assets:read"], expiresAt: undefined }
    ]);
  });

  it("declares no waiting answer for the call that answers the key", () => {
    const { responses } = openApiJsonOperation("api_credentials.create");
    expect(Object.keys(responses)).toContain("200");
    expect(Object.keys(responses)).not.toContain("202");
    expect(Object.keys(openApiJsonOperation("service_principals.create").responses)).toContain(
      "202"
    );
    expect(apiOperations["api_credentials.create"].errors).not.toContain("DECLINED");
    // The other three changes can wait for an approval and say so.
    expect(apiOperations["api_credentials.revoke"].accepted).toBeDefined();
  });

  it("records each change as one run of its caller, with the audit rows of the change", async () => {
    const fixture = await createFixture();
    const principal = await createPrincipal(fixture, "Recorded");
    const update = await fixture.server.call("service_principals.update", {
      params: { servicePrincipalId: principal.id },
      headers: superadmin,
      payload: { description: "Changed" }
    });
    const created = await fixture.server.call("api_credentials.create", {
      params: { servicePrincipalId: principal.id },
      headers: superadmin,
      payload: { name: "Key" }
    });
    const { credential } = createdCredentialSchema.parse(created.json());
    const revoke = await fixture.server.call("api_credentials.revoke", {
      params: { credentialId: credential.id },
      headers: superadmin
    });
    expect([update.statusCode, created.statusCode, revoke.statusCode]).toEqual([200, 200, 200]);

    const changes = [
      ["service_principals.create", "api_access.service_principal_created", principal.id],
      ["service_principals.update", "api_access.service_principal_updated", principal.id],
      ["api_credentials.create", "api_access.credential_created", credential.id],
      ["api_credentials.revoke", "api_access.credential_revoked", credential.id]
    ] as const;
    const events = await fixture.store.audit.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 100
    });
    for (const [operation, changeEvent, subject] of changes) {
      const runs = await fixture.runs(operation);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "done",
        effect: "changing",
        actor: { kind: "user", id: fixture.users.superadmin.id },
        decision: { mode: "direct", by: fixture.users.superadmin.id }
      });
      const ofRun = events.filter((event) => event.metadata?.operationRunId === runs[0]?.id);
      expect(ofRun.map((event) => `${event.type}:${event.status}`).sort()).toEqual([
        `${changeEvent}:success`,
        "operation.authorization_checked:success",
        "operation.completed:success",
        "operation.started:success"
      ]);
      expect(ofRun.find((event) => event.type === changeEvent)).toMatchObject({
        subject,
        actor: { userId: fixture.users.superadmin.id }
      });
    }
    // The run records that the caller was let through. The workflow writes no second row for it.
    expect(events.filter((event) => event.type.endsWith("_authorized"))).toEqual([]);
  });

  it("creates one principal for a call that is sent twice with one key", async () => {
    const fixture = await createFixture();
    const create = () =>
      fixture.server.call("service_principals.create", {
        headers: { ...superadmin, "idempotency-key": "principal-once" },
        payload: { displayLabel: "Sent twice", permissions: ["config_assets.read"] }
      });
    const first = await create();
    const second = await create();
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    expect(
      await fixture.store.apiAccess.listServicePrincipals({
        clientInstanceId: fixture.clientInstanceId
      })
    ).toHaveLength(1);
  });

  it("refuses an admin who is not a superadmin before anything runs, and records the refusal", async () => {
    const fixture = await createFixture();
    const principal = await createPrincipal(fixture, "Guarded");
    const credential = createdCredentialSchema.parse(
      (
        await fixture.server.call("api_credentials.create", {
          params: { servicePrincipalId: principal.id },
          headers: superadmin,
          payload: { name: "Guarded key" }
        })
      ).json()
    ).credential;
    const before = await storedRows();
    const untouched = (rows: Awaited<ReturnType<typeof storedRows>>) =>
      rows
        .filter((row) => ["service_principals", "api_credentials"].includes(row.table))
        .map((row) => row.text)
        .sort();

    const calls = [
      ["service_principals.create", { payload: { displayLabel: "Refused" } }],
      [
        "service_principals.update",
        { params: { servicePrincipalId: principal.id }, payload: { status: "disabled" } }
      ],
      [
        "api_credentials.create",
        { params: { servicePrincipalId: principal.id }, payload: { name: "Refused key" } }
      ],
      ["api_credentials.revoke", { params: { credentialId: credential.id } }]
    ] as const;
    for (const [operation, request] of calls) {
      // Holds `api_access.manage` and the admin role, and is no superadmin.
      const manager = await fixture.server.call(operation, {
        ...request,
        headers: { authorization: "Bearer admin-manager" }
      });
      expect(manager.statusCode).toBe(403);
      expect(apiErrorResponseSchema.parse(manager.json()).error).toMatchObject({
        code: "FORBIDDEN",
        details: { action: operation, reason: "no_grant" }
      });
      // An admin without the right is told the right, as before.
      const admin = await fixture.server.call(operation, {
        ...request,
        headers: { authorization: "Bearer admin" }
      });
      expect(admin.statusCode).toBe(403);
      expect(apiErrorResponseSchema.parse(admin.json()).error).toMatchObject({
        code: "FORBIDDEN",
        message: "Missing the right 'api_access.manage'",
        details: { action: "api_access.manage", reason: "no_grant" }
      });

      const refused = (await fixture.runs(operation)).filter((run) => run.status === "denied");
      expect(refused.map((run) => run.actor.id).sort()).toEqual(
        [fixture.users.admin.id, fixture.users["admin-manager"].id].sort()
      );
      const events = await fixture.store.audit.listAuditEvents({
        clientInstanceId: fixture.clientInstanceId,
        limit: 200
      });
      for (const run of refused) {
        expect(run.id).toBe(
          (run.actor.id === fixture.users.admin.id ? admin : manager).headers["operation-run-id"]
        );
        // One row for the check of the right, and the row every refused run ends with.
        expect(
          events
            .filter((event) => event.metadata?.operationRunId === run.id)
            .map((event) => `${event.type}:${event.status}`)
            .sort()
        ).toEqual(["operation.authorization_checked:denied", "operation.denied:denied"]);
      }
    }
    expect(untouched(await storedRows())).toEqual(untouched(before));
  });
});

const superadmin = { authorization: "Bearer superadmin" };

/**
 * What a kept key could look like in a row: the key, its random part and the first 12
 * characters of that part, each as it is and as base64 and base64url. An encoding is cut to
 * whole groups of three bytes, so it is found whatever follows the value.
 */
function keyTraces(secret: string, random: string): string[] {
  return [secret, random, random.slice(0, 12)].flatMap((value) => {
    const whole = Buffer.from(value.slice(0, value.length - (value.length % 3)));
    return [value, whole.toString("base64"), whole.toString("base64url")];
  });
}

const createdCredentialSchema = z.object({
  secret: z.string(),
  credential: z.object({ id: z.string(), keyPrefix: z.string() })
});

async function createPrincipal(fixture: Awaited<ReturnType<typeof createFixture>>, label: string) {
  const response = await fixture.server.call("service_principals.create", {
    headers: superadmin,
    payload: { displayLabel: label, permissions: ["config_assets.read"] }
  });
  expect(response.statusCode).toBe(200);
  return z.object({ principal: z.object({ id: z.string() }) }).parse(response.json()).principal;
}

/** Every row of every table of this file's database, as the text Postgres holds. */
async function storedRows(): Promise<{ table: string; text: string }[]> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
  try {
    const tables = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
    const rows: { table: string; text: string }[] = [];
    for (const { schema, name } of tables) {
      const found = await sql.unsafe<{ text: string }[]>(
        `select row_to_json(t)::text as text from "${schema}"."${name}" t`
      );
      rows.push(...found.map(({ text }) => ({ table: name, text })));
    }
    return rows;
  } finally {
    await sql.end();
  }
}

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
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
    tools: []
  });
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  // Every line the server logs, at every level, with its fields.
  const logged: string[] = [];
  const keep =
    (level: string) =>
    (...line: unknown[]): void =>
      // A request object is circular, so the line is kept as Node prints it, to any depth.
      void logged.push(inspect([level, ...line], { depth: null, maxStringLength: null }));
  const logger: Logger = {
    debug: keep("debug"),
    info: keep("info"),
    warn: keep("warn"),
    error: keep("error"),
    child: () => logger
  };
  const server = await createTestInstance({
    server: {
      config,
      logger,
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
  const runs = async (operation: string) =>
    (await store.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === operation
    );
  return { clientInstanceId, server, store, users, logged, runs };
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
