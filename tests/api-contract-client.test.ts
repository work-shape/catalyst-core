import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  apiOperations,
  buildApiPath,
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

  it("exposes resource-oriented Agent Runs client helpers", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request);
      if (request.url.endsWith("/events?after=7")) {
        return new Response(
          [
            "id: 8",
            "event: run_completed",
            `data: ${JSON.stringify({
              clientInstanceId: "client_1",
              runId: "run_1",
              conversationId: "conv_1",
              ownerUserId: "user_1",
              sequence: 8,
              type: "run_completed",
              payload: {
                type: "run_completed",
                runId: "run_1",
                sequence: 8,
                createdAt: "2026-06-27T00:00:00.000Z"
              },
              createdAt: "2026-06-27T00:00:00.000Z"
            })}`,
            "",
            ""
          ].join("\n"),
          {
            headers: {
              "content-type": "text/event-stream"
            }
          }
        );
      }
      return Response.json({
        conversation: {
          id: "conv_1",
          clientInstanceId: "client_1",
          ownerUserId: "user_1",
          ownerExternalUserId: "user_1",
          title: "Started",
          status: "active",
          createdAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:00:00.000Z",
          retainedUntil: "2026-07-27T00:00:00.000Z"
        },
        userMessage: {
          id: "msg_1",
          conversationId: "conv_1",
          clientInstanceId: "client_1",
          role: "user",
          text: "Hello",
          createdAt: "2026-06-27T00:00:00.000Z"
        },
        run: {
          id: "run_1",
          clientInstanceId: "client_1",
          conversationId: "conv_1",
          ownerUserId: "user_1",
          inputMessageId: "msg_1",
          agentName: "test_agent",
          status: "running",
          idempotencyKey: "idem_1",
          startedAt: "2026-06-27T00:00:00.000Z",
          updatedAt: "2026-06-27T00:00:00.000Z",
          lastSequence: 0,
          correlationId: "corr_1"
        },
        thread: {
          conversation: {
            id: "conv_1",
            clientInstanceId: "client_1",
            ownerUserId: "user_1",
            ownerExternalUserId: "user_1",
            title: "Started",
            status: "active",
            createdAt: "2026-06-27T00:00:00.000Z",
            updatedAt: "2026-06-27T00:00:00.000Z",
            retainedUntil: "2026-07-27T00:00:00.000Z"
          },
          messages: [
            {
              id: "msg_1",
              conversationId: "conv_1",
              clientInstanceId: "client_1",
              role: "user",
              text: "Hello",
              createdAt: "2026-06-27T00:00:00.000Z"
            }
          ],
          activeRun: {
            run: {
              id: "run_1",
              conversationId: "conv_1",
              agentName: "test_agent",
              status: "running",
              startedAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
              lastSequence: 0
            },
            projection: {
              runId: "run_1",
              lastSequence: 0,
              status: "running",
              text: "",
              reasoning: [],
              activeToolCalls: []
            }
          },
          userState: {
            clientInstanceId: "client_1",
            conversationId: "conv_1",
            userId: "user_1",
            updatedAt: "2026-06-27T00:00:00.000Z"
          },
          serverTime: "2026-06-27T00:00:00.000Z"
        },
        eventsUrl: "https://chat.example/api/conversations/conv_1/runs/run_1/events"
      });
    };
    const client = createApiClient({
      baseUrl: "https://chat.example",
      getToken: () => "test-token",
      fetchImpl
    });

    await client.conversations.startRun("conv 1", {
      idempotencyKey: "idem_1",
      message: { text: "Hello" }
    });
    await client.conversations.createAndStartRun({
      idempotencyKey: "idem_2",
      message: { text: "Hello" }
    });
    await client.runs.cancel("conv 1", "run 1", { reason: "user_requested" });
    await client.runs.command("conv 1", "run 1", { command: { type: "continue" } });
    const observed = [];
    for await (const observation of client.runs.observe("conv_1", "run_1", { afterSequence: 7 })) {
      observed.push(observation);
    }

    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      "POST /api/conversations/conv%201/runs",
      "POST /api/conversations/runs",
      "POST /api/conversations/conv%201/runs/run%201/cancel",
      "POST /api/conversations/conv%201/runs/run%201/commands",
      "GET /api/conversations/conv_1/runs/run_1/events?after=7"
    ]);
    expect(calls.every((request) => request.headers.get("authorization") === "Bearer test-token")).toBe(true);
    expect(calls[4]?.headers.get("last-event-id")).toBeNull();
    expect(calls[4]?.headers.get("accept")).toBe("text/event-stream");
    expect(observed).toEqual([
      expect.objectContaining({
        runId: "run_1",
        sequence: 8,
        type: "run_completed"
      })
    ]);
  });

  it("exposes caught-up 204 observation streams without yielding events", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request);
      return new Response(null, { status: 204 });
    };
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl
    });
    const observed = [];
    let caughtUp = false;

    for await (const observation of client.observeRunEvents("conv_1", "run_1", {
      afterSequence: 7,
      onCaughtUp: () => {
        caughtUp = true;
      }
    })) {
      observed.push(observation);
    }

    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)).toEqual([
      "GET /api/conversations/conv_1/runs/run_1/events?after=7"
    ]);
    expect(observed).toEqual([]);
    expect(caughtUp).toBe(true);
  });

  it("keeps normal server route registrations tied to the operation catalog", async () => {
    const routeFiles = [
      "packages/chat-server/src/routes/audit-routes.ts",
      "packages/chat-server/src/routes/agent-run-routes.ts",
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

  it("does not keep the deleted legacy live chat stream path in the API contract", async () => {
    const [contractSource, routeSource] = await Promise.all([
      readFile("packages/api-contract/src/index.ts", "utf8"),
      readFile("packages/chat-server/src/routes/agent-run-routes.ts", "utf8")
    ]);

    expect(contractSource).not.toContain("chatStreamRoutePath");
    expect(contractSource).not.toContain("chatStreamRequestSchema");
    expect(contractSource).not.toContain("chatStreamChunkSchema");
    expect(routeSource).not.toContain("/api/chat");
  });
});
