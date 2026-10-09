import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { apiOperations, OPERATION_RATE_LIMITS as RATE_LIMITS } from "@vivd-catalyst/api-contract";
import {
  CompositeAuthAdapter,
  HmacSessionTokenAuthAdapter,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import { createInProcessRateLimiter } from "@vivd-catalyst/chat-server";
import { asClientInstanceId, type RateLimiter, type RateLimitRule } from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { routeTestOperations } from "./support/operations";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  createTestInstance,
  createTestInstanceWith,
  getTestRuntime,
  type TestInstance
} from "./support/test-instance";

const MINUTE_MS = 60 * 1000;

describe("the operation catalog", () => {
  it("serves no changing operation on GET or HEAD", () => {
    const methods: string[] = ["GET", "HEAD"];
    expect(
      Object.values(apiOperations)
        .filter((operation) => operation.effect === "changing")
        .filter((operation) => methods.includes(operation.method))
        .map((operation) => operation.id)
    ).toEqual([]);
  });

  it("gives every operation a rate class the limiter has a rule for", () => {
    for (const operation of Object.values(apiOperations)) {
      expect(RATE_LIMITS[operation.rateClass], operation.id).toBeDefined();
    }
    // Changing a limit is a decision, so the numbers are written down twice.
    expect(RATE_LIMITS).toEqual({
      read: { limit: 600, windowMs: MINUTE_MS },
      write: { limit: 120, windowMs: MINUTE_MS },
      auth: { limit: 20, windowMs: 5 * MINUTE_MS }
    });
  });
});

describe("the in-process rate limiter", () => {
  const rule: RateLimitRule = { limit: 2, windowMs: MINUTE_MS };

  it("allows the limit within a window, refuses the rest and starts afresh after it", async () => {
    let time = 1_000;
    const limiter = createInProcessRateLimiter({ now: () => time });
    expect(await limiter.consume("a", rule)).toEqual({ allowed: true, retryAfterMs: 0 });
    time += 10_000;
    expect(await limiter.consume("a", rule)).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await limiter.consume("a", rule)).toEqual({ allowed: false, retryAfterMs: 50_000 });
    // Another key has its own count.
    expect(await limiter.consume("b", rule)).toEqual({ allowed: true, retryAfterMs: 0 });
    time += 50_000;
    expect(await limiter.consume("a", rule)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it("counts every limiter on its own, as two processes would", async () => {
    const first = createInProcessRateLimiter();
    const second = createInProcessRateLimiter();
    await first.consume("a", rule);
    await first.consume("a", rule);
    expect((await first.consume("a", rule)).allowed).toBe(false);
    expect((await second.consume("a", rule)).allowed).toBe(true);
  });
});

describe("rate limits on operations", () => {
  function recordingLimiter(limiter: RateLimiter) {
    const calls: Array<{ key: string; rule: RateLimitRule }> = [];
    const recording: RateLimiter = {
      consume(key, rule) {
        calls.push({ key, rule });
        return limiter.consume(key, rule);
      }
    };
    return { calls, recording };
  }

  function instanceWith(rateLimiter: RateLimiter): Promise<TestInstance> {
    return createTestInstanceWith(
      () => ({ rateLimiter }),
      (route) => {
        route(routeTestOperations.testPublic, () => ({ value: "ok" }));
        route(routeTestOperations.testUser, () => ({ value: "ok" }));
      }
    );
  }

  it("counts a signed-in caller by principal and a public call by client address", async () => {
    const { calls, recording } = recordingLimiter(createInProcessRateLimiter());
    const instance = await instanceWith(recording);

    expect((await instance.call("testUser", {}, "ada")).statusCode).toBe(200);
    expect(
      (
        await instance.call("testPublic", {
          remoteAddress: "172.18.0.5",
          headers: { "x-forwarded-for": "203.0.113.7" }
        })
      ).statusCode
    ).toBe(200);
    // A public peer is counted under its own address, whatever it claims to forward.
    await instance.call("testPublic", {
      remoteAddress: "198.51.100.9",
      headers: { "x-forwarded-for": "203.0.113.7" }
    });

    const ada = await instance.stores.users.listUsers({
      clientInstanceId: asClientInstanceId(createTestConfig().clientInstance.id)
    });
    expect(calls).toEqual([
      { key: `testUser|user:${ada[0]?.id}`, rule: RATE_LIMITS.read },
      { key: "testPublic|address:203.0.113.7", rule: RATE_LIMITS.read },
      { key: "testPublic|address:198.51.100.9", rule: RATE_LIMITS.read }
    ]);
  });

  it("answers a caller over the limit with 429, the error envelope and the time to wait", async () => {
    let time = Date.parse("2026-01-01T00:00:00.000Z");
    const instance = await instanceWith(createInProcessRateLimiter({ now: () => time }));
    const setUp = (address: string, forwardedFor?: string) =>
      instance.call("password_setup.complete", {
        remoteAddress: address,
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
        payload: { token: "not-a-token", password: "a-long-enough-password" }
      });

    // The credential class allows twenty calls in five minutes; each is answered on its merits.
    for (let attempt = 0; attempt < RATE_LIMITS.auth.limit; attempt += 1) {
      expect((await setUp("198.51.100.20", `203.0.113.${attempt}`)).statusCode).toBe(422);
    }
    time += 90_000;
    const refused = await setUp("198.51.100.20", "203.0.113.99");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("210");
    expect(refused.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
        details: { retryAfterSeconds: 210 },
        correlationId: refused.headers["x-correlation-id"]
      }
    });

    // Another address, and the same address on another operation, are not affected.
    expect((await setUp("198.51.100.21")).statusCode).toBe(422);
    expect((await instance.call("testPublic", { remoteAddress: "198.51.100.20" })).statusCode).toBe(
      200
    );

    time += 210_000;
    expect((await setUp("198.51.100.20")).statusCode).toBe(422);
  });

  it("refuses a signed-in caller over the limit and leaves other callers alone", async () => {
    const refuseAda: RateLimiter = {
      async consume(key) {
        return key.startsWith("testUser|")
          ? { allowed: false, retryAfterMs: 1 }
          : { allowed: true, retryAfterMs: 0 };
      }
    };
    const instance = await instanceWith(refuseAda);
    const refused = await instance.call("testUser", {}, "ada");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(refused.json()).toMatchObject({
      error: { code: "RATE_LIMITED", details: { retryAfterSeconds: 1 } }
    });
    expect((await instance.call("conversations.list", {}, "ada")).statusCode).toBe(200);
  });
});

describe("session cookies and tokens", () => {
  const baseUrl = "http://localhost:3000";
  const email = "edge@example.test";
  const password = "edge-controls-password";
  const tokenOptions = {
    clientInstanceId: asClientInstanceId(createTestConfig().clientInstance.id),
    secret: "test-session-token-secret-long-enough",
    issuer: "widget",
    ttlSeconds: 900
  };
  let auth: StandaloneAuthRuntime;
  let limited: StandaloneAuthRuntime;
  let sql: Sql;
  let instance: TestInstance;
  let limitedInstance: TestInstance;

  beforeAll(async () => {
    const databaseUrl = await fileTestDatabaseUrl();
    sql = postgres(databaseUrl, { max: 1 });
    const options = {
      clientInstanceId: tokenOptions.clientInstanceId,
      databaseUrl,
      secret: "test-secret-at-least-32-characters-long",
      baseUrl
    };
    auth = await createStandaloneAuthRuntime({ ...options, rateLimit: false });
    limited = await createStandaloneAuthRuntime({ ...options, rateLimit: true });
    await auth.setOrCreatePasswordSignIn({
      email,
      displayLabel: "Edge User",
      password,
      roles: ["user"],
      permissionRefs: [],
      permissions: []
    });
    instance = await createTestInstanceWith(
      (stores) => ({
        standaloneAuth: auth,
        allowedOrigins: ["https://allowed.test"],
        // As an instance assembles it: the cookie beside a token credential.
        authAdapter: new IdentityResolvingAuthAdapter(
          new CompositeAuthAdapter([
            auth.authAdapter,
            new HmacSessionTokenAuthAdapter(tokenOptions)
          ]),
          stores.users,
          { linkByVerifiedEmail: false }
        )
      }),
      (route) => {
        route(routeTestOperations.testUser, () => ({ value: "ok" }));
        route(routeTestOperations.testReadingPost, () => ({ value: "ok" }));
      }
    );
    limitedInstance = await createTestInstanceWith(() => ({ standaloneAuth: limited }));
  });
  afterAll(async () => {
    await sql?.end();
    await auth?.close();
    await limited?.close();
  });

  async function signIn(): Promise<{ name: string; cookie: string }> {
    const response = await instance.call("authSignIn", {
      headers: { origin: baseUrl },
      payload: { email, password }
    });
    expect(response.statusCode).toBe(200);
    const setCookie = [response.headers["set-cookie"] ?? []]
      .flat()
      .map(String)
      .find((value) => value.includes("session_token"));
    const cookie = setCookie?.split(";")[0] ?? "";
    return { name: cookie.slice(0, cookie.indexOf("=")), cookie };
  }

  it("refuses the stored session token without its signature, as cookie and as bearer", async () => {
    const { name, cookie } = await signIn();
    expect((await instance.call("testUser", { headers: { cookie } })).statusCode).toBe(200);

    // The value the database keeps in the clear. It is never printed: every assertion below
    // is on a status or on a boolean.
    const [session] = await sql<{ token: string }[]>`select token from session limit 1`;
    const stored = session?.token ?? "";
    expect(stored.length > 0).toBe(true);
    expect(cookie.includes(stored)).toBe(true);
    expect(cookie.endsWith(stored)).toBe(false);

    const asCookie = await instance.call("testUser", { headers: { cookie: `${name}=${stored}` } });
    expect(asCookie.statusCode).toBe(401);
    expect(asCookie.body.includes(stored)).toBe(false);
    const asBearer = await instance.call("testUser", {
      headers: { authorization: `Bearer ${stored}` }
    });
    expect(asBearer.statusCode).toBe(401);
    expect(asBearer.body.includes(stored)).toBe(false);
    // A bearer header is an explicit credential, so the valid cookie beside it does not count.
    const withCookie = await instance.call("testUser", {
      headers: { cookie, authorization: `Bearer ${stored}` }
    });
    expect(withCookie.statusCode).toBe(401);
  });

  it("guards a cookie-authenticated call by its HTTP method, also on a reading operation", async () => {
    const { cookie } = await signIn();
    const post = (headers: Record<string, string>) =>
      instance.call("testReadingPost", { headers: { cookie, ...headers }, payload: {} });

    expect((await post({ origin: "https://foreign.test" })).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ origin: "https://allowed.test" })).statusCode).toBe(200);
    expect((await post({ "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    // A GET is never guarded.
    expect(
      (await instance.call("testUser", { headers: { cookie, origin: "https://foreign.test" } }))
        .statusCode
    ).toBe(200);
  });

  it("answers a preflight for an allowed origin only", async () => {
    const preflight = (origin: string) =>
      instance.call("testReadingPost", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" }
      });
    const allowed = await preflight("https://allowed.test");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://allowed.test");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(
      (await preflight("https://foreign.test")).headers["access-control-allow-origin"]
    ).toBeUndefined();
  });

  it("lets the sign-in library limit sign-in per client address the server established", async () => {
    const attempt = (remoteAddress: string, headers: Record<string, string> = {}) =>
      limitedInstance.call("authSignIn", {
        remoteAddress,
        headers: { origin: baseUrl, ...headers },
        payload: { email, password: "not-the-password" }
      });

    // The library allows three sign-in calls in ten seconds per address.
    for (let count = 0; count < 3; count += 1) {
      expect((await attempt("198.51.100.30")).statusCode).toBe(401);
    }
    expect((await attempt("198.51.100.30")).statusCode).toBe(429);
    // Neither header a caller can send moves it to another address.
    expect(
      (
        await attempt("198.51.100.30", {
          "x-forwarded-for": "203.0.113.50",
          "x-catalyst-client-address": "203.0.113.51"
        })
      ).statusCode
    ).toBe(429);
    // Another client is not affected, also behind the same trusted proxy.
    expect((await attempt("198.51.100.31")).statusCode).toBe(401);
    expect((await attempt("172.18.0.5", { "x-forwarded-for": "203.0.113.52" })).statusCode).toBe(
      401
    );
    // A development instance leaves the library's limit off.
    for (let count = 0; count < 5; count += 1) {
      expect(
        (
          await instance.call("authSignIn", {
            remoteAddress: "198.51.100.32",
            headers: { origin: baseUrl },
            payload: { email, password: "not-the-password" }
          })
        ).statusCode
      ).toBe(401);
    }
  });
});

describe("the public runtime boundary", () => {
  async function exerciseLifecycle(instance: TestInstance): Promise<void> {
    const runtime = await getTestRuntime(instance);
    const inProcess = await runtime.fetch(new Request("http://instance.test/health"));
    expect(inProcess.status).toBe(200);
    expect(await inProcess.json()).toMatchObject({ status: "ok" });
    const missing = await runtime.fetch(
      new Request("http://instance.test/api/v1/nothing", { method: "POST", body: "{}" })
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    const url = await runtime.listen({ host: "127.0.0.1", port: 0 });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect((await fetch(`${url}/health`)).status).toBe(200);

    await instance.close();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  }

  it("answers in process, listens and closes as a chat server", async () => {
    await exerciseLifecycle(await createTestInstance());
  });

  it("answers in process, listens and closes as an assembled instance", async () => {
    await exerciseLifecycle(await createTestInstance({ config: createTestConfig(), tools: [] }));
  });

  it.each(["chat-server", "client-assembly", "core"])(
    "keeps the web framework out of the built declarations of %s",
    async (name) => {
      const declarations = await readFile(
        new URL(`../packages/${name}/dist/index.d.ts`, import.meta.url),
        "utf8"
      );
      expect(declarations).toContain("HttpRuntime");
      expect(declarations).not.toMatch(/fastify|light-my-request/iu);
    }
  );
});
