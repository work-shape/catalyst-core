import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  apiOperations,
  assistantFinalMessageMetadataSchema,
  buildApiPath,
  openApiDocument
} from "@vivd-catalyst/api-contract";
import { ApiError, createApiClient } from "@vivd-catalyst/api-client";

describe("api operation catalog and client", () => {
  it("accepts assistant final metadata with normalized web sources and citations", () => {
    const parsed = assistantFinalMessageMetadataSchema.safeParse({
      version: 1,
      kind: "assistant_final",
      runId: "run_web",
      finishStatus: "completed",
      sources: [
        {
          id: "web_source_1",
          url: "https://example.com/report",
          title: "Example Report",
          provider: "openai-native",
          query: "example report",
          snippet: "A short source snippet.",
          resultPosition: 1
        }
      ],
      citations: [
        {
          sourceId: "web_source_1",
          label: "Example Report",
          characterRange: {
            start: 4,
            end: 18
          }
        }
      ]
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps the OpenAPI artifact generated from the operation catalog", async () => {
    const artifact = JSON.parse(
      await readFile("packages/api-contract/openapi.json", "utf8")
    ) as unknown;

    expect(artifact).toEqual(openApiDocument);
    for (const operation of Object.values(apiOperations)) {
      const openApiPath = operation.path.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
      const pathItem = (
        openApiDocument.paths as Record<string, Record<string, { operationId: string }>>
      )[openApiPath];
      expect(pathItem?.[operation.method.toLowerCase()]?.operationId).toBe(operation.operationId);
    }
  });

  it("keeps Collaboration Workspace create and update request contracts aligned", () => {
    const createOperation = openApiDocument.paths["/api/collaboration-workspaces"].post;
    const createSchema = createOperation.requestBody.content["application/json"].schema;

    expect(createSchema.required).toEqual(["name"]);
    expect(
      apiOperations.createCollaborationWorkspace.requestSchema.parse({ name: "Product" })
    ).toEqual({ name: "Product" });
    expect(apiOperations.updateCollaborationWorkspace.requestSchema.parse({})).toEqual({});
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
      apiOperations.listConversations.buildPath({
        query: { collaborationWorkspaceId: "workspace/one" }
      })
    ).toBe("/api/conversations?collaborationWorkspaceId=workspace%2Fone");
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
    expect(() => apiOperations.listConversations.buildPath()).toThrow(
      /Missing query parameter "collaborationWorkspaceId"/u
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

    await expect(client.conversations.listMessages("conversation/with space")).resolves.toEqual([]);

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

  it("exposes the stable server error code on ApiError", async () => {
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async () =>
        Response.json(
          { error: { code: "VALIDATION_FAILED", message: "Workspace name does not match" } },
          { status: 422 }
        )
    });

    const error = await client.collaborationWorkspaces
      .delete("workspace_1", "wrong")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Workspace name does not match",
      status: 422
    });
  });

  it("forces promoted managed artifact content to a blob regardless of content type", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request);
      return new Response("artifact-bytes", {
        headers: {
          "content-type": "application/json"
        }
      });
    };
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      getToken: () => "test-token",
      fetchImpl
    });

    const blob = await client.conversations.artifacts.getContent("conv 1", "art/final");

    expect(await blob.text()).toBe("artifact-bytes");
    expect(blob.type).toBe("application/json");
    expect(client.browserManagedDownloads).toBe(false);
    expect(client.conversations.artifacts.contentUrl("conv 1", "art/final")).toBe(
      `https://chat.example${apiOperations.getConversationArtifactContent.buildPath({
        params: { conversationId: "conv 1", artifactId: "art/final" }
      })}`
    );
    expect(client.conversations.artifacts.contentUrl("conv 1", "art/final", true)).toBe(
      `https://chat.example${apiOperations.getConversationArtifactContent.buildPath({
        params: { conversationId: "conv 1", artifactId: "art/final" }
      })}?inline=true`
    );
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.url).toBe(
      `https://chat.example${apiOperations.getConversationArtifactContent.buildPath({
        params: { conversationId: "conv 1", artifactId: "art/final" }
      })}`
    );
    expect(request?.method).toBe("GET");
    expect(request?.credentials).toBe("include");
    expect(request?.headers.get("authorization")).toBe("Bearer test-token");
  });

  it("builds browser-managed inline file URLs with encoded identifiers", () => {
    const client = createApiClient({
      baseUrl: "https://chat.example/"
    });

    expect(client.conversations.files.contentUrl("conv 1", "file/image")).toBe(
      `https://chat.example${apiOperations.getConversationFileContent.buildPath({
        params: { conversationId: "conv 1", fileId: "file/image" }
      })}`
    );
  });

  it("forces conversation file content to a blob regardless of content type", async () => {
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      fetchImpl: async () =>
        new Response("source-file-bytes", {
          headers: { "content-type": "text/plain" }
        })
    });

    const blob = await client.conversations.files.getContent("conv_1", "file_1");

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/plain");
    expect(await blob.text()).toBe("source-file-bytes");
  });

  it("fetches promoted managed artifact preview state through the API client", async () => {
    const calls: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request);
      return Response.json({
        status: "ready",
        artifactId: "art/final",
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: "art/page-1",
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1
          }
        ]
      });
    };
    const client = createApiClient({
      baseUrl: "https://chat.example/",
      getToken: () => "test-token",
      fetchImpl
    });

    await expect(client.conversations.artifacts.getPreview("conv 1", "art/final")).resolves.toEqual(
      {
        status: "ready",
        artifactId: "art/final",
        type: "image_pages",
        format: "png",
        pages: [
          {
            artifactId: "art/page-1",
            mimeType: "image/png",
            filename: "page-1.png",
            pageNumber: 1
          }
        ]
      }
    );
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.url).toBe(
      `https://chat.example${apiOperations.getConversationArtifactPreview.buildPath({
        params: { conversationId: "conv 1", artifactId: "art/final" }
      })}`
    );
    expect(request?.method).toBe("GET");
    expect(request?.credentials).toBe("include");
    expect(request?.headers.get("authorization")).toBe("Bearer test-token");
  });

  it("marks artifact downloads as browser-managed when no token provider is configured", () => {
    const client = createApiClient({
      baseUrl: "https://chat.example/"
    });

    expect(client.browserManagedDownloads).toBe(true);
    expect(client.conversations.artifacts.contentUrl("conversation/with space", "art/final")).toBe(
      "https://chat.example/api/conversations/conversation%2Fwith%20space/artifacts/art%2Ffinal/content"
    );
  });

  it("validates request bodies through operation schemas before fetch", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("fetch should not run for invalid request input");
    };
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl
    });

    expect(() => client.conversations.create({ title: "" })).toThrow();
    expect(() => client.conversations.rename("conv_1", "   ")).toThrow();
  });

  it("lets the generated SDK own multipart boundaries", async () => {
    let request: Request | undefined;
    const attachment = {
      id: "attachment_1",
      conversationId: "conv_1",
      fileId: "file_1",
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      status: "ready" as const,
      artifactRefs: {},
      processingMetadata: {},
      warnings: [],
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z"
    };
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async (input, init) => {
        request = input instanceof Request ? input : new Request(input, init);
        return Response.json({ attachment, attachments: [attachment], outcome: "created" });
      }
    });

    await client.conversations.draftAttachments.upload(
      "conv_1",
      new File(["notes"], "notes.txt", { type: "text/plain" })
    );

    expect(request?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/u);
    expect(await request?.clone().text()).toContain('filename="notes.txt"');
  });

  it("normalizes generated HTTP and network failures as ApiError", async () => {
    const httpClient = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async () =>
        Response.json({ error: { message: "Conversation unavailable" } }, { status: 503 })
    });
    const networkFailure = new TypeError("offline");
    const networkClient = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async () => {
        throw networkFailure;
      }
    });

    await expect(httpClient.conversations.list()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Conversation unavailable"
    });
    await expect(networkClient.conversations.list()).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "API request failed",
      payload: networkFailure
    });
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
          collaborationWorkspaceId: "cws_1",
          createdByUserId: "user_1",
          createdByExternalUserId: "user_1",
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
            collaborationWorkspaceId: "cws_1",
            createdByUserId: "user_1",
            createdByExternalUserId: "user_1",
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

    await client.runs.start("conv 1", {
      idempotencyKey: "idem_1",
      message: { text: "Hello" }
    });
    await client.runs.create({
      idempotencyKey: "idem_2",
      message: { text: "Hello" }
    });
    await client.runs.cancel("conv 1", "run 1", { reason: "user_requested" });
    await client.runs.command("conv 1", "run 1", { command: { type: "continue" } });
    const observed = [];
    for await (const observation of client.runs.observe("conv_1", "run_1", { afterSequence: 7 })) {
      observed.push(observation);
    }

    expect(
      calls.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
      )
    ).toEqual([
      "POST /api/conversations/conv%201/runs",
      "POST /api/conversations/runs",
      "POST /api/conversations/conv%201/runs/run%201/cancel",
      "POST /api/conversations/conv%201/runs/run%201/commands",
      "GET /api/conversations/conv_1/runs/run_1/events?after=7"
    ]);
    expect(
      calls.every((request) => request.headers.get("authorization") === "Bearer test-token")
    ).toBe(true);
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

    for await (const observation of client.runs.observe("conv_1", "run_1", {
      afterSequence: 7,
      onCaughtUp: () => {
        caughtUp = true;
      }
    })) {
      observed.push(observation);
    }

    expect(
      calls.map(
        (request) =>
          `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`
      )
    ).toEqual(["GET /api/conversations/conv_1/runs/run_1/events?after=7"]);
    expect(observed).toEqual([]);
    expect(caughtUp).toBe(true);
  });

  it("decodes incrementally split UTF-8 run events with CRLF framing", async () => {
    const observation = {
      clientInstanceId: "client_1",
      runId: "run_1",
      conversationId: "conv_1",
      ownerUserId: "user_1",
      sequence: 1,
      type: "message_delta",
      payload: {
        type: "message_delta",
        runId: "run_1",
        sequence: 1,
        createdAt: "2026-06-27T00:00:00.000Z",
        delta: "Hello 🌍"
      },
      createdAt: "2026-06-27T00:00:00.000Z"
    };
    const encoder = new TextEncoder();
    const [prefix, suffix] = `data: ${JSON.stringify(observation)}\r\n\r\n`.split("🌍");
    const emoji = encoder.encode("🌍");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([...encoder.encode(prefix), ...emoji.slice(0, 2)]));
        controller.enqueue(new Uint8Array([...emoji.slice(2), ...encoder.encode(suffix)]));
        controller.close();
      }
    });
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } })
    });
    const observed = [];

    for await (const event of client.runs.observe("conv_1", "run_1")) {
      observed.push(event);
    }

    expect(observed).toEqual([observation]);
    expect(stream.locked).toBe(false);
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
      const catalogRouteSource =
        file === "packages/chat-server/src/routes/session-token-routes.ts"
          ? source.replace('app.post("/auth/session-token", issueSessionToken);', "")
          : source;
      expect(catalogRouteSource, file).not.toMatch(
        /app\.(?:get|post|patch|put|delete)\(\s*["'`]\/(?:api|auth)\//u
      );
    }
  });

  it("does not keep the deleted legacy live chat stream path in the API contract", async () => {
    const contractSourceDirectory = "packages/api-contract/src";
    const contractSourceFiles = (await readdir(contractSourceDirectory, { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .sort();
    const [contractSources, routeSource] = await Promise.all([
      Promise.all(
        contractSourceFiles.map((file) => readFile(`${contractSourceDirectory}/${file}`, "utf8"))
      ),
      readFile("packages/chat-server/src/routes/agent-run-routes.ts", "utf8")
    ]);
    const contractSource = contractSources.join("\n");

    expect(contractSource).not.toContain("chatStreamRoutePath");
    expect(contractSource).not.toContain("chatStreamRequestSchema");
    expect(contractSource).not.toContain("chatStreamChunkSchema");
    expect(routeSource).not.toContain("/api/chat");
  });
});
