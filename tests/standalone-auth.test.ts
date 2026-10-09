import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import postgres, { type Sql } from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  bindTestTransport,
  createTestInstance,
  createTestInstanceWith
} from "./support/test-instance";
import { testOperations } from "./support/operations";

import { afterAll, describe, expect, it, vi } from "vitest";
import { API_VERSION_PREFIX, issueSessionTokenResponseSchema } from "@vivd-catalyst/api-contract";
import { asClientInstanceId } from "@vivd-catalyst/core";

import {
  CompositeAuthAdapter,
  DevelopmentAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import { routeTestOperations } from "./support/operations";
import Fastify from "../packages/chat-server/node_modules/fastify/fastify.js";
import { installErrorHandler } from "../packages/chat-server/src/errors";
import { registerBetterAuthRoutes } from "../packages/chat-server/src/routes/better-auth-routes";

describe("standalone auth email routes", () => {
  const baseUrl = "http://localhost:3000";
  const email = "provisioned@example.test";
  const password = "provisioned-password";
  let auth: StandaloneAuthRuntime;
  let sql: Sql;
  let authUserId: string;

  beforeAll(async () => {
    await createTestInstance();
    const databaseUrl = await fileTestDatabaseUrl();
    sql = postgres(databaseUrl, { max: 1 });
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("standalone_auth_test"),
      databaseUrl,
      secret: "test-secret-at-least-32-characters-long",
      baseUrl,
      rateLimit: false
    });
    const signIn = await auth.setOrCreatePasswordSignIn({
      email,
      displayLabel: "Provisioned User",
      password,
      roles: ["user"],
      permissionRefs: [],
      permissions: []
    });
    const [user] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
    if (!user) throw new Error("Provisioned auth user missing");
    authUserId = user.id;
    expect(signIn.email).toBe(email);
  });

  afterAll(async () => {
    await auth?.close();
    await sql?.end();
  });

  it("rejects public email sign-up without creating a user", async () => {
    const response = await postAuth(testOperations.authSignUp.buildPath({}), {
      name: "Public User",
      email: "public@example.test",
      password: "public-password"
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED"
    });
    expect(await sql`select id from "user"`).toHaveLength(1);
  });

  it("still signs in a provisioned user", async () => {
    const response = await postAuth(testOperations.authSignIn.buildPath({}), { email, password });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: { email }
    });
  });

  it("issues a session token for an embedding host at the canonical path beside the sign-in library", async () => {
    const clientInstanceId = asClientInstanceId("standalone_auth_test");
    const tokenOptions = {
      clientInstanceId,
      secret: "test-session-token-secret-long-enough",
      issuer: "embedding-host",
      ttlSeconds: 900
    };
    const server = await createTestInstanceWith((stores) => ({
      clientInstanceId,
      standaloneAuth: auth,
      authAdapter: new IdentityResolvingAuthAdapter(
        new CompositeAuthAdapter([auth.authAdapter, new HmacSessionTokenAuthAdapter(tokenOptions)]),
        stores.users
      ),
      sessionToken: {
        serverCredential: "embedding-host-credential",
        issuer: new HmacSessionTokenIssuer(tokenOptions)
      }
    }));
    try {
      expect(testOperations["session_tokens.issue"].path).toBe(
        `${API_VERSION_PREFIX}/instance/session-tokens`
      );
      const payload = { externalUserId: "embedded-user", displayLabel: "Embedded User" };

      const refused = await server.call("session_tokens.issue", {
        headers: { "x-server-credential": "not-the-credential" },
        payload
      });
      expect(refused.statusCode).toBe(403);

      const issued = await server.call("session_tokens.issue", {
        headers: { "x-server-credential": "embedding-host-credential" },
        payload
      });
      expect(issued.statusCode).toBe(200);
      const { chatSessionToken } = issueSessionTokenResponseSchema.parse(issued.json());

      const me = await server.call("me.get", {
        headers: { authorization: `Bearer ${chatSessionToken}` }
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        authSource: "session-token",
        externalUserId: "embedded-user",
        displayLabel: "Embedded User"
      });

      // The sign-in library's mount never takes the server credential.
      const mount = await server.call("authSession", {
        headers: { "x-server-credential": "embedding-host-credential" }
      });
      expect(mount.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("marks successful session-cookie authentication on the adapter result", async () => {
    const response = await postAuth(testOperations.authSignIn.buildPath({}), { email, password });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    const user = await auth.authAdapter.authenticate({
      headers: { cookie },
      clientInstanceId: asClientInstanceId("standalone_auth_test"),
      correlationId: "cookie-auth-test"
    });
    expect(user).toMatchObject({
      id: authUserId,
      authenticationMethod: "session-cookie"
    });
    await expect(
      auth.authAdapter.authenticate({
        headers: {},
        clientInstanceId: asClientInstanceId("standalone_auth_test"),
        correlationId: "no-cookie-test"
      })
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("prefers a valid bearer identity over a valid session cookie", async () => {
    const { composite, request, cookie, chatSessionToken } = await createMixedCredentials();
    await expect(composite.authenticate(request)).resolves.toMatchObject({
      id: authUserId,
      authenticationMethod: "session-cookie"
    });
    await expect(
      composite.authenticate({
        ...request,
        headers: { cookie, authorization: `Bearer ${chatSessionToken}` }
      })
    ).resolves.toMatchObject({ externalUserId: "widget-user" });
  });

  it("refuses invalid explicit credentials without cookie or development fallback", async () => {
    const { composite, request, cookie } = await createMixedCredentials();
    for (const headers of [
      { authorization: "Bearer invalid" },
      { Authorization: "Bearer invalid" },
      { authorization: "" },
      { authorization: "Basic invalid" },
      { "x-server-credential": "invalid" },
      { "X-Server-Credential": "" }
    ]) {
      await expect(
        composite.authenticate({ ...request, headers: { cookie, ...headers } })
      ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
  });

  it("does not apply the cookie origin guard to a token authenticated request", async () => {
    const {
      composite,
      request: { clientInstanceId },
      cookie,
      chatSessionToken
    } = await createMixedCredentials();
    const server = await createTestInstanceWith(
      () => ({ clientInstanceId, authAdapter: composite }),
      (route) =>
        route(routeTestOperations.testIdentityWrite, ({ user }) => ({
          externalUserId: user.externalUserId
        }))
    );
    const headers = { cookie, origin: "https://foreign.test" };
    try {
      const refused = await server.call("testIdentityWrite", { headers });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "Session request origin is not allowed" }
      });
      const withToken = await server.call("testIdentityWrite", {
        headers: { ...headers, authorization: `Bearer ${chatSessionToken}` }
      });
      expect(withToken.statusCode).toBe(200);
      expect(withToken.json()).toMatchObject({ externalUserId: "widget-user" });
      const withInvalidToken = await server.call("testIdentityWrite", {
        headers: { ...headers, authorization: "Bearer invalid" }
      });
      expect(withInvalidToken.statusCode).toBe(401);
      expect(withInvalidToken.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "refuses explicit credentials before calling a direct ambient adapter (wrapped: %s)",
    async (wrapped) => {
      const {
        cookie,
        request: { clientInstanceId }
      } = await createMixedCredentials();
      const authAdapter = wrapped
        ? new IdentityResolvingAuthAdapter(
            auth.authAdapter,
            (await createTestInstance()).stores.users
          )
        : auth.authAdapter;
      const authenticate = vi.spyOn(auth.authAdapter, "authenticate");
      const server = await createTestInstanceWith(
        () => ({ clientInstanceId, authAdapter }),
        (route) =>
          route(routeTestOperations.testIdentity, ({ user }) => ({
            externalUserId: user.externalUserId
          }))
      );
      try {
        const response = await server.call("testIdentity", {
          headers: { cookie, authorization: "Bearer invalid" }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
        expect(authenticate).not.toHaveBeenCalled();
      } finally {
        authenticate.mockRestore();
        await server.close();
      }
    }
  );

  it.each([
    ["authorization", "authSession"],
    ["authorization", "authSignOut"],
    ["x-server-credential", "authSession"],
    ["x-server-credential", "authSignOut"]
  ] as const)("refuses %s on %s without changing the session", async (header, operation) => {
    const { cookie, chatSessionToken } = await createMixedCredentials();
    const httpServer = Fastify();
    const server = await bindTestTransport(httpServer, () => httpServer.close());
    installErrorHandler(httpServer);
    registerBetterAuthRoutes(httpServer, { standaloneAuth: auth });
    try {
      const sessionBefore = await sql`select * from session order by id`;
      for (const value of [
        header === "authorization" ? `Bearer ${chatSessionToken}` : "invalid",
        ""
      ]) {
        const response = await server.call(operation, {
          headers: { cookie, origin: baseUrl, [header]: value }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(await sql`select * from session order by id`).toEqual(sessionBefore);
      }

      const session = await server.call("authSession", { headers: { cookie } });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ user: { id: authUserId } });
      const signedOut = await server.call("authSignOut", { headers: { cookie, origin: baseUrl } });
      expect(signedOut.statusCode).toBe(200);
      expect(await sql`select * from session`).toHaveLength(sessionBefore.length - 1);
      const afterSignOut = await server.call("authSession", { headers: { cookie } });
      expect(afterSignOut.statusCode).toBe(200);
      expect(afterSignOut.json()).toBeNull();
    } finally {
      await server.close();
    }
  });

  async function createMixedCredentials() {
    const response = await postAuth(testOperations.authSignIn.buildPath({}), { email, password });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const clientInstanceId = asClientInstanceId("standalone_auth_test");
    const tokenOptions = {
      clientInstanceId,
      secret: "test-session-token-secret-long-enough",
      issuer: "widget",
      ttlSeconds: 900
    };
    const { chatSessionToken } = new HmacSessionTokenIssuer(tokenOptions).issue({
      externalUserId: "widget-user",
      displayLabel: "Widget User"
    });
    // Put ambient adapters first so precedence cannot depend on adapter order.
    const composite = new CompositeAuthAdapter([
      auth.authAdapter,
      new DevelopmentAuthAdapter({
        enabled: true,
        user: {
          id: "dev",
          externalUserId: "dev",
          displayLabel: "Dev",
          roles: [],
          permissionRefs: []
        }
      }),
      new HmacSessionTokenAuthAdapter(tokenOptions)
    ]);
    const request = { clientInstanceId, correlationId: "precedence-test", headers: { cookie } };
    return { composite, request, cookie, chatSessionToken };
  }

  function postAuth(path: string, body: Record<string, string>): Promise<Response> {
    return auth.handleRequest(
      new Request(new URL(path, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      })
    );
  }
});
