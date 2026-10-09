import { rejectInvalidOrigins, createTestInstance } from "./support/test-instance";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DevelopmentAuthAdapter } from "@vivd-catalyst/auth";
import { createTestConfig } from "./support/fixtures";
import {
  createMultipartFilePayload,
  createTestAttachmentCapability
} from "./support/chat-server-attachment-harness";

const allowedOrigin = "https://ui.example.test";
const foreignOrigin = "https://foreign.test";
const siblingOrigin = "https://sibling.example.test";

afterEach(() => vi.restoreAllMocks());

async function createCookieApp(configureOrigins = true) {
  const authenticate = DevelopmentAuthAdapter.prototype.authenticate;
  vi.spyOn(DevelopmentAuthAdapter.prototype, "authenticate").mockImplementation(async function (
    this: DevelopmentAuthAdapter,
    request
  ) {
    return { ...(await authenticate.call(this, request)), authenticationMethod: "session-cookie" };
  });
  return createTestInstance({
    config: createTestConfig({ sessionToken: { issuer: "test", ttlSeconds: 900 } }),
    env: {
      ...(configureOrigins ? { CHAT_UI_ORIGIN: allowedOrigin } : {}),
      CHAT_SESSION_TOKEN_SECRET: "test-session-token-secret-long-enough",
      CHAT_SERVER_CREDENTIAL: "test-server-credential"
    },
    tools: [],
    capabilities: [createTestAttachmentCapability()]
  });
}

describe("browser origin policy", () => {
  it.each([
    true,
    false,
    {},
    /example/u,
    "*",
    "null",
    "not a url",
    "ftp://x",
    null,
    () => true,
    42,
    [true],
    ["https://*.test"],
    "data:text/plain,hello"
  ])(
    "rejects runtime-invalid allowed origins at direct server and assembly startup: %s",
    async (allowedOrigins) => {
      await expect(rejectInvalidOrigins(allowedOrigins, "server")).rejects.toMatchObject({
        code: "VALIDATION_FAILED"
      });
      await expect(rejectInvalidOrigins(allowedOrigins, "assembly")).rejects.toMatchObject({
        code: "VALIDATION_FAILED"
      });
    }
  );

  it.each([
    { name: "allowed", origin: allowedOrigin, status: 200 },
    { name: "foreign", origin: foreignOrigin, status: 403 },
    { name: "sibling subdomain", origin: siblingOrigin, status: 403 },
    { name: "prefix lookalike", origin: `${allowedOrigin}.evil.test`, status: 403 },
    { name: "trusted proxy origin", origin: "https://api.example.test", proxy: true, status: 200 },
    { name: "server origin", origin: "http://localhost", status: 200 },
    { name: "missing Origin", status: 403 },
    { name: "same-origin fetch", fetchSite: "same-origin", status: 200 },
    { name: "same-site fetch", fetchSite: "same-site", status: 403 },
    { name: "direct navigation", fetchSite: "none", status: 403 },
    { name: "opaque origin", origin: "null", status: 403 },
    {
      name: "foreign Origin with same-origin fetch",
      origin: foreignOrigin,
      fetchSite: "same-origin",
      status: 403
    }
  ])(
    "checks cookie POST, PATCH, DELETE, multipart and bodyless requests: $name",
    async ({ origin, fetchSite, status, proxy }) => {
      const app = await createCookieApp();
      try {
        const headers = {
          cookie: "test-session=present",
          ...(origin ? { origin } : {}),
          ...(proxy
            ? { "x-forwarded-proto": "https", "x-forwarded-host": "api.example.test" }
            : {}),
          ...(fetchSite ? { "sec-fetch-site": fetchSite } : {})
        };
        const created = await app.call("createConversation", {
          headers: { cookie: "test-session=present", origin: allowedOrigin },
          payload: { title: "Origin checks" }
        });
        expect(created.statusCode).toBe(200);
        const { id } = created.json() as { id: string };
        const json = await app.call("createConversation", {
          headers,
          remoteAddress: "127.0.0.1",
          payload: { title: "New conversation" }
        });
        const bodyless = await app.call("generateConversationTitle", {
          params: { conversationId: id },
          remoteAddress: "127.0.0.1",
          headers
        });
        const upload = createMultipartFilePayload({
          fieldName: "file",
          filename: "test.txt",
          contentType: "text/plain",
          content: "Upload content"
        });
        const multipart = await app.call("uploadDraftAttachment", {
          params: { conversationId: id },
          remoteAddress: "127.0.0.1",
          headers: { ...headers, ...upload.headers },
          payload: upload.payload
        });
        const patch = await app.call("renameConversation", {
          params: { conversationId: id },
          remoteAddress: "127.0.0.1",
          headers,
          payload: { title: "Renamed conversation" }
        });
        const deleted = await app.call("deleteConversation", {
          params: { conversationId: id },
          remoteAddress: "127.0.0.1",
          headers
        });
        for (const response of [json, bodyless, multipart, patch, deleted]) {
          expect(response.statusCode, response.body).toBe(status);
          if (status === 403) {
            expect(response.json()).toEqual({
              error: { code: "FORBIDDEN", message: "Session request origin is not allowed" }
            });
          }
        }
      } finally {
        await app.close();
      }
    }
  );

  it("refuses invalid explicit credentials on the config-asset identity path", async () => {
    const app = await createCookieApp();
    try {
      const response = await app.call("validateConfigAssets", {
        headers: {
          cookie: "test-session=present",
          origin: foreignOrigin,
          authorization: "Bearer invalid"
        },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: "UNAUTHENTICATED" }
      });
    } finally {
      await app.close();
    }
  });

  it("grants CORS only to allowed origins while cookie GETs and HEADs remain unguarded", async () => {
    const app = await createCookieApp();
    try {
      for (const origin of [allowedOrigin, foreignOrigin, siblingOrigin, undefined]) {
        const response = await app.call("getCurrentUser", {
          headers: { ...(origin ? { origin } : {}), cookie: "test-session=present" }
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(
          origin === allowedOrigin ? origin : undefined
        );
        const head = await app.call("getCurrentUser", {
          headers: { ...(origin ? { origin } : {}), cookie: "test-session=present" },
          method: "HEAD"
        });
        expect(head.statusCode).toBe(200);
        const preflight = await app.call("listConversations", {
          headers: {
            ...(origin ? { origin } : {}),
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type"
          },
          method: "OPTIONS"
        });
        expect(preflight.headers["access-control-allow-origin"]).toBe(
          origin === allowedOrigin ? origin : undefined
        );
      }
    } finally {
      await app.close();
    }
  });

  it("accepts widget bearer requests and server-credential exchange independently of origin", async () => {
    const app = await createCookieApp();
    try {
      const issued = await app.call("issueSessionToken", {
        headers: { origin: foreignOrigin, "x-server-credential": "test-server-credential" },
        payload: { externalUserId: "widget-user", displayLabel: "Widget User" }
      });
      expect(issued.statusCode).toBe(200);
      const { chatSessionToken } = issued.json() as { chatSessionToken: string };
      for (const origin of [foreignOrigin, allowedOrigin]) {
        const response = await app.call("createConversation", {
          headers: {
            cookie: "test-session=present",
            origin,
            authorization: `Bearer ${chatSessionToken}`
          },
          payload: { title: "Widget conversation" }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(
          origin === allowedOrigin ? origin : undefined
        );
      }
    } finally {
      await app.close();
    }
  });

  it.each(["development", "production"] as const)(
    "has no cross-origin grant without configuration in %s",
    async (environment) => {
      const config = createTestConfig({ sessionToken: { issuer: "test", ttlSeconds: 900 } });
      config.clientInstance.environment = environment;
      config.auth.development = undefined;
      const app = await createTestInstance({
        config,
        env: {
          CHAT_SESSION_TOKEN_SECRET: "test-session-token-secret-long-enough",
          CHAT_SERVER_CREDENTIAL: "test-server-credential"
        },
        tools: []
      });
      try {
        const response = await app.call("health", { headers: { origin: foreignOrigin } });
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    }
  );

  it("allows same-origin cookie writes without any configured CORS origins", async () => {
    const app = await createCookieApp(false);
    try {
      const response = await app.call("createConversation", {
        headers: { origin: "http://localhost", cookie: "test-session=present" },
        payload: { title: "Same origin" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("preserves development loopback aliases for CORS", async () => {
    const app = await createTestInstance({
      config: createTestConfig(),
      env: { CHAT_UI_ORIGIN: "http://localhost:5173" },
      tools: []
    });
    try {
      for (const origin of [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://[::1]:5173"
      ]) {
        const response = await app.call("getCurrentUser", { headers: { origin } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
      }
    } finally {
      await app.close();
    }
  });
});
