import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { describe, expect, it } from "vitest";
import { apiOperations, type ApiOperationName, type Operation } from "@vivd-catalyst/api-contract";
import { HmacSessionTokenIssuer } from "@vivd-catalyst/auth";
import { platformModules } from "@vivd-catalyst/client-assembly";
import { createModuleRegistry } from "@vivd-catalyst/core";
import {
  FIRST_PARTY_AUTH_SCOPES,
  PERMISSIONS,
  legacyPermissionFor,
  operationPathParamNames
} from "./support/route-catalog";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { createTestInstanceWith, listTestRoutes, type TestInstance } from "./support/test-instance";

// Generated from the catalog: every operation the server registers is called the ways it must
// refuse. An operation added to the catalog is covered here without a line written for it.

const authAdapter = createCallerAuthAdapter();
let instance: TestInstance;
beforeAll(async () => {
  instance = await createTestInstanceWith((stores) => ({
    authAdapter,
    // Every module is on: an operation of a module that is off answers 404 before any of the
    // refusals this file asks for.
    modules: createModuleRegistry(platformModules).snapshot(
      Object.fromEntries(platformModules.map((module) => [module.name, { enabled: true }]))
    ),
    approvalRequests: { store: stores.approvals, handlers: new Map() },
    allowedOrigins: ["https://ui.example.test"],
    mail: {
      sender: { send: () => Promise.resolve({ ok: true }) },
      appUrl: "https://ui.example.test",
      listCaptured: () => []
    },
    sessionToken: {
      serverCredential: "route-authorization-server-credential",
      issuer: new HmacSessionTokenIssuer({
        secret: "route-authorization-session-token-secret",
        issuer: "test",
        clientInstanceId: "route_authorization_test",
        ttlSeconds: 60
      })
    }
  }));
});

const names = Object.keys(apiOperations).filter(
  (name): name is ApiOperationName => name in apiOperations
);
// Read through the descriptor's own type: each catalog entry is narrower than a test needs.
const descriptor = (name: ApiOperationName): Operation => apiOperations[name];
const authenticated = names.flatMap((name) => {
  const operation = descriptor(name);
  return operation.auth === "user" || operation.auth === "principal" ? [{ name, operation }] : [];
});

/**
 * A body the operation's schema accepts, for the operations that require an action: the
 * holder's rights are checked after the input, so a refusal for a missing right needs one.
 */
const acceptedBodies: Partial<Record<ApiOperationName, unknown>> = {
  "config_agents.set_default": { agentName: "agent" },
  "config_agents.set_availability": { mode: "all" },
  "config_assets.replace": { agents: [], skills: [], baseVersion: null },
  "config_assets.validate": { agents: [], skills: [] },
  "service_principals.create": { displayLabel: "Service" },
  "service_principals.update": { displayLabel: "Service" },
  "api_credentials.create": { name: "Credential" },
  "users.create": { displayLabel: "Person" },
  "users.update": { displayLabel: "Person" },
  "users.identities.upsert": { authSource: "test", externalUserId: "person" },
  "users.password.reset": { password: "long-enough-password" },
  "permissions.grant": {
    holderKind: "user",
    holderId: "missing",
    action: "agent.write",
    scopeKind: "instance"
  },
  "namespaces.create": { prefix: "team-", displayName: "Team" },
  "namespaces.update": { displayName: "Team" }
};
const acceptedQueries: Partial<Record<ApiOperationName, Record<string, string>>> = {
  "permissions.effective": { holderKind: "user", holderId: "missing" }
};

function call(name: ApiOperationName, as: ReturnType<typeof asCaller>, headers = {}) {
  const operation = descriptor(name);
  const payload = acceptedBodies[name];
  const query = acceptedQueries[name];
  return instance.call(
    name,
    {
      params: Object.fromEntries(
        operationPathParamNames(operation.path).map((param) => [param, "missing"])
      ),
      headers,
      ...(query === undefined ? {} : { query }),
      ...(payload === undefined ? {} : { payload })
    },
    as
  );
}

const everyRight = { roles: ["superadmin"], permissions: [...PERMISSIONS] };

describe("every operation of the catalog", () => {
  // This instance runs without the sign-in library, so its mount is absent. The preflight
  // route belongs to the CORS plugin.
  it("is registered, and nothing else is", async () => {
    const registered = (await listTestRoutes(instance))
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    const catalog = names.map((name) => `${descriptor(name).method} ${descriptor(name).path}`);
    expect(registered).toEqual([...catalog, "OPTIONS *"].sort());
    expect(catalog).toEqual(
      expect.arrayContaining([
        "GET /health",
        "GET /api/v1/dev/captured-mail",
        "POST /api/v1/instance/session-tokens"
      ])
    );
  });

  // The reference of the instance asks no scope: whoever is signed in may read what it offers.
  const unscoped = authenticated.filter(({ operation }) => operation.scope === null);
  it("asks a scope of every operation but the two of the reference", () => {
    expect(unscoped.map(({ name }) => name)).toEqual(["openapi.get", "docs.get"]);
  });

  it.each(authenticated.filter((entry) => !unscoped.includes(entry)))(
    "$name refuses a credential without its scope",
    async (entry) => {
      const { name } = entry;
      const { scope } = entry.operation;
      const scopes = FIRST_PARTY_AUTH_SCOPES.filter((other) => other !== "*" && other !== scope);
      const response = await call(name, asCaller({ ...everyRight, scopes }));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: `Missing auth scope '${scope}'`
        }
      });
    }
  );

  const requiring = authenticated.flatMap(({ name, operation }) =>
    operation.requires.map((action) => {
      const missing = legacyPermissionFor(action);
      // Two actions can stand behind one legacy permission; the first of them refuses.
      const refused = operation.requires.find((other) => legacyPermissionFor(other) === missing);
      return [name, action, missing, refused ?? action] as const;
    })
  );
  it.each(requiring)("%s refuses a holder without %s", async (name, _action, missing, refused) => {
    const response = await call(
      name,
      asCaller({
        scopes: ["*"],
        roles: ["user"],
        permissions: PERMISSIONS.filter((permission) => permission !== missing)
      })
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "FORBIDDEN",
        message: `Missing the right '${refused}'`,
        details: { action: refused, reason: "no_grant" }
      }
    });
  });

  it.each(authenticated.filter(({ operation }) => operation.auth === "user"))(
    "$name refuses a service principal",
    async ({ name }) => {
      const response = await call(
        name,
        asCaller({ kind: "service", scopes: ["*"], permissions: [...PERMISSIONS] })
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Service principals cannot access user-scoped routes"
        }
      });
    }
  );

  it.each(authenticated)(
    "$name refuses an explicit credential against an ambient adapter",
    async ({ name }) => {
      const before = authAdapter.calls;
      const response = await call(name, asCaller(everyRight), { authorization: "Bearer anything" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "UNAUTHENTICATED",
          message: "Auth adapter does not accept explicit credentials"
        }
      });
      expect(authAdapter.calls).toBe(before);
    }
  );

  const guarded = authenticated.filter(({ operation }) => operation.method !== "GET");
  it.each(guarded)("$name refuses a session cookie from a foreign origin", async ({ name }) => {
    const response = await call(name, asCaller({ ...everyRight, cookie: true }), {
      origin: "https://foreign.test"
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "FORBIDDEN",
        message: "Session request origin is not allowed"
      }
    });
  });

  // A descriptor carries one scope. Starting a run needs a second one, checked by the handler.
  it.each(["conversations.runs.start", "conversations.runs.create"] as const)(
    "%s refuses a token that may write conversations but not start runs",
    async (name) => {
      const response = await instance.call(
        name,
        {
          ...(name === "conversations.runs.start" ? { params: { conversationId: "missing" } } : {}),
          payload: { idempotencyKey: "run-start-refusal", message: { text: "Hello" } }
        },
        asCaller({
          ...everyRight,
          scopes: FIRST_PARTY_AUTH_SCOPES.filter((scope) => scope !== "*" && scope !== "run:start")
        })
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Missing auth scope 'run:start'"
        }
      });
    }
  );

  it("guards the reading operations that are served by POST", () => {
    const readingByPost = guarded.filter(({ operation }) => operation.effect === "reading");
    expect(readingByPost.map(({ name }) => name)).toContain("config_assets.validate");
  });

  it.each(names.filter((name) => descriptor(name).auth === "serverCredential"))(
    "%s refuses a caller without the server credential",
    async (name) => {
      const response = await call(name, asCaller(everyRight));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Invalid server credential"
        }
      });
    }
  );
});
