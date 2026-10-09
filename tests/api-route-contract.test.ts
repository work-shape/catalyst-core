import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  apiOperations,
  apiErrorResponseSchema,
  listQuerySchema,
  timestampSchema,
  type Operation
} from "@vivd-catalyst/api-contract";
import { HmacSessionTokenIssuer } from "@vivd-catalyst/auth";
import {
  AppError,
  asClientInstanceId,
  StoreBackedAuditRecorder,
  type Logger
} from "@vivd-catalyst/core";
import type { Route } from "@vivd-catalyst/chat-server";
import { createTestConfig } from "./support/fixtures";
import { routeTestOperations as operations } from "./support/operations";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { createTestInstanceWith } from "./support/test-instance";

// The route helper is the one place a product route is registered. These tests register
// fixture operations through it and prove what it does for every operation: who it lets in,
// which scope and rights it asks for, in which order, and what it lets out.

const serverCredential = "route-contract-server-credential";
const allowedOrigin = "https://ui.example.test";
const secret = "payload-that-must-not-leave";

async function createServer(
  input: { sessionToken?: boolean; environment?: "development" | "staging" | "production" } = {}
) {
  const authAdapter = createCallerAuthAdapter();
  const handled: string[] = [];
  const errors: { input: unknown; message?: string }[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (logged, message) => void errors.push({ input: logged, message }),
    child: () => logger
  };
  const config = createTestConfig();
  const server = await createTestInstanceWith(
    (stores) => ({
      authAdapter,
      logger,
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: asClientInstanceId(config.clientInstance.id),
        store: stores.audit
      }),
      config: {
        ...config,
        clientInstance: {
          ...config.clientInstance,
          environment: input.environment ?? "development"
        }
      },
      allowedOrigins: [allowedOrigin],
      ...((input.sessionToken ?? true)
        ? {
            sessionToken: {
              serverCredential,
              issuer: new HmacSessionTokenIssuer({
                secret: "route-contract-session-token-secret",
                issuer: "test",
                clientInstanceId: "route_contract_test",
                ttlSeconds: 60
              })
            }
          }
        : {})
    }),
    (route) => registerFixtures(route, handled)
  );
  return { server, authAdapter, handled, errors };
}

function registerFixtures(route: Route, handled: string[]): void {
  const ok = (id: string) => () => {
    handled.push(id);
    return { value: "ok" };
  };
  route(operations.testList, ({ query }) =>
    query.filter === "bad-timestamp"
      ? [{ id: "row", createdAt: secret }]
      : Array.from({ length: 260 }, (_, index) => ({
          id: String(index).padStart(3, "0"),
          createdAt: "2026-10-09T12:00:00.000Z"
        }))
  );
  route(operations.testPublic, ok("testPublic"));
  route(operations.testServerCredential, ok("testServerCredential"));
  route(operations.testUser, ok("testUser"));
  route(operations.testPrincipal, ok("testPrincipal"));
  route(operations.testReadingPost, ok("testReadingPost"));
  route(operations.testInput, ({ params, query, body }) => {
    handled.push("testInput");
    return { itemId: params.itemId, view: query.view, count: body.count };
  });
  route(operations.testResponse, ({ query }) => {
    handled.push("testResponse");
    switch (query.result) {
      case "wrong-value":
        return { value: secret };
      case "wrong-shape":
        return { value: "ok", count: Number.NaN };
      case "hidden-error":
        throw new Error(secret);
      case "internal-error":
        throw new AppError("INTERNAL", secret, { secret });
      case "rate-limited":
        throw new AppError("RATE_LIMITED", "Try again later", { retryAfterSeconds: 10 });
      case "exposed-internal":
        throw new AppError("INTERNAL", secret, { secret }, { exposeMessage: true });
      case "refusal":
        throw new AppError("CONFLICT", "The item changed", { currentVersion: 2 });
      default:
        return { value: "ok", count: 1 };
    }
  });
}

const allRights = { roles: ["superadmin"] };

describe("route helper: who may call", () => {
  it("serves a public operation without authenticating anybody", async () => {
    const { server, authAdapter } = await createServer();
    const response = await server.call("testPublic", {
      headers: { authorization: "Bearer anything" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: "ok" });
    expect(authAdapter.calls).toBe(0);
  });

  it("accepts only the instance's server credential on a server-credential operation", async () => {
    const { server, authAdapter, handled } = await createServer();
    for (const headers of [
      {},
      { "x-server-credential": "wrong" },
      { "x-server-credential": `${serverCredential}x` },
      { authorization: `Bearer ${serverCredential}` },
      asCaller(allRights).headers
    ]) {
      const refused = await server.call("testServerCredential", { headers });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Invalid server credential"
        }
      });
    }
    expect(handled).toEqual([]);
    const accepted = await server.call("testServerCredential", {
      headers: { "x-server-credential": serverCredential }
    });
    expect(accepted.statusCode).toBe(200);
    expect(authAdapter.calls).toBe(0);
  });

  it("answers not found on a server-credential operation when none is configured", async () => {
    const { server } = await createServer({ sessionToken: false });
    const response = await server.call("testServerCredential", {
      headers: { "x-server-credential": serverCredential }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { correlationId: expect.any(String), code: "NOT_FOUND" }
    });
  });

  it("refuses a service principal on a user operation and accepts it on a principal one", async () => {
    const { server, handled } = await createServer();
    const service = asCaller({
      kind: "service",
      permissions: ["audit.view", "usage.view"]
    });
    const onUserRoute = await server.call("testUser", {}, service);
    expect(onUserRoute.statusCode).toBe(403);
    expect(onUserRoute.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "FORBIDDEN",
        message: "Service principals cannot access user-scoped routes"
      }
    });
    expect(handled).toEqual([]);
    expect((await server.call("testPrincipal", {}, service)).statusCode).toBe(200);
    expect((await server.call("testPrincipal", {}, asCaller(allRights))).statusCode).toBe(200);
  });

  it.each(["authorization", "x-server-credential"])(
    "refuses an explicit %s credential before an ambient adapter runs",
    async (header) => {
      const { server, authAdapter, handled } = await createServer();
      for (const operation of ["testUser", "testPrincipal", "testInput"] as const) {
        const response = await server.call(operation, {
          ...(operation === "testInput" ? { params: { itemId: "1" } } : {}),
          headers: { ...asCaller(allRights).headers, [header]: "anything" }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: {
            correlationId: expect.any(String),
            code: "UNAUTHENTICATED",
            message: "Auth adapter does not accept explicit credentials"
          }
        });
      }
      expect(authAdapter.calls).toBe(0);
      expect(handled).toEqual([]);
    }
  );

  it("guards a cookie session by HTTP method, so a reading operation on POST is guarded too", async () => {
    const { server, handled } = await createServer();
    const cookie = asCaller({ ...allRights, cookie: true }).headers;
    expect(operations.testReadingPost.effect).toBe("reading");

    for (const headers of [
      { ...cookie, origin: "https://foreign.test" },
      { ...cookie, origin: `${allowedOrigin}.evil.test` },
      { ...cookie },
      { ...cookie, "sec-fetch-site": "same-site" },
      { ...cookie, origin: "https://foreign.test", "sec-fetch-site": "same-origin" }
    ]) {
      const refused = await server.call("testReadingPost", { headers });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Session request origin is not allowed"
        }
      });
    }
    expect(handled).toEqual([]);

    for (const headers of [
      { ...cookie, origin: allowedOrigin },
      { ...cookie, "sec-fetch-site": "same-origin" }
    ]) {
      expect((await server.call("testReadingPost", { headers })).statusCode).toBe(200);
    }
    // A GET is never guarded, and neither is a caller who did not sign in with a cookie.
    expect(
      (await server.call("testUser", { headers: { ...cookie, origin: "https://foreign.test" } }))
        .statusCode
    ).toBe(200);
    expect(
      (
        await server.call("testReadingPost", {
          headers: { ...asCaller(allRights).headers, origin: "https://foreign.test" }
        })
      ).statusCode
    ).toBe(200);
  });
});

describe("route helper: scope and rights", () => {
  it("requires the operation's scope on the credential, whatever the holder may do", async () => {
    const { server, handled } = await createServer();
    const withoutScope = await server.call(
      "testPrincipal",
      {},
      asCaller({ ...allRights, scopes: ["conversation:read", "governance:write"] })
    );
    expect(withoutScope.statusCode).toBe(403);
    expect(withoutScope.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "FORBIDDEN",
        message: "Missing auth scope 'governance:read'"
      }
    });
    expect(handled).toEqual([]);
  });

  it("requires every action of the operation from the holder, whatever the credential carries", async () => {
    const { server, handled } = await createServer();
    for (const [permissions, missing] of [
      [[], "audit.view"],
      [["usage.view"], "audit.view"],
      [["audit.view"], "usage.view"]
    ] as const) {
      const response = await server.call(
        "testPrincipal",
        {},
        asCaller({ scopes: ["*"], roles: ["user"], permissions: [...permissions] })
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: `Missing permission '${missing}'`
        }
      });
    }
    expect(handled).toEqual([]);
  });

  it("lets a call through only where the credential's scope and the holder's rights meet", async () => {
    const { server } = await createServer();
    const call = (scopes: string[], permissions: string[]) =>
      server.call("testPrincipal", {}, asCaller({ scopes, roles: ["user"], permissions }));
    const rights = ["audit.view", "usage.view"];
    expect((await call(["governance:read"], rights)).statusCode).toBe(200);
    expect((await call(["*"], rights)).statusCode).toBe(200);
    expect((await call(["governance:read"], [])).statusCode).toBe(403);
    expect((await call([], rights)).statusCode).toBe(403);
    expect((await call([], [])).statusCode).toBe(403);
  });

  it("checks in a fixed order: caller, scope, input, rights, handler", async () => {
    const { server, handled } = await createServer();
    const call = (caller: Parameters<typeof asCaller>[0], payload: unknown, view = "full") =>
      server.call(
        "testInput",
        { params: { itemId: "item 1" }, query: { view }, payload },
        asCaller(caller)
      );
    const message = async (response: ReturnType<typeof call>) => {
      const { statusCode, json } = await response;
      const body: unknown = json();
      return [statusCode, body];
    };

    // No scope, invalid input and no rights: the scope answers.
    expect(await message(call({ scopes: [] }, { count: "many" }))).toEqual([
      403,
      {
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Missing auth scope 'conversation:write'"
        }
      }
    ]);
    // Scope, invalid input and no rights: the input answers.
    const invalidBody = await call({}, { count: "many" });
    expect(invalidBody.statusCode).toBe(422);
    expect(invalidBody.json()).toMatchObject({
      error: {
        correlationId: expect.any(String),
        code: "VALIDATION_FAILED",
        message: "Request body is invalid"
      }
    });
    const invalidQuery = await call({}, { count: 1 }, "everything");
    expect(invalidQuery.statusCode).toBe(422);
    expect(invalidQuery.json()).toMatchObject({
      error: {
        correlationId: expect.any(String),
        code: "VALIDATION_FAILED",
        message: "Request query is invalid"
      }
    });
    // Scope and valid input, no rights: the rights answer.
    expect(await message(call({}, { count: 1 }))).toEqual([
      403,
      {
        error: {
          correlationId: expect.any(String),
          code: "FORBIDDEN",
          message: "Missing permission 'users.manage'"
        }
      }
    ]);
    expect(handled).toEqual([]);

    const accepted = await call(allRights, { count: 2 });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ itemId: "item 1", view: "full", count: 2 });
    expect(handled).toEqual(["testInput"]);
  });
});

describe("route helper: what leaves", () => {
  const read = async (result: string, environment?: "staging" | "production") => {
    const { server, errors } = await createServer({ environment });
    const response = await server.call("testResponse", { query: { result } }, asCaller());
    return Object.assign(response, { errors });
  };
  const mismatch = (path: string, code: string) => [
    {
      input: { operationId: "testResponse", issues: [{ path, code }] },
      message: "Operation response does not match its schema"
    }
  ];

  it("sends a response that matches the operation's schema", async () => {
    const response = await read("valid");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ value: "ok", count: 1 });
  });

  it.each([
    ["wrong-value", "value", "invalid_value"],
    ["wrong-shape", "count", "invalid_type"]
  ])(
    "in development, rejects a response outside the schema without sending it: %s",
    async (result, path, code) => {
      const response = await read(result);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "INTERNAL",
          message: "Internal server error"
        }
      });
      expect(response.body).not.toContain(secret);
      expect(response.errors).toEqual(mismatch(path, code));
    }
  );

  it.each(["staging", "production"] as const)(
    "in %s, sends a response outside the schema as the handler returned it and logs the mismatch",
    async (environment) => {
      const response = await read("wrong-value", environment);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ value: secret });
      // The log names the operation and where the mismatch is, never the value.
      expect(response.errors).toEqual(mismatch("value", "invalid_value"));
      expect(JSON.stringify(response.errors)).not.toContain(secret);

      const valid = await read("valid", environment);
      expect(valid.statusCode).toBe(200);
      expect(valid.errors).toEqual([]);
    }
  );

  it.each(["hidden-error", "internal-error", "exposed-internal"])(
    "answers an unexpected failure without its message or details: %s",
    async (result) => {
      const response = await read(result);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "INTERNAL",
          message: "Internal server error"
        }
      });
      expect(response.body).not.toContain(secret);
    }
  );

  it("correlates a RATE_LIMITED refusal and maps it to 429", async () => {
    const { server } = await createServer();
    const response = await server.call(
      "testResponse",
      {
        query: { result: "rate-limited" },
        headers: { "x-correlation-id": "caller-correlation" }
      },
      asCaller()
    );
    expect(response.statusCode).toBe(429);
    expect(response.headers["x-correlation-id"]).toBe("caller-correlation");
    expect(apiErrorResponseSchema.parse(response.json())).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Try again later",
        details: { retryAfterSeconds: 10 },
        correlationId: "caller-correlation"
      }
    });
  });

  it("answers a refusal with its code, message and details", async () => {
    const response = await read("refusal");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        correlationId: expect.any(String),
        code: "CONFLICT",
        message: "The item changed",
        details: { currentVersion: 2 }
      }
    });
  });
});

describe("operation catalog", () => {
  // Read through the descriptor's own type: each catalog entry is narrower than a test needs.
  const catalog: readonly Operation[] = Object.values(apiOperations);

  it("serves no changing operation on GET", () => {
    expect(
      catalog.filter((operation) => operation.effect === "changing" && operation.method === "GET")
    ).toEqual([]);
  });

  it("names each operation by its catalog key and each method and path once", () => {
    expect(
      Object.entries(apiOperations).filter(([key, operation]) => key !== operation.id)
    ).toEqual([]);
    const routes = catalog.map((operation) => `${operation.method} ${operation.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("gives every authenticated operation a scope and no other operation one", () => {
    for (const operation of catalog) {
      const authenticated = operation.auth === "user" || operation.auth === "principal";
      expect("scope" in operation, operation.id).toBe(authenticated);
      expect("requires" in operation, operation.id).toBe(authenticated);
    }
  });
});

describe("list and timestamp conventions", () => {
  it("defaults to 50, accepts at most 200, and rejects invalid limits before handling", async () => {
    const { server } = await createServer();
    const first = await server.call("testList", {}, asCaller());
    expect(first.statusCode).toBe(200);
    const body = operations.testList.response.schema.parse(first.json());
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).toBeTypeOf("string");
    const max = await server.call("testList", { query: { limit: 200 } }, asCaller());
    expect(operations.testList.response.schema.parse(max.json()).items).toHaveLength(200);
    for (const limit of [0, -1, 201, 1.5, "many", ""]) {
      expect((await server.call("testList", { query: { limit } }, asCaller())).statusCode).toBe(
        422
      );
    }
    expect(listQuerySchema.parse({}).limit).toBe(50);
  });

  it("uses exclusive tuple cursors across ties, and binds them to the list filters", async () => {
    const { server } = await createServer();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await server.call("testList", { query: { limit: 50, cursor } }, asCaller());
      expect(response.statusCode).toBe(200);
      const page = operations.testList.response.schema.parse(response.json());
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(260);
    expect(new Set(ids).size).toBe(260);
    expect(ids.slice(0, 2)).toEqual(["259", "258"]);
    const first = operations.testList.response.schema.parse(
      (await server.call("testList", {}, asCaller())).json()
    );
    for (const query of [
      { cursor: "not-a-cursor" },
      { cursor: first.nextCursor, filter: "another-list" }
    ]) {
      expect((await server.call("testList", { query }, asCaller())).statusCode).toBe(422);
    }
  });

  it("rejects invalid timestamp responses in development and cursor key types everywhere", async () => {
    const { server } = await createServer();
    const response = await server.call(
      "testList",
      { query: { filter: "bad-timestamp" } },
      asCaller()
    );
    expect(response.statusCode).toBe(500);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe("INTERNAL");
    expect(response.body).not.toContain(secret);
    const cursor = Buffer.from(
      JSON.stringify({ scope: JSON.stringify(["testList", {}, {}]), keys: [123, "259"] })
    ).toString("base64url");
    expect((await server.call("testList", { query: { cursor } }, asCaller())).statusCode).toBe(422);
  });

  it("lists the latest audit activities from one bounded read, without paging", async () => {
    const { server } = await createServer();
    const clientInstanceId = asClientInstanceId(createTestConfig().clientInstance.id);
    // Each event and each request gets its own moment, as on a running instance.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-09T12:00:00.000Z") });
    onTestFinished(() => void vi.useRealTimers());
    for (let index = 0; index < 700; index++) {
      vi.advanceTimersByTime(1000);
      await server.stores.audit.appendAuditEvent({
        clientInstanceId,
        type: "user.updated",
        status: "success",
        correlationId: `seed-${String(index).padStart(4, "0")}`
      });
    }
    const list = vi.spyOn(server.stores.audit, "listAuditEvents");
    const admin = asCaller({ permissions: ["audit.view"] });
    const read = async (query?: Record<string, string>) => {
      vi.advanceTimersByTime(1000);
      return server.call("listAuditActivities", query ? { query } : {}, admin);
    };

    const response = await read();
    expect(response.statusCode).toBe(200);
    const body = apiOperations.listAuditActivities.response.schema.parse(response.json());
    expect(response.json()).not.toHaveProperty("nextCursor");
    expect(body.items).toHaveLength(100);
    expect(body.items.slice(0, 2).map((activity) => activity.correlationId)).toEqual([
      expect.stringMatching(/^corr_/u),
      "seed-0699"
    ]);
    expect(list.mock.calls).toEqual([[{ clientInstanceId, limit: 500 }]]);

    // The operation declares no paging, so the contract has no cursor to send.
    expect(apiOperations.listAuditActivities).not.toHaveProperty("query");
    await expect(read({ cursor: "unknown" })).rejects.toThrow('Unknown query parameter "cursor"');

    list.mockRestore();
    const views = await server.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "governance.audit_events_viewed",
      limit: 100
    });
    expect(views).toHaveLength(1);
  });

  it("keeps the order people see: by name, by upload and by creation, each ending in the id", () => {
    const order = (operation: Operation) =>
      operation.response.kind === "page" ? operation.response.order : undefined;
    expect(order(apiOperations.listServicePrincipals)).toEqual([
      "principal.displayLabel",
      "principal.id"
    ]);
    for (const operation of [
      apiOperations.listDraftAttachments,
      apiOperations.listCollaborationWorkspaces,
      apiOperations.listCollaborationWorkspaceDirectory,
      apiOperations.listAdministeredCollaborationWorkspaces
    ]) {
      expect(order(operation), operation.id).toEqual(["createdAt", "id"]);
      expect(operation.response.kind === "page" && operation.response.descending).toBe(false);
    }
  });

  it("accepts UTC timestamps and rejects offsets, local times and invalid dates", () => {
    expect(timestampSchema.safeParse("2026-10-09T12:00:00.000Z").success).toBe(true);
    for (const timestamp of [
      "2026-10-09",
      "2026-10-09T12:00:00",
      "2026-10-09T12:00:00+02:00",
      "2026-02-30T12:00:00Z"
    ]) {
      expect(timestampSchema.safeParse(timestamp).success).toBe(false);
    }
  });

  it("conversation and workspace lists do not provision personal workspaces", async () => {
    const { server, authAdapter } = await createServer();
    const user = await server.stores.users.resolveUserIdentity({
      clientInstanceId: asClientInstanceId(createTestConfig().clientInstance.id),
      authSource: "test",
      externalUserId: "fresh",
      displayLabel: "Fresh user",
      roles: ["user"],
      permissions: [],
      permissionRefs: []
    });
    vi.spyOn(authAdapter, "authenticate").mockResolvedValue(user);
    const create = vi.spyOn(server.stores.workspaces, "ensurePersonalWorkspace");
    expect((await server.call("listConversations", {}, asCaller())).statusCode).toBe(200);
    expect((await server.call("listCollaborationWorkspaces", {}, asCaller())).statusCode).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(
      (await server.call("ensurePersonalCollaborationWorkspace", {}, asCaller())).statusCode
    ).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
