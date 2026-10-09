import { addTestRoute, createTestInstance } from "./support/test-instance";
import { createLogger } from "@vivd-catalyst/client-assembly";

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, asClientInstanceId } from "@vivd-catalyst/core";
import { OpenAiCompatibleChatProvider } from "@vivd-catalyst/model-provider";
import { readProviderErrorMetadata } from "../packages/model-provider/src/provider-error";
import { createTestConfig, createTestUser } from "./support/fixtures";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";

const marker = "PRIVATE_DOCUMENT_CONTENT must never escape";
const providerBody = {
  error: {
    type: "invalid_request_error",
    code: "invalid_input",
    message: marker,
    param: marker,
    details: { document: marker }
  },
  message: marker,
  request: marker
};
const context = {
  clientInstanceId: asClientInstanceId("demo-local"),
  correlationId: "redaction-test",
  user: createTestUser("user-1", asClientInstanceId("demo-local"))
};
const request = {
  providerId: "test",
  model: "test",
  messages: [{ role: "user" as const, content: "hello" }],
  tools: []
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider error boundary", () => {
  it("allowlists only bounded type/code fields and request-id headers", () => {
    expect(
      readProviderErrorMetadata(
        providerBody,
        new Headers({ "x-request-id": "req-123", "x-error": marker })
      )
    ).toEqual({
      providerErrorType: "invalid_request_error",
      providerErrorCode: "invalid_input",
      requestId: "req-123"
    });
    expect(
      readProviderErrorMetadata(
        { type: "error", code: "server_error", message: marker },
        new Headers({ "request-id": "req-456" })
      )
    ).toEqual({
      providerErrorType: "error",
      providerErrorCode: "server_error",
      requestId: "req-456"
    });
    expect(
      readProviderErrorMetadata({ error: { code: 429, message: marker } }).providerErrorCode
    ).toBe(429);
    expect(
      readProviderErrorMetadata(
        { error: { type: marker, code: "x".repeat(129) } },
        new Headers({ "x-request-id": marker })
      )
    ).toEqual({ providerErrorType: undefined, providerErrorCode: undefined, requestId: undefined });
    for (const payload of [null, marker, [], { error: { code: { message: marker } } }]) {
      expect(JSON.stringify(readProviderErrorMetadata(payload))).not.toContain(marker);
    }
  });

  it.each([
    { api: "chat_completions", stream: false },
    { api: "chat_completions", stream: true },
    { api: "responses", stream: false },
    { api: "responses", stream: true }
  ] as const)("redacts HTTP error bodies for $api, stream=$stream", async ({ api, stream }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(providerBody), {
            status: 400,
            headers: { "x-request-id": "req-123" }
          })
      )
    );
    const provider = new OpenAiCompatibleChatProvider({
      id: "test",
      api,
      model: "test",
      baseUrl: "https://provider.test/v1",
      apiKey: "test"
    });
    const operation = stream
      ? provider.stream(request, context)[Symbol.asyncIterator]().next()
      : provider.complete(request, context);
    const error: unknown = await operation.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      message: "Model provider request failed",
      details: {
        providerId: "test",
        status: 400,
        providerErrorType: "invalid_request_error",
        providerErrorCode: "invalid_input",
        requestId: "req-123"
      }
    });
    expect(String(error)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
    expect((error as Error).stack).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
  });

  it.each([marker, `{ "error": "${marker}"`])(
    "discards non-JSON and malformed error bodies",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 502 }))
      );
      const provider = new OpenAiCompatibleChatProvider({
        id: "test",
        model: "test",
        baseUrl: "https://provider.test/v1",
        apiKey: "test"
      });
      const error: unknown = await provider
        .complete(request, context)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        message: "Model provider request failed",
        details: { status: 502 }
      });
      expect(JSON.stringify(error)).not.toContain(marker);
      expect((error as Error).cause).toBeUndefined();
    }
  );

  it.each(["chat_completions", "responses"] as const)(
    "does not leak JSON parser excerpts from a successful %s response",
    async (api) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(marker, { headers: { "x-request-id": "req-json" } }))
      );
      const provider = new OpenAiCompatibleChatProvider({
        id: "test",
        api,
        model: "test",
        baseUrl: "https://provider.test/v1",
        apiKey: "test"
      });
      const error: unknown = await provider
        .complete(request, context)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        message: "Model provider returned invalid JSON",
        details: { status: 200, requestId: "req-json" }
      });
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      expect((error as Error).stack).not.toContain(marker);
      expect((error as Error).cause).toBeUndefined();
    }
  );

  it.each(["response.failed", "error"])("redacts %s events in an accepted stream", async (type) => {
    const payload =
      type === "response.failed" ? { type, response: providerBody } : { type, ...providerBody };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify(payload)}\n\n`, {
            headers: { "x-request-id": "req-stream" }
          })
      )
    );
    const provider = new OpenAiCompatibleChatProvider({
      id: "test",
      api: "responses",
      model: "test",
      baseUrl: "https://provider.test/v1",
      apiKey: "test"
    });
    const error: unknown = await provider
      .stream(request, context)
      [Symbol.asyncIterator]()
      .next()
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: "Model provider stream failed",
      details: { providerErrorCode: "invalid_input", requestId: "req-stream" }
    });
    expect(JSON.stringify(error)).not.toContain(marker);
    expect((error as Error).stack).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
  });

  it("keeps provider body content out of runtime logs, title audit metadata and HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(providerBody), { status: 400 }))
    );
    const logged = vi.spyOn(createLogger(), "error").mockImplementation(() => undefined);
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
    const provider = new OpenAiCompatibleChatProvider({
      id: "test",
      model: "test",
      baseUrl: "https://provider.test/v1",
      apiKey: "test"
    });
    addTestRoute(app, "/test-provider-error", () => provider.complete(request, context));
    addTestRoute(app, "/test-internal-error", () => {
      throw new AppError("INTERNAL", marker, { document: marker });
    });
    addTestRoute(app, "/test-exposed-error", () => {
      throw new AppError(
        "INTERNAL",
        "A fixed user-facing failure",
        { document: marker },
        { exposeMessage: true }
      );
    });
    addTestRoute(app, "/test-validation-error", () => {
      throw new AppError("VALIDATION_FAILED", "Choose a valid name", { field: "name" });
    });
    try {
      const exposed = await app.call("testExposedError", {});
      expect(exposed.statusCode).toBe(500);
      expect(exposed.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "INTERNAL",
          message: "Internal server error"
        }
      });
      const created = await app.call("conversations.create", { payload: { title: "hello" } });
      expect(created.statusCode).toBe(200);
      const { id } = created.json() as { id: string };
      const started = await injectStartConversationRun(app, id, "hello", {
        idempotencyKey: "redaction-test"
      });
      await drainRunEvents(app, id, started.run.id);
      await app.call("conversations.title.generate", { params: { conversationId: id } });
      const audit = await app.call("audit_events.list", {});
      const events = audit.json<{
        items: Array<{ type: string; metadata: Record<string, unknown> }>;
      }>().items;
      const titleFailures = events.filter(
        (event) => event.type === "conversation.title_generation_failed"
      );
      expect(titleFailures.length).toBeGreaterThan(0);
      for (const event of titleFailures) {
        expect(event.metadata.errorCode).toBe("INTERNAL");
        expect(event.metadata).not.toHaveProperty("errorMessage");
      }
      expect(audit.body).not.toContain(marker);
      expect(
        logged.mock.calls.some(([payload]) =>
          JSON.stringify(payload).includes("agent_runtime.run_failed")
        )
      ).toBe(true);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(marker);
      for (const operation of ["testProviderError", "testInternalError"] as const) {
        const response = await app.call(operation);
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          error: {
            correlationId: expect.any(String),
            code: "INTERNAL",
            message: "Internal server error"
          }
        });
        expect(response.body).not.toContain(marker);
      }
      const validation = await app.call("testValidationError", {});
      expect(validation.statusCode).toBe(422);
      expect(validation.json()).toEqual({
        error: {
          correlationId: expect.any(String),
          code: "VALIDATION_FAILED",
          message: "Choose a valid name",
          details: { field: "name" }
        }
      });
    } finally {
      await app.close();
    }
  });
});
