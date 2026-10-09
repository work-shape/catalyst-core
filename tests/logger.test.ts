import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@vivd-catalyst/client-assembly";
import { AppError } from "@vivd-catalyst/core";
import { addTestRoute, createTestInstance } from "./support/test-instance";
import { createTestConfig } from "./support/fixtures";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";

const bearer = "Bearer private-access-key";
const apiKey = "sk-abcdefghijklmnopqrstuvwx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function captureStdout() {
  const lines: Record<string, unknown>[] = [];
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const text = String(chunk);
    chunks.push(text);
    for (const line of text.trimEnd().split("\n")) {
      const parsed: Record<string, unknown> = JSON.parse(line);
      lines.push(parsed);
    }
    return true;
  });
  return { lines, chunks };
}

describe("process logger", () => {
  it("writes one JSON object per stdout line with level, time and message, from info up", () => {
    const { lines, chunks } = captureStdout();
    const logger = createLogger();
    expect(createLogger()).toBe(logger);
    logger.debug({ type: "test" }, "debug line");
    logger.info("info line");
    logger.warn({ count: 3 }, "warn line");
    logger.error({ error: new Error("failure") }, "error line");
    expect(lines.map((line) => line.level)).toEqual([30, 40, 50]);
    expect(lines.map((line) => line.msg)).toEqual(["info line", "warn line", "error line"]);
    for (const line of lines) expect(line.time).toEqual(expect.any(Number));
    for (const chunk of chunks) expect(chunk.split("\n")).toHaveLength(2);
  });

  it("redacts normalized secret key suffixes at every depth while retaining usage and session ids", () => {
    const { lines, chunks } = captureStdout();
    const secretFields = {
      authorization: "private",
      password: "private",
      token: "private",
      sessionToken: "private",
      leaseToken: "private",
      apiKey: "private",
      API_KEY: "private",
      "client-secret": "private",
      cookie: "private",
      credential: "private",
      credentials: "private",
      clientCredentials: "private",
      passwordHash: "private",
      tokenHash: "private",
      secretKey: "private",
      secretAccessKey: "private",
      privateKey: "private",
      passphrase: "private",
      accessKeyId: "private",
      signature: "private",
      secrets: "private",
      cookies: "private",
      "set-cookie": "private"
    };
    const visibleFields = {
      inputTokens: 123,
      outputTokens: 456,
      sessionId: "session-visible",
      tokenCount: 9,
      "access-control-allow-credentials": "true"
    };
    let nested: Record<string, unknown> = { ...secretFields, ...visibleFields };
    for (let depth = 0; depth < 3; depth += 1) nested = { nested: [nested] };
    createLogger().info({ ...secretFields, ...visibleFields, nested }, "fields");
    expect(lines[0]).toMatchObject(visibleFields);
    for (const key of Object.keys(secretFields)) expect(lines[0]?.[key]).toBe("[REDACTED]");
    expect(chunks.join("")).not.toContain('"private"');
    expect(chunks.join("")).toContain('"inputTokens":123');
    expect(chunks.join("")).toContain('"sessionId":"session-visible"');
    expect(chunks.join("").match(/"inputTokens":123/gu)).toHaveLength(2);
  });

  it("cuts every string at 4,000 characters and stops at depth 8", () => {
    const { lines } = captureStdout();
    const long = "x".repeat(4001);
    const exact = "y".repeat(4000);
    let deep: Record<string, unknown> = { leaf: "bottom", token: "private" };
    for (let depth = 0; depth < 8; depth += 1) deep = { next: deep };
    let shallow: Record<string, unknown> = { leaf: "bottom" };
    for (let depth = 0; depth < 7; depth += 1) shallow = { next: shallow };
    createLogger().error(
      { long, exact, list: [long], error: new Error(long), deep, shallow },
      `message ${long}`
    );
    const cut = `${"x".repeat(4000)}[TRUNCATED]`;
    const output = JSON.stringify(lines[0]);
    expect(lines[0]).toMatchObject({
      long: cut,
      exact,
      list: [cut],
      error: { message: cut },
      msg: `message ${"x".repeat(3992)}[TRUNCATED]`
    });
    expect(output.match(/"next":/gu)).toHaveLength(15);
    expect(output).toContain('"next":"[TRUNCATED]"');
    expect(output).toContain('"leaf":"bottom"');
    expect(output.match(/"leaf":/gu)).toHaveLength(1);
    expect(output).not.toContain("private");
  });

  it("redacts the password of a URL value and keeps the rest of the URL", () => {
    const { lines, chunks } = captureStdout();
    createLogger().info(
      {
        databaseUrl: "postgres://app:private-pw@db.internal:5432/catalyst?sslmode=require",
        connectionString: "redis://default:private:p@ss@cache.internal:6379/0",
        endpoint: new URL("https://user:private-url@storage.test/bucket"),
        userOnly: "https://user@host.test/path",
        plain: "https://host.test/path?mail=a@b.test",
        sentence: "mail a@b.test about x://y"
      },
      "urls"
    );
    expect(lines[0]).toMatchObject({
      databaseUrl: "postgres://app:[REDACTED]@db.internal:5432/catalyst?sslmode=require",
      connectionString: "redis://default:[REDACTED]@cache.internal:6379/0",
      endpoint: "https://user:[REDACTED]@storage.test/bucket",
      userOnly: "https://user@host.test/path",
      plain: "https://host.test/path?mail=a@b.test",
      sentence: "mail a@b.test about x://y"
    });
    for (const value of ["private-pw", "private:p@ss", "private-url"])
      expect(chunks.join("")).not.toContain(value);
  });

  it("redacts a URL password quoted inside a message, an error message and a stack", () => {
    const { lines, chunks } = captureStdout();
    const quoted = "postgres://user:private-embedded@db.internal:5432/catalyst";
    const error = new Error(`connect failed for ${quoted} after 3 tries`);
    createLogger().error(
      {
        error,
        note: `two: ${quoted} and redis://u:private-second@cache/0, port http://host:8080/a@b`
      },
      `could not reach ${quoted}, giving up`
    );
    createLogger().error(error);
    const kept = "postgres://user:[REDACTED]@db.internal:5432/catalyst";
    expect(lines[0]).toMatchObject({
      msg: `could not reach ${kept}, giving up`,
      note: `two: ${kept} and redis://u:[REDACTED]@cache/0, port http://host:8080/a@b`,
      error: {
        message: `connect failed for ${kept} after 3 tries`,
        stack: expect.stringContaining(`connect failed for ${kept} after 3 tries`)
      }
    });
    expect(lines[1]?.msg).toBe(`connect failed for ${kept} after 3 tries`);
    for (const value of ["private-embedded", "private-second"])
      expect(chunks.join("")).not.toContain(value);
  });

  it("writes dates and URLs as strings and binary values as a byte-length marker", () => {
    const { lines } = captureStdout();
    createLogger().info(
      {
        at: new Date("2026-01-02T03:04:05.006Z"),
        invalid: new Date(Number.NaN),
        link: new URL("https://host.test/a?b=c"),
        buffer: Buffer.from("twelve bytes"),
        typed: new Uint16Array(4),
        raw: new ArrayBuffer(3),
        nested: { list: [new Date(0), Buffer.alloc(2)] }
      },
      "values"
    );
    expect(lines[0]).toMatchObject({
      at: "2026-01-02T03:04:05.006Z",
      invalid: "Invalid Date",
      link: "https://host.test/a?b=c",
      buffer: "[Binary 12 bytes]",
      typed: "[Binary 8 bytes]",
      raw: "[Binary 3 bytes]",
      nested: { list: ["1970-01-01T00:00:00.000Z", "[Binary 2 bytes]"] }
    });
  });

  it("redacts token values in messages, nested errors, causes, arrays and child bindings", () => {
    const { lines, chunks } = captureStdout();
    const error = new AppError("INTERNAL", `failure ${bearer}`, { apiKey, inputTokens: 6 });
    const cause = new Error(`cause ${apiKey}`, { cause: new Error(bearer) });
    const child = createLogger().child({
      workerId: "worker-1",
      sessionToken: "private-binding",
      nested: { value: bearer }
    });
    child
      .child({ jobId: "job-1" })
      .error({ nested: { error, list: [cause, bearer, apiKey] } }, `message ${bearer} ${apiKey}`);
    child.error(error);
    expect(lines[0]).toMatchObject({
      workerId: "worker-1",
      jobId: "job-1",
      sessionToken: "[REDACTED]",
      nested: {
        error: {
          name: "AppError",
          code: "INTERNAL",
          statusCode: 500,
          details: { apiKey: "[REDACTED]", inputTokens: 6 }
        }
      }
    });
    expect(lines[1]?.msg).toBe("failure Bearer [REDACTED]");
    for (const value of [bearer, apiKey, "private-binding"])
      expect(chunks.join("")).not.toContain(value);
    expect(chunks.join("")).toContain("Bearer [REDACTED]");
  });

  it("redacts pino's implicit error message and prevents custom serializers bypassing redaction", () => {
    const { lines, chunks } = captureStdout();
    const toJSON = vi.fn(() => ({ token: "private-serializer" }));
    createLogger().error({ err: new Error(bearer) });
    createLogger().info({ value: { token: "private-field", toJSON }, msg: apiKey });
    expect(lines[0]?.msg).toBe("Bearer [REDACTED]");
    expect(lines[1]).toMatchObject({ msg: "[REDACTED]", value: { token: "[REDACTED]" } });
    expect(toJSON).not.toHaveBeenCalled();
    for (const value of [bearer, apiKey, "private-serializer", "private-field"])
      expect(chunks.join("")).not.toContain(value);
  });

  it("handles cycles without leaking secret fields", () => {
    const { lines } = captureStdout();
    const input: Record<string, unknown> = { token: "private" };
    input.self = input;
    createLogger().info({ input }, "cycle");
    expect(lines[0]).toMatchObject({ input: { token: "[REDACTED]", self: "[Circular]" } });
  });

  it("retains the runtime failure report fields through an actual failed run", async () => {
    const { lines } = captureStdout();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider failed", { status: 400 }))
    );
    const app = await createTestInstance({
      config: createTestConfig({
        modelProviders: [
          {
            id: "test",
            type: "openai-compatible",
            model: "test",
            baseUrl: "https://provider.test/v1",
            apiKeyEnvName: "TEST_PROVIDER_KEY"
          }
        ]
      }),
      env: { TEST_PROVIDER_KEY: "test" },
      tools: []
    });
    try {
      const created = await app.call("conversations.create", { payload: { title: "test" } });
      const conversation: { id: string } = created.json();
      const started = await injectStartConversationRun(app, conversation.id, "hello", {
        idempotencyKey: "logger-failure"
      });
      await drainRunEvents(app, conversation.id, started.run.id);
      expect(lines.find((line) => line.type === "agent_runtime.run_failed")).toMatchObject({
        level: 50,
        msg: "Agent run failed",
        runId: started.run.id,
        conversationId: conversation.id,
        agentName: expect.any(String),
        clientInstanceId: "demo-local",
        correlationId: expect.any(String),
        failure: { code: "INTERNAL", message: expect.any(String), category: expect.any(String) },
        error: {
          name: "AppError",
          message: expect.any(String),
          code: "INTERNAL",
          statusCode: 500,
          stack: expect.any(String)
        }
      });
    } finally {
      await app.close();
    }
  });

  it("logs Fastify requests as JSON through the same factory without opening a port", async () => {
    const { lines, chunks } = captureStdout();
    const app = await createTestInstance({ config: createTestConfig(), tools: [] });
    addTestRoute(app, "/test-hidden", (request) => {
      request.log.error({ res: { statusCode: 503, headers: { "x-private": "h" } } }, "reply");
      request.log.fatal({ token: "private-fatal" }, "fatal mapped");
      request.log.trace({ sessionId: "visible" }, "trace mapped");
      return {};
    });
    try {
      const response = await app.call("health.get", {
        headers: { authorization: bearer, cookie: "private-cookie" }
      });
      expect(response.statusCode).toBe(200);
      const missing = await app.call("testUnknown");
      expect(missing.statusCode).toBe(404);
      expect((await app.call("testHidden")).statusCode).toBe(200);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 30,
            msg: "incoming request",
            reqId: expect.any(String),
            req: {
              method: "GET",
              url: "/health",
              host: expect.any(String),
              remoteAddress: expect.any(String)
            }
          }),
          expect.objectContaining({
            level: 30,
            msg: "request completed",
            res: { statusCode: 200 }
          }),
          expect.objectContaining({ msg: "request completed", res: { statusCode: 404 } }),
          expect.objectContaining({ level: 50, msg: "reply", res: { statusCode: 503 } }),
          expect.objectContaining({ level: 50, msg: "fatal mapped", token: "[REDACTED]" })
        ])
      );
      expect(lines.some((line) => line.msg === "trace mapped")).toBe(false);
      for (const line of lines) {
        if (line.res !== undefined) expect(line.res).toEqual({ statusCode: expect.any(Number) });
      }
      expect(chunks.join("")).not.toContain('"headers"');
      expect(chunks.join("")).not.toContain('"statusCode":null');
      expect(chunks.join("")).not.toContain(bearer);
      expect(chunks.join("")).not.toContain("private-cookie");
    } finally {
      await app.close();
    }
  });
});
