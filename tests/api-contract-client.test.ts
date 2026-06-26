import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  apiOperations,
  buildApiPath,
  chatStreamRoutePath,
  openApiDocument
} from "@vivd-catalyst/api-contract";
import { createApiClient } from "@vivd-catalyst/api-client";

describe("api operation catalog and client", () => {
  it("keeps the OpenAPI artifact generated from the operation catalog", async () => {
    const artifact = JSON.parse(
      await readFile("packages/api-contract/openapi.json", "utf8")
    ) as unknown;

    expect(artifact).toEqual(openApiDocument);
    for (const operation of Object.values(apiOperations)) {
      const openApiPath = operation.path.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
      const pathItem = (openApiDocument.paths as Record<string, Record<string, { operationId: string }>>)[
        openApiPath
      ];
      expect(pathItem?.[operation.method.toLowerCase()]?.operationId).toBe(operation.operationId);
    }
  });

  it("builds encoded paths from operation params and query values", () => {
    expect(
      apiOperations.listConversationMessages.buildPath({
        params: { conversationId: "conversation 1/2" }
      })
    ).toBe("/api/conversations/conversation%201%2F2/messages");
    expect(apiOperations.getConfig.buildPath({ query: { locale: "de" } })).toBe(
      "/api/config?locale=de"
    );
    expect(
      buildApiPath("/api/example/:exampleId", {
        params: { exampleId: "value/with spaces" },
        query: { view: "full" }
      })
    ).toBe("/api/example/value%2Fwith%20spaces?view=full");
    expect(() => apiOperations.listConversationMessages.buildPath()).toThrow(
      /Missing path parameter "conversationId"/u
    );
    expect(() => apiOperations.getConfig.buildPath({ query: { unknown: "value" } })).toThrow(
      /Unknown query parameter "unknown"/u
    );
  });

  it("uses generated SDK operations for client method, path, auth, and response parsing", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(input instanceof Request ? input : new Request(input, init));
      return Response.json([]);
    };
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      getToken: () => "test-token",
      fetchImpl
    });
    const operation = apiOperations.listConversationMessages;

    await expect(client.messages("conversation/with space")).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.url).toBe(
      `https://chat.example${operation.buildPath({
        params: { conversationId: "conversation/with space" }
      })}`
    );
    expect(request?.method).toBe(operation.method);
    expect(request?.credentials).toBe("include");
    expect(request?.headers.get("authorization")).toBe("Bearer test-token");
  });

  it("validates request bodies through operation schemas before fetch", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not run for invalid request input");
    };
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl
    });

    expect(() => client.createConversation({ title: "" })).toThrow();
  });

  it("keeps normal server route registrations tied to the operation catalog", async () => {
    const routeFiles = [
      "packages/chat-server/src/routes/audit-routes.ts",
      "packages/chat-server/src/routes/config-routes.ts",
      "packages/chat-server/src/routes/conversation-file-routes.ts",
      "packages/chat-server/src/routes/conversation-routes.ts",
      "packages/chat-server/src/routes/draft-attachment-routes.ts",
      "packages/chat-server/src/routes/session-token-routes.ts",
      "packages/chat-server/src/routes/superadmin-routes.ts",
      "packages/chat-server/src/routes/user-account-routes.ts"
    ];

    for (const file of routeFiles) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain("apiOperations.");
      expect(source, file).not.toMatch(/app\.(?:get|post|patch|put|delete)\(\s*["'`]\/(?:api|auth)\//u);
    }
  });

  it("keeps the live chat stream path in the API contract", async () => {
    const source = await readFile("packages/chat-server/src/routes/chat-stream-routes.ts", "utf8");

    expect(chatStreamRoutePath).toBe("/api/chat");
    expect(source).toContain("chatStreamRoutePath");
    expect(source).toContain("chatStreamRequestSchema");
    expect(source).toContain("chatStreamChunkSchema");
    expect(source).not.toContain('app.post("/api/chat"');
  });
});
