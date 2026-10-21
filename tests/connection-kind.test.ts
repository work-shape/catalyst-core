import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  connectionConfigSchema,
  releaseConnectionConfigSchema,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_MAX_ACCEPTED_OPERATIONS,
  asClientInstanceId,
  createConnectionSecretHandle,
  createConnectorTypeRegistry,
  findConnectorTypeIssues,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import { createEgressChecker, createFixtureDocumentSource } from "@work-shape/catalyst-connections";
import { createConnectionAssetKind } from "@work-shape/catalyst-server";
import { agent, clientInstanceId, errorSchema } from "./support/access-instance";
import { assetPageSchema } from "./support/asset-operations";
import {
  FIXTURE_SECRET_HANDLE,
  connection,
  fixtureConnectorType,
  fixtureConnectorTypes,
  setupConnectionInstance,
  type ConnectionInstance
} from "./support/connections";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig } from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { setupAppActions } from "./support/app-actions";

// The Connection kind: what its definition may hold, that a secret has no place in it, that
// the asset operations write a Connection made on the instance and never one of release
// config, and that the kind does not exist while its module is off.

type ConnectionInstanceStores = ConnectionInstance["stores"];

/** A text that stands for a credential. No answer, row or issue below may repeat it. */
const SECRET = "sk-live-9f8e7d6c5b4a";

const validationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ message: z.string(), path: z.array(z.string()).optional() }))
});

function issuesOf(config: unknown) {
  const parsed = connectionConfigSchema.safeParse(config);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }));
}

describe("the definition of a Connection", () => {
  // Fails while `paging` and `limits` are stored and read by nothing: an operator would
  // believe a limit that no call keeps.
  it("accepts reading paging and refuses source limits until EW-13s", () => {
    const base = {
      name: "accounting",
      displayName: "Accounting",
      connectorType: "mcp",
      ownerPrincipalId: "system",
      authScheme: "bearer",
      origin: "release"
    };
    const paging = { by: "page", param: "page", sizeParam: "page_size", size: 1000 };
    const limits = { concurrency: 2, perPeriod: { calls: 60, seconds: 60 } };
    expect(
      issuesOf({
        ...base,
        operations: [{ name: "list_postings", effect: "reading", paging, limits }]
      })
    ).toEqual([
      {
        path: "operations.0.limits",
        message: "'limits' on an operation of a Connection is not supported yet (not_supported_yet)"
      }
    ]);
    // Release config is read by its own schema and refuses the same.
    expect(() =>
      parseClientInstanceConfig({
        ...createTestConfig(),
        modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
        connections: {
          accounting: {
            connectorType: "mcp",
            authScheme: "none",
            operations: [{ name: "list_postings", effect: "reading", limits }]
          }
        }
      })
    ).toThrow(/not_supported_yet/u);
  });

  // `service` only picks an icon, so the schema knows no list of services: a slug nobody has
  // an icon for is kept, and what is no slug is refused.
  it("keeps a service slug it has no icon for and refuses what is no slug", () => {
    const base = {
      name: "accounting",
      displayName: "Accounting",
      connectorType: "mcp",
      ownerPrincipalId: "system",
      authScheme: "bearer",
      origin: "release"
    };
    expect(connectionConfigSchema.parse({ ...base, service: "no-such-system" }).service).toBe(
      "no-such-system"
    );
    expect(connectionConfigSchema.parse(base).service).toBeUndefined();
    for (const service of ["", "DATEV", "a b", "-datev", "a".repeat(41)]) {
      expect(connectionConfigSchema.safeParse({ ...base, service }).success, service).toBe(false);
    }
    const config = parseClientInstanceConfig({
      ...createTestConfig(),
      modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
      connections: { accounting: { connectorType: "mcp", authScheme: "none", service: "datev" } }
    });
    expect(releaseConnectionConfigSchema.parse(config.connections.accounting).service).toBe(
      "datev"
    );
  });

  it("reads a definition and fills what it leaves out", () => {
    const parsed = connectionConfigSchema.parse({
      name: "exampledata",
      displayName: "Exampledata",
      connectorType: "mcp",
      ownerPrincipalId: "system",
      authScheme: "bearer",
      operations: [{ name: "list_clients", effect: "reading" }],
      origin: "release"
    });
    expect(parsed).toEqual({
      name: "exampledata",
      displayName: "Exampledata",
      connectorType: "mcp",
      ownerPrincipalId: "system",
      settings: {},
      authScheme: "bearer",
      credentialMode: "shared",
      // No exposure means callable by nobody.
      operations: [{ name: "list_clients", effect: "reading", exposure: [], enabled: true }],
      enabled: true,
      origin: "release"
    });
  });

  it("refuses a credential in the settings and never repeats it", () => {
    const refused: Array<[string, JsonObject, string]> = [
      ["userinfo", { url: `https://user:${SECRET}@host.example.test/mcp` }, "settings.url"],
      ["user name alone", { url: `https://${SECRET}@host.example.test/mcp` }, "settings.url"],
      [
        "query parameter",
        { url: `https://host.example.test/mcp?api_key=${SECRET}` },
        "settings.url"
      ],
      [
        "database address",
        { dsn: `postgres://reader:${SECRET}@db.example.test:5432/app` },
        "settings.dsn"
      ],
      ["header", { headers: { "X-Api-Key": SECRET } }, "settings.headers.X-Api-Key"],
      [
        "authorization header",
        { headers: { Authorization: SECRET } },
        "settings.headers.Authorization"
      ],
      ["bearer value", { extra: [`Bearer ${SECRET}`] }, "settings.extra.0"],
      ["named key", { clientSecret: SECRET }, "settings.clientSecret"],
      ["token", { nested: { access_token: SECRET } }, "settings.nested.access_token"],
      // A credential-named key is refused whatever stands under it.
      ["list", { token: [SECRET.slice(0, 8), SECRET.slice(8)] }, "settings.token"],
      ["object", { apiKey: { value: SECRET } }, "settings.apiKey"],
      ["number", { pin: 1, password: 12345678 }, "settings.password"],
      ["name with value", { tokenValue: SECRET }, "settings.tokenValue"],
      ["jwt", { serviceJwt: SECRET }, "settings.serviceJwt"],
      ["key in a list", { servers: [{ secret_key: [SECRET] }] }, "settings.servers.0.secret_key"]
    ];
    for (const [label, settings, path] of refused) {
      const issues = issuesOf(connection("outside", { settings }));
      expect(issues, label).toHaveLength(1);
      expect(issues[0]?.path, label).toBe(path);
      expect(issues[0]?.message, label).toMatch(/^credential_in_settings: /u);
      expect(JSON.stringify(issues), label).not.toContain(SECRET);
    }
  });

  it("keeps settings that only name where a credential goes", () => {
    const settings = {
      url: "https://host.example.test/mcp?tenant=acme",
      headerName: "X-Api-Key",
      requiresToken: true,
      schemas: ["public"]
    };
    expect(issuesOf(connection("outside", { settings }))).toEqual([]);
  });

  it("holds a handle of the Secret Store and nothing else where the handle belongs", () => {
    expect(
      issuesOf(connection("outside", { secretHandle: createConnectionSecretHandle() }))
    ).toEqual([]);
    const pasted = issuesOf(connection("outside", { secretHandle: SECRET }));
    expect(pasted).toEqual([
      {
        path: "secretHandle",
        message: "secretHandle must be a handle of the Secret Store, never a secret"
      }
    ]);
    // A field the schema does not name is refused, so no secret travels beside the handle.
    for (const field of ["secret", "token", "credential"]) {
      const issues = issuesOf(connection("outside", { [field]: SECRET }));
      expect(issues.map((issue) => issue.message).join(" "), field).toContain("Unrecognized key");
      expect(JSON.stringify(issues), field).not.toContain(SECRET);
    }
  });

  it("accepts a policy that tightens and no other", () => {
    const withPolicy = (effect: string, policy: string) =>
      issuesOf(
        connection("outside", { operations: [{ name: "write", effect, exposure: [], policy }] })
      );
    expect(withPolicy("changing", "approval")).toEqual([]);
    expect(withPolicy("changing", "deny")).toEqual([]);
    expect(withPolicy("reading", "deny")).toEqual([]);
    expect(withPolicy("reading", "approval")).toEqual([
      {
        path: "operations.0.policy",
        message: "Only a changing operation can carry the policy 'approval'"
      }
    ]);
    // Loosening is the instance's setting and no value of a Connection.
    expect(withPolicy("changing", "allow")).toHaveLength(1);
    expect(withPolicy("changing", "confirm")).toHaveLength(1);
  });

  it("accepts a header for the idempotency key on a changing operation, and no header of the request itself", () => {
    const withHeader = (effect: string, idempotencyKeyHeader: string) =>
      issuesOf(
        connection("outside", {
          operations: [{ name: "write", effect, exposure: [], idempotencyKeyHeader }]
        })
      );
    expect(withHeader("changing", "Idempotency-Key")).toEqual([]);
    expect(withHeader("reading", "Idempotency-Key")).toEqual([
      {
        path: "operations.0.idempotencyKeyHeader",
        message: "Only a changing operation can name a header for its idempotency key"
      }
    ]);
    // A name is accepted for what it says it is, and for nothing else.
    for (const named of ["X-Request-Id", "Stripe-Idempotency-Key", "Acme-Request-Id"]) {
      expect(withHeader("changing", named)).toEqual([]);
    }
    // Fails without the change: every name that starts with `X-` passed, a credential's and
    // a proxy's among them.
    for (const other of [
      "X-Api-Key",
      "X-HTTP-Method-Override",
      "X-Original-URL",
      "X-Amz-Security-Token",
      "X-",
      "X-Forwarded-For",
      "Expect",
      "Upgrade",
      "Authorization",
      "content-type",
      "Mcp-Session-Id",
      "Cookie",
      "-Request-Id",
      "a header-Request-Id",
      `${"a".repeat(60)}-Request-Id`
    ]) {
      expect(withHeader("changing", other)).toEqual([
        {
          path: "operations.0.idempotencyKeyHeader",
          message:
            "The header of an idempotency key is 'Idempotency-Key' or a name of at most 64 letters, digits and hyphens that ends in '-Idempotency-Key' or '-Request-Id'"
        }
      ]);
    }
  });

  it("refuses an operation without an effect, a doubled operation and too many of them", () => {
    expect(
      issuesOf(connection("outside", { operations: [{ name: "echo", exposure: ["agent"] }] }))
    ).toMatchObject([{ path: "operations.0.effect" }]);
    expect(
      issuesOf(
        connection("outside", {
          operations: [
            { name: "echo", effect: "reading" },
            { name: "echo", effect: "changing" }
          ]
        })
      )
    ).toEqual([{ path: "operations.1.name", message: "Duplicate operation: echo" }]);
    const many = Array.from({ length: CONNECTION_MAX_ACCEPTED_OPERATIONS + 1 }, (_, index) => ({
      name: `tool_${index}`,
      effect: "reading"
    }));
    expect(issuesOf(connection("outside", { operations: many }))).toEqual([
      {
        path: "operations",
        message: `A Connection accepts at most ${CONNECTION_MAX_ACCEPTED_OPERATIONS} operations (CONNECTION_MAX_ACCEPTED_OPERATIONS)`
      }
    ]);
    expect(issuesOf(connection("outside", { operations: many.slice(1) }))).toEqual([]);
  });

  it("refuses a name that could not end an operation name, and a personal credential", () => {
    for (const name of ["Outside", "out.side", "out side", "-outside", "x".repeat(65)]) {
      expect(issuesOf(connection(name)), name).toMatchObject([{ path: "name" }]);
    }
    expect(issuesOf(connection("kai-outside_2"))).toEqual([]);
    expect(issuesOf(connection("outside", { credentialMode: "user" }))).toMatchObject([
      { path: "credentialMode" }
    ]);
  });
});

describe("the Connector types of a build", () => {
  it("refuses a type registered twice or with a malformed id", () => {
    expect(() => createConnectorTypeRegistry([fixtureConnectorType, fixtureConnectorType])).toThrow(
      "Connector type 'fixture' is registered more than once"
    );
    expect(() =>
      createConnectorTypeRegistry([{ ...fixtureConnectorType, type: "Fixture.Type" }])
    ).toThrow("must be lowercase words joined by underscores");
    expect(fixtureConnectorTypes.get("fixture")).toBe(fixtureConnectorType);
    // A form must sign in as the type does, and asks for one secret at most.
    const field = { label: "Secret", secret: true } as const;
    const form = { title: "Fixture", description: "For tests.", fields: [field] };
    expect(() =>
      createConnectorTypeRegistry([
        { ...fixtureConnectorType, form: { ...form, authScheme: "not_a_scheme" } }
      ])
    ).toThrow("must use one of its auth schemes and ask for one secret at most");
    const scheme = fixtureConnectorType.authSchemes[0] ?? "none";
    expect(() =>
      createConnectorTypeRegistry([
        { ...fixtureConnectorType, form: { ...form, authScheme: scheme, fields: [field, field] } }
      ])
    ).toThrow("ask for one secret at most");
    expect(
      createConnectorTypeRegistry([
        { ...fixtureConnectorType, form: { ...form, authScheme: scheme } }
      ]).get("fixture")?.form?.authScheme
    ).toBe(scheme);
    expect(fixtureConnectorTypes.get("mcp")).toBeUndefined();
  });

  it("refuses a Connection of a type the build does not ship, and settings the type does not read", () => {
    const check = (overrides: Record<string, unknown>) =>
      findConnectorTypeIssues(fixtureConnectorTypes, {
        connectorType: "fixture",
        settings: { url: "https://outside.example.test/mcp" },
        authScheme: "bearer",
        operations: [],
        ...overrides
      });
    expect(check({})).toEqual([]);
    expect(check({ connectorType: "mcp" })).toEqual([
      {
        message: "connector_type_unknown: this instance has no connector type 'mcp'",
        path: ["connectorType"]
      }
    ]);
    expect(
      check({ settings: { url: "https://outside.example.test", note: SECRET } })
    ).toMatchObject([{ path: ["settings"] }]);
    expect(JSON.stringify(check({ settings: { note: SECRET } }))).not.toContain(SECRET);
    expect(check({ authScheme: "oauth" })).toEqual([
      {
        message: "Connector type 'fixture' offers the auth schemes: none, bearer",
        path: ["authScheme"]
      }
    ]);
  });
});

describe("a Connection through the asset operations", () => {
  const put = (name: string, overrides = {}) => ({
    params: { kind: "connection", name },
    payload: { config: connection(name, overrides) }
  });
  const stored = async (t: { stores: ConnectionInstanceStores }, name: string) =>
    (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "connection", name }))
      ?.config;

  it("creates a Connection of the instance: origin, owner and handle are the server's", async () => {
    const t = await setupConnectionInstance();
    // What the caller claims of origin, owner and handle is not what is stored.
    await t.expectOk(t.admin.id, "assets.put", put("made-here", { ownerPrincipalId: "someone" }));
    const created = await stored(t, "made-here");
    expect(created).toMatchObject({
      origin: "runtime",
      ownerPrincipalId: t.admin.id,
      credentialMode: "shared"
    });
    expect(created?.secretHandle).toMatch(/^secret_/u);
    expect(created?.secretHandle).not.toBe(FIXTURE_SECRET_HANDLE);

    // A later write keeps the owner and the handle, whoever writes and whatever is sent.
    await t.expectOk(t.root.id, "assets.put", put("made-here", { enabled: false }));
    const changed = await stored(t, "made-here");
    expect(changed).toMatchObject({ enabled: false, ownerPrincipalId: t.admin.id });
    expect(changed?.secretHandle).toBe(created?.secretHandle);

    // Without a credential there is no handle.
    await t.expectOk(t.admin.id, "assets.put", put("made-here", { authScheme: "none" }));
    expect(await stored(t, "made-here")).not.toHaveProperty("secretHandle");
  });

  it("refuses every write of a release Connection, and takes put, revert and delete of a runtime one", async () => {
    const t = await setupConnectionInstance();
    await t.seed("outside");
    await t.seed("made-here", { origin: "runtime" });
    const readOnly = { status: 403, code: "FORBIDDEN", details: { reason: "read_only_origin" } };
    const address = (name: string) => ({ params: { kind: "connection", name } });
    // A put that changes it, and one that leaves it as it is stored.
    await t.expectRefused(t.admin.id, "assets.put", put("outside", { enabled: false }), readOnly);
    await t.expectRefused(t.admin.id, "assets.put", put("outside"), readOnly);
    await t.expectRefused(
      t.admin.id,
      "assets.revert",
      { ...address("outside"), payload: { revision: 1, expectedRevision: 1 } },
      readOnly
    );
    await t.expectRefused(
      t.admin.id,
      "assets.delete",
      { ...address("outside"), payload: { expectedRevision: 1 } },
      readOnly
    );
    // A superadmin is refused the same: the refusal is no missing right.
    await t.expectRefused(t.root.id, "assets.put", put("outside"), readOnly);

    await t.expectOk(t.admin.id, "assets.put", put("made-here", { enabled: false }));
    await t.expectOk(t.admin.id, "assets.revert", {
      ...address("made-here"),
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(await stored(t, "made-here")).toMatchObject({ enabled: true, origin: "runtime" });
    await t.expectOk(t.admin.id, "assets.delete", {
      ...address("made-here"),
      payload: { expectedRevision: 3 }
    });
    expect(await stored(t, "made-here")).toBeNull();

    // A batch of a workspace carries no Connection, which no workspace owns, and a release
    // carries agents and skills only.
    const team = await t.sharedWorkspace("Kai's team");
    const batch = await t.call(t.admin.id, "assets.sync", {
      payload: {
        workspaceId: team,
        items: [{ type: "put", kind: "connection", config: connection("kai-outside") }]
      }
    });
    expect(batch.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(batch.json())).toContain("A connection cannot be owned by a workspace");
    const release = await t.instance.call("assets.sync", {
      headers: { "x-test-service": "release" },
      payload: { items: [{ type: "put", kind: "connection", config: connection("released") }] }
    });
    expect(release.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(release.json())).toContain("is not part of a release");
    expect(await stored(t, "kai-outside")).toBeUndefined();
    expect(await stored(t, "released")).toBeUndefined();
  });

  it("refuses the delete of a Connection an agent carries a tool of, and says how many", async () => {
    const t = await setupConnectionInstance();
    await t.seed("made-here", { origin: "runtime" });
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "helper",
          config: { ...agent("helper"), toolNames: ["connection.made-here.echo"] }
        }
      ]
    });
    const refused = await t.expectRefused(
      t.admin.id,
      "assets.delete",
      { params: { kind: "connection", name: "made-here" }, payload: { expectedRevision: 1 } },
      {
        status: 409,
        code: "CONFLICT",
        details: { reason: "connection_in_use", agentCount: 1, appCount: 0 }
      }
    );
    // The agent's name is not told: the caller may not read it.
    expect(refused.message).not.toContain("helper");
    expect(await stored(t, "made-here")).toMatchObject({ origin: "runtime" });
  });

  it("refuses the delete of a Connection an App names, in its draft or what it serves", async () => {
    const t = await setupAppActions();
    // `orders` names `crm` and `erp` in its draft and in its published revision.
    await t.seed("crm", { origin: "runtime" });
    const crm = { params: { kind: "connection", name: "crm" } };
    await t.expectRefused(
      t.admin.id,
      "assets.delete",
      { ...crm, payload: { expectedRevision: 2 } },
      {
        status: 409,
        code: "CONFLICT",
        details: { reason: "connection_in_use", agentCount: 0, appCount: 1 }
      }
    );
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "crm"
      })
    ).toMatchObject({ status: "active" });
    await t.closeAll();
  });

  it("refuses the delete of a Connection only the published revision of an App names", async () => {
    const t = await setupAppActions();
    await t.seed("crm", { origin: "runtime" });
    // The draft no longer names `crm`; the published revision 1 still serves it.
    const draft = await t.putApp(t.admin.id, "orders", [
      {
        path: "app.yaml",
        text: JSON.stringify({
          id: "orders",
          name: "Orders",
          kit: "1.1.0",
          entry: "index.html",
          connections: ["erp"]
        })
      },
      { path: "index.html", text: "<!doctype html><title>Orders</title><p>erp only</p>" }
    ]);
    expect(draft.statusCode).toBe(200);
    const deleted = await t.call(t.admin.id, "assets.delete", {
      params: { kind: "connection", name: "crm" },
      payload: { expectedRevision: 2 }
    });
    expect(deleted.statusCode).toBe(409);
    await t.expectRefused(
      t.admin.id,
      "assets.delete",
      { params: { kind: "connection", name: "crm" }, payload: { expectedRevision: 2 } },
      {
        status: 409,
        code: "CONFLICT",
        details: { reason: "connection_in_use", agentCount: 0, appCount: 1 }
      }
    );
    await t.closeAll();
  });

  it("says in validate what a put would be refused for", async () => {
    const t = await setupConnectionInstance();
    const validate = async (overrides: JsonObject) => {
      const response = await t.expectOk(t.admin.id, "assets.validate", {
        params: { kind: "connection" },
        payload: { config: connection("outside", overrides) }
      });
      expect(response.body).not.toContain(SECRET);
      return validationSchema.parse(response.json());
    };
    const userinfo = await validate({
      settings: { url: `https://user:${SECRET}@host.example.test/mcp` }
    });
    expect(userinfo.valid).toBe(false);
    expect(userinfo.issues).toEqual([
      {
        message:
          "credential_in_settings: the setting is an address with a user name or a password. A credential belongs in the Secret Store",
        path: ["settings", "url"]
      }
    ]);
    expect((await validate({ connectorType: "mcp" })).issues).toEqual([
      {
        message: "connector_type_unknown: this instance has no connector type 'mcp'",
        path: ["connectorType"]
      }
    ]);
    expect((await validate({ authScheme: "oauth" })).issues).toMatchObject([
      { path: ["authScheme"] }
    ]);
    // A definition nothing is wrong with is one a put takes, whatever origin it claims.
    expect(await validate({})).toEqual({ valid: true, issues: [] });
  });

  it("lists and reads a seeded Connection with its handle and no secret", async () => {
    const t = await setupConnectionInstance();
    const id = await t.seed("outside", { description: "The outside system.", service: "ledger" });
    await t.seed("paused", { enabled: false, origin: "runtime", secretHandle: undefined });
    const page = (
      await t.expectOk(t.admin.id, "assets.list", { params: { kind: "connection" } })
    ).json<{ items: Array<Record<string, unknown>> }>();
    expect(assetPageSchema.parse(page).items.map((item) => item.name)).toEqual([
      "outside",
      "paused"
    ]);
    expect(page.items[0]).toMatchObject({
      id,
      kind: "connection",
      name: "outside",
      title: "Connection outside",
      description: "The outside system.",
      scope: { kind: "instance" },
      revision: 1,
      // The key of its icon, where it names one.
      attributes: { connectorType: "fixture", origin: "release", enabled: true, service: "ledger" }
    });
    expect(page.items[1]?.attributes).not.toHaveProperty("service");
    expect(page.items[1]).toMatchObject({
      attributes: { connectorType: "fixture", origin: "runtime", enabled: false }
    });
    // The list carries no content: neither the settings nor the handle.
    expect(JSON.stringify(page)).not.toContain(FIXTURE_SECRET_HANDLE);
    expect(JSON.stringify(page)).not.toContain("outside.example.test");

    const read = (
      await t.expectOk(t.admin.id, "assets.get", {
        params: { kind: "connection", name: "outside" }
      })
    ).json<{ config: Record<string, unknown> }>();
    expect(read.config).toEqual(
      connection("outside", { description: "The outside system.", service: "ledger" })
    );
    const history = (
      await t.expectOk(t.admin.id, "assets.revisions.list", {
        params: { kind: "connection", name: "outside" }
      })
    ).json<{ items: Array<{ config: Record<string, unknown> }> }>();
    expect(history.items.map((revision) => revision.config.secretHandle)).toEqual([
      FIXTURE_SECRET_HANDLE
    ]);
  });

  it("leaves a write to another asset alone when a stored Connection names a type that is gone", async () => {
    const t = await setupConnectionInstance();
    await t.seed("legacy", { connectorType: "removed_type" });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "helper" },
      payload: { config: agent("helper") }
    });
  });

  it("names the kind with its rights in the context", async () => {
    const t = await setupConnectionInstance();
    const context = (await t.expectOk(t.admin.id, "platform.context.get")).json<{
      kinds: Array<{ kind: string; plural: string; actions: Record<string, string> }>;
      actions: string[];
    }>();
    expect(context.kinds.find((kind) => kind.kind === "connection")).toEqual({
      kind: "connection",
      plural: "connections",
      lifecycle: "active",
      representation: "config",
      owners: ["instance"],
      actions: {
        read: "connection.read",
        // Using a Connection is a right of its own, and the Check tab asks for it by this name.
        use: "connection.use",
        write: "connection.write",
        delete: "connection.delete"
      },
      // What a service principal can be granted on one Connection, and nothing that changes it.
      principalActions: ["connection.use"]
    });
    expect(context.kinds.find((kind) => kind.kind === "agent")).not.toHaveProperty(
      "principalActions"
    );
    // The kinds without such a right name none.
    expect(context.kinds.find((kind) => kind.kind === "agent")?.actions).toEqual({
      read: "agent.read",
      write: "agent.write",
      publish: "agent.publish",
      delete: "agent.delete"
    });
    expect(context.actions).toEqual(
      expect.arrayContaining(["agent.read", "connection.read", "connection.write"])
    );
    // A person who holds nothing on the instance is told of no action there.
    const kai = (await t.expectOk(t.kai.id, "platform.context.get")).json<{ actions: string[] }>();
    expect(kai.actions).toEqual([]);
  });
});

describe("the module connections", () => {
  const moduleOff = { reason: "module_off", module: "connections" };
  const configWith = (enabled: boolean | undefined) =>
    parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: {
        assetManagement: { enabled: true },
        ...(enabled === undefined ? {} : { connections: { enabled } })
      },
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } }
    });
  const start = (enabled: boolean | undefined, restarted = false) =>
    createTestInstance({
      config: configWith(enabled),
      env: {},
      tools: [],
      ...(restarted ? { seedAssets: false } : {})
    });
  const kindsOf = async (instance: Awaited<ReturnType<typeof start>>) =>
    (await instance.call("platform.context.get", {}))
      .json<{ kinds: Array<{ kind: string }> }>()
      .kinds.map((kind) => kind.kind);

  it("is off unless release config turns it on", () => {
    expect(
      resolveInstanceModules(configWith(undefined), []).snapshot.isEnabled("connections")
    ).toBe(false);
    expect(resolveInstanceModules(configWith(true), []).snapshot.isEnabled("connections")).toBe(
      true
    );
  });

  it("registers the kind on an assembled instance while it is on", async () => {
    const instance = await start(true);
    expect(await kindsOf(instance)).toEqual(["agent", "skill", "connection", "guardrail"]);
    const listed = await instance.call("assets.list", { params: { kind: "connection" } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
    // The assembly registers no Connector type yet, so a definition names an unknown one.
    const validated = await instance.call("assets.validate", {
      params: { kind: "connection" },
      payload: { config: connection("outside") }
    });
    expect(validationSchema.parse(validated.json()).issues).toEqual([
      {
        message: "connector_type_unknown: this instance has no connector type 'fixture'",
        path: ["connectorType"]
      }
    ]);
  });

  it("makes the kind absent while it is off, and keeps what the store holds", async () => {
    const on = await start(true);
    await applyAtCurrentRevisions(on.stores.configAssets, {
      clientInstanceId: asClientInstanceId(getTestConfig(on).clientInstance.id),
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name: "outside",
          // Not of release config: what release config defines follows it at every start.
          config: connection("outside", { origin: "runtime" })
        }
      ]
    });
    for (const enabled of [false, undefined]) {
      const off = await start(enabled, true);
      expect(await kindsOf(off)).toEqual(["agent", "skill", "guardrail"]);
      const address = { params: { kind: "connection", name: "outside" } };
      const calls = [
        off.call("assets.list", { params: { kind: "connection" } }),
        off.call("assets.get", address),
        off.call("assets.revisions.list", address),
        off.call("assets.validate", {
          params: { kind: "connection" },
          payload: { config: connection("outside") }
        }),
        off.call("assets.put", { ...address, payload: { config: connection("outside") } }),
        off.call("assets.delete", { ...address, payload: { expectedRevision: 1 } }),
        off.call("assets.sync", {
          payload: {
            workspaceId: "ws_kai",
            items: [{ type: "put", kind: "connection", config: connection("kai-outside") }]
          }
        }),
        off.call("permissions.grant", {
          payload: {
            holderKind: "user",
            holderId: "user-1",
            action: "connection.use",
            scopeKind: "asset",
            scopeId: "asset-1"
          }
        })
      ];
      for (const response of await Promise.all(calls)) {
        expect(response.statusCode, response.body).toBe(404);
        expect(errorSchema.parse(response.json()).error).toMatchObject({
          code: "NOT_FOUND",
          details: moduleOff
        });
      }
      // The agents of the instance are served as before.
      expect((await off.call("assets.list", { params: { kind: "agent" } })).statusCode).toBe(200);
      await off.close();
    }

    // Nothing was deleted: turned on again, the Connection is there.
    const again = await start(true, true);
    const listed = await again.call("assets.list", { params: { kind: "connection" } });
    expect(assetPageSchema.parse(listed.json()).items.map((item) => item.name)).toEqual([
      "outside"
    ]);
  });
});

describe("a Connection a Knowledge Base can sync documents through", () => {
  it("is marked in the list, so the Knowledge Base page offers it as a source (SRC-2)", () => {
    const folders: ConnectorTypeDefinition = {
      ...fixtureConnectorType,
      type: "folders",
      documentSource: createFixtureDocumentSource({ secret: "test", pageSize: 10 }).capability
    };
    const kind = createConnectionAssetKind({
      connectorTypes: createConnectorTypeRegistry([fixtureConnectorType, folders]),
      egress: createEgressChecker({ allow: [], resolve: () => Promise.resolve([]) })
    });
    const summary = (overrides: Record<string, JsonValue | undefined>) =>
      kind.summarize(connectionConfigSchema.parse(connection("handbook", overrides)));
    expect(summary({ connectorType: "folders" }).attributes).toMatchObject({
      connectorType: "folders",
      documentSource: true
    });
    expect(summary({}).attributes).not.toHaveProperty("documentSource");
  });
});
