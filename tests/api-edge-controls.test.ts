import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  CompositeAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type StandaloneAuthRuntime
} from "@vivd-catalyst/auth";
import { createInProcessRateLimiter } from "@vivd-catalyst/chat-server";
import { rateLimitsConfigSchema, type RateLimitsConfig } from "@vivd-catalyst/config-schema";
import {
  AppError,
  asClientInstanceId,
  type RateLimiter,
  type RateLimitRule
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { inventedAuthPath, routeTestOperations } from "./support/operations";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  addTestRoute,
  callTestPath,
  createTestInstance,
  createTestInstanceWith,
  getTestRuntime,
  type TestInstance
} from "./support/test-instance";

const MINUTE_MS = 60 * 1000;
const perMinute = (limit: number): RateLimitRule => ({ limit, windowMs: MINUTE_MS });

/** The test config with some of its limits lowered, as a release config would set them. */
function configWithLimits(rateLimits: Partial<RateLimitsConfig>) {
  const config = createTestConfig();
  return { ...config, rateLimits: { ...config.rateLimits, ...rateLimits } };
}

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

  it("limits by default only what no ordinary use comes near", () => {
    // Changing a default is a decision, so the numbers are written down twice.
    expect(createTestConfig().rateLimits).toEqual({
      enabled: true,
      readPerMinute: 6000,
      writePerMinute: 1200,
      signInPerAccountPerMinute: 10,
      signInPerAddressPerMinute: 300
    });
    expect(rateLimitsConfigSchema.parse({ enabled: false, writePerMinute: 50 })).toMatchObject({
      enabled: false,
      readPerMinute: 6000,
      writePerMinute: 50
    });
    // The section has the classes and nothing per operation.
    expect(rateLimitsConfigSchema.safeParse({ readPerMinute: 0 }).success).toBe(false);
    expect(rateLimitsConfigSchema.safeParse({ "conversations.list": 5 }).success).toBe(false);
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

  const serverCredential = "edge-controls-server-credential";

  function instanceWith(
    rateLimiter: RateLimiter,
    rateLimits: Partial<RateLimitsConfig> = {}
  ): Promise<TestInstance> {
    return createTestInstanceWith(
      () => ({
        rateLimiter,
        config: configWithLimits(rateLimits),
        sessionToken: {
          serverCredential,
          issuer: new HmacSessionTokenIssuer({
            secret: "edge-controls-session-token-secret",
            issuer: "test",
            clientInstanceId: createTestConfig().clientInstance.id,
            ttlSeconds: 60
          })
        }
      }),
      (route) => {
        route(routeTestOperations.testPublic, () => ({ value: "ok" }));
        route(routeTestOperations.testUser, () => ({ value: "ok" }));
        route(routeTestOperations.testKey, ({ request }) => {
          if (request.headers["x-test-key"] !== "the-key") {
            throw new AppError("UNAUTHENTICATED", "Invalid key");
          }
          return { value: "ok" };
        });
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
      { key: `testUser|user:${ada[0]?.id}`, rule: perMinute(6000) },
      { key: "testPublic|address:203.0.113.7", rule: perMinute(6000) },
      { key: "testPublic|address:198.51.100.9", rule: perMinute(6000) }
    ]);
  });

  it("answers a caller over the limit with 429, the error envelope and the time to wait", async () => {
    let time = Date.parse("2026-01-01T00:00:00.000Z");
    const instance = await instanceWith(createInProcessRateLimiter({ now: () => time }), {
      signInPerAddressPerMinute: 2
    });
    const setUp = (address: string, forwardedFor?: string) =>
      instance.call("password_setup.complete", {
        remoteAddress: address,
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
        payload: { token: "not-a-token", password: "a-long-enough-password" }
      });

    // Each call within the limit is answered on its merits.
    expect((await setUp("198.51.100.20", "203.0.113.1")).statusCode).toBe(422);
    expect((await setUp("198.51.100.20", "203.0.113.2")).statusCode).toBe(422);
    time += 20_000;
    const refused = await setUp("198.51.100.20", "203.0.113.99");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("40");
    expect(refused.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
        details: { retryAfterSeconds: 40 },
        correlationId: refused.headers["x-correlation-id"]
      }
    });

    // Another address, and the same address on another operation, are not affected.
    expect((await setUp("198.51.100.21")).statusCode).toBe(422);
    expect((await instance.call("testPublic", { remoteAddress: "198.51.100.20" })).statusCode).toBe(
      200
    );

    time += 40_000;
    expect((await setUp("198.51.100.20")).statusCode).toBe(422);
  });

  it("refuses a signed-in caller over the limit and leaves other callers alone", async () => {
    const instance = await instanceWith(createInProcessRateLimiter(), { readPerMinute: 2 });
    expect((await instance.call("testUser", {}, "ada")).statusCode).toBe(200);
    expect((await instance.call("testUser", {}, "ada")).statusCode).toBe(200);
    const refused = await instance.call("testUser", {}, "ada");
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await instance.call("testUser", {}, "grace")).statusCode).toBe(200);
    expect((await instance.call("conversations.list", {}, "ada")).statusCode).toBe(200);
  });

  it("counts nothing where the release config turns limiting off", async () => {
    const { calls, recording } = recordingLimiter(createInProcessRateLimiter());
    const instance = await instanceWith(recording, {
      enabled: false,
      readPerMinute: 1,
      signInPerAddressPerMinute: 1
    });
    for (let count = 0; count < 3; count += 1) {
      expect((await instance.call("testUser", {}, "ada")).statusCode).toBe(200);
      expect((await instance.call("testKey", { headers: { "x-test-key": "no" } })).statusCode).toBe(
        401
      );
    }
    expect(calls).toEqual([]);
  });

  it("limits tries on one account tightly and one address alone loosely", async () => {
    const { calls, recording } = recordingLimiter(createInProcessRateLimiter());
    const instance = await instanceWith(recording, { signInPerAccountPerMinute: 2 });
    const reset = (email: string, remoteAddress = "198.51.100.40") =>
      instance.call("password_reset.request", { remoteAddress, payload: { email } });

    const answered = (await reset("Ada@Example.test")).statusCode;
    expect(answered).not.toBe(429);
    expect((await reset("ada@example.test")).statusCode).toBe(answered);
    expect((await reset("ada@example.test")).statusCode).toBe(429);
    // A colleague behind the same address, and the same account from elsewhere, go on.
    expect((await reset("grace@example.test")).statusCode).toBe(answered);
    expect((await reset("ada@example.test", "198.51.100.41")).statusCode).toBe(answered);

    expect(calls.slice(0, 2)).toEqual([
      { key: "password_reset.request|address:198.51.100.40", rule: perMinute(300) },
      {
        key: "password_reset.request|address:198.51.100.40|account:ada@example.test",
        rule: perMinute(2)
      }
    ]);
  });

  it("counts a server credential's calls under the credential, not the address", async () => {
    const { calls, recording } = recordingLimiter(createInProcessRateLimiter());
    const instance = await instanceWith(recording);
    const issue = (externalUserId: string, credential = serverCredential) =>
      instance.call("session_tokens.issue", {
        remoteAddress: "198.51.100.50",
        headers: { "x-server-credential": credential },
        payload: { externalUserId, displayLabel: externalUserId }
      });

    // A host backend opens the chat for 22 of its users from its one address.
    for (let user = 0; user < 22; user += 1) {
      expect((await issue(`host-user-${user}`)).statusCode).toBe(200);
    }
    expect(new Set(calls.map((call) => call.key))).toEqual(
      new Set(["session_tokens.issue|credential:server"])
    );
    expect(calls[0]?.rule).toEqual(perMinute(6000));

    calls.length = 0;
    expect((await issue("host-user-0", "not-the-credential")).statusCode).toBe(403);
    expect(calls).toEqual([
      { key: "session_tokens.issue|refused:address:198.51.100.50", rule: perMinute(60) }
    ]);
  });

  it("keeps the accepted credential working while refused ones are over their limit", async () => {
    const refusing: RateLimiter = {
      async consume(key) {
        return key.includes("|refused:")
          ? { allowed: false, retryAfterMs: 30_000 }
          : { allowed: true, retryAfterMs: 0 };
      }
    };
    const instance = await instanceWith(refusing);
    const issue = (credential: string) =>
      instance.call("session_tokens.issue", {
        remoteAddress: "198.51.100.51",
        headers: { "x-server-credential": credential },
        payload: { externalUserId: "host-user", displayLabel: "Host User" }
      });
    expect((await issue("not-the-credential")).statusCode).toBe(429);
    expect((await issue(serverCredential)).statusCode).toBe(200);

    // A refused key on an operation that takes one is counted the same way.
    const key = (value: string) =>
      instance.call("testKey", {
        remoteAddress: "198.51.100.51",
        headers: { "x-test-key": value }
      });
    const refused = await key("not-the-key");
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("30");
    expect((await key("the-key")).statusCode).toBe(200);
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
  const counted: Array<{ key: string; rule: RateLimitRule }> = [];
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
    auth = await createStandaloneAuthRuntime(options);
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
    const limiter = createInProcessRateLimiter();
    limitedInstance = await createTestInstanceWith(() => ({
      standaloneAuth: auth,
      config: configWithLimits({ signInPerAccountPerMinute: 3 }),
      rateLimiter: {
        consume(key, rule) {
          counted.push({ key, rule });
          return limiter.consume(key, rule);
        }
      }
    }));
  });
  afterAll(async () => {
    await sql?.end();
    await auth?.close();
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

  it("refuses sign-in attempts sent side by side before any password is checked", async () => {
    const attempt = (
      remoteAddress: string,
      account = email,
      headers: Record<string, string> = {}
    ) =>
      limitedInstance.call("authSignIn", {
        remoteAddress,
        headers: { origin: baseUrl, ...headers },
        payload: { email: account, password: "not-the-password" }
      });

    // Three tries a minute on one account from one address, however they are sent.
    const parallel = await Promise.all(Array.from({ length: 10 }, () => attempt("198.51.100.30")));
    expect(parallel.map((response) => response.statusCode).sort()).toEqual([
      ...Array.from({ length: 3 }, () => 401),
      ...Array.from({ length: 7 }, () => 429)
    ]);

    // The refusal is the API's own, not the sign-in library's.
    const refused = await attempt("198.51.100.30", email.toUpperCase(), {
      // Neither header a caller can send moves it to another address.
      "x-forwarded-for": "203.0.113.50",
      "x-catalyst-client-address": "203.0.113.51"
    });
    expect(refused.statusCode).toBe(429);
    const retryAfterSeconds = Number(refused.headers["retry-after"]);
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(refused.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
        details: { retryAfterSeconds },
        correlationId: expect.any(String)
      }
    });

    // The same account from another address, also behind the same trusted proxy, goes on.
    expect((await attempt("198.51.100.31")).statusCode).toBe(401);
    expect(
      (await attempt("172.18.0.5", email, { "x-forwarded-for": "203.0.113.52" })).statusCode
    ).toBe(401);
    // So does everyone else behind the refused address: an office shares one.
    const colleagues = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        attempt("198.51.100.30", `colleague-${index}@example.test`)
      )
    );
    expect(colleagues.map((response) => response.statusCode)).toEqual(
      Array.from({ length: 12 }, () => 401)
    );
  });

  it("counts the sign-in routes in two groups and an invented path not at all", async () => {
    counted.length = 0;
    for (let count = 0; count < 25; count += 1) {
      const invented = await callTestPath(limitedInstance, "GET", inventedAuthPath(count));
      expect(invented.statusCode).toBe(404);
    }
    const countedAuth = () => counted.filter((call) => call.key.startsWith("auth."));
    expect(countedAuth()).toEqual([]);

    await limitedInstance.call("authSession", { remoteAddress: "198.51.100.33" });
    await limitedInstance.call("authSignIn", {
      remoteAddress: "198.51.100.33",
      headers: { origin: baseUrl },
      payload: { email: "Someone@Example.test", password: "not-the-password" }
    });
    expect(countedAuth()).toEqual([
      { key: "auth.session|address:198.51.100.33", rule: perMinute(6000) },
      { key: "auth.sign-in|address:198.51.100.33", rule: perMinute(300) },
      {
        key: "auth.sign-in|address:198.51.100.33|account:someone@example.test",
        rule: perMinute(3)
      }
    ]);
  });

  it("accepts a same-origin https call with a cookie through the in-process boundary", async () => {
    const { cookie } = await signIn();
    const runtime = await getTestRuntime(instance);
    const post = (origin: string) =>
      runtime.fetch(
        new Request("https://instance.test/test/reading-post", {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: "{}"
        })
      );
    expect((await post("https://instance.test")).status).toBe(200);
    expect((await post("http://instance.test")).status).toBe(403);
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

  it("stops the producer of a streamed answer that is aborted or cancelled", async () => {
    const errors: unknown[] = [];
    const onError = (error: unknown): void => {
      errors.push(error);
    };
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    const instance = await createTestInstance({ config: createTestConfig(), tools: [] });
    let running = 0;
    addTestRoute(instance, "/stream", (_request, reply) =>
      reply.header("content-type", "text/plain").send(
        Readable.from(
          (async function* produce() {
            running += 1;
            try {
              for (;;) {
                yield "chunk\n";
                await delay(5);
              }
            } finally {
              running -= 1;
            }
          })()
        )
      )
    );
    const runtime = await getTestRuntime(instance);
    try {
      const abort = new AbortController();
      const aborted = await runtime.fetch(
        new Request("http://instance.test/stream", { signal: abort.signal })
      );
      const abortedReader = aborted.body?.getReader();
      expect(new TextDecoder().decode((await abortedReader?.read())?.value)).toContain("chunk");
      expect(running).toBe(1);
      abort.abort();
      await expect(abortedReader?.read()).rejects.toMatchObject({ name: "AbortError" });
      await expect.poll(() => running).toBe(0);

      const cancelled = await runtime.fetch(new Request("http://instance.test/stream"));
      const cancelledReader = cancelled.body?.getReader();
      await cancelledReader?.read();
      expect(running).toBe(1);
      await cancelledReader?.cancel();
      await expect.poll(() => running).toBe(0);

      // A request aborted before it is sent is not answered.
      await expect(
        runtime.fetch(new Request("http://instance.test/stream", { signal: AbortSignal.abort() }))
      ).rejects.toMatchObject({ name: "AbortError" });
      // The server is still there, and nothing was thrown past it.
      expect((await runtime.fetch(new Request("http://instance.test/health"))).status).toBe(200);
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    }
  });

  it("stops reading a body at the server's limit", async () => {
    const runtime = await getTestRuntime(await createTestInstance());
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    let cancelled = false;
    // Thirty megabytes, of which the server accepts one.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 480) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        cancelled = true;
      }
    });
    // A streamed request body needs `duplex`, which the DOM types lack.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half"
    };
    const response = await runtime.fetch(
      new Request(`http://instance.test${apiOperations["password_setup.complete"].path}`, init)
    );
    expect(response.ok).toBe(false);
    expect(pulled).toBeLessThan(64);
    await expect.poll(() => cancelled).toBe(true);
  });

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
