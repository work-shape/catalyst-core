import { contractPathFixtures, openApiJsonOperation } from "./support/operations";
import { required } from "./support/assertions";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  apiOperations,
  assistantFinalMessageMetadataSchema,
  buildApiPath,
  createOpenApiDocument,
  operationPathParamNames,
  type Operation
} from "@vivd-catalyst/api-contract";
import {
  ApiError,
  createApiClient,
  listAll,
  type AdministeredUser,
  type ApiClientOptions,
  type ConversationThreadSnapshot,
  type OperationInput,
  type RunObservation
} from "@vivd-catalyst/api-client";

const createdAt = "2026-06-27T00:00:00.000Z";

describe("api operation catalog", () => {
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

  // Which operations the document lists is the inventory of tests/api-version-paths.test.ts.
  it("keeps the OpenAPI artifact generated from the operation catalog", async () => {
    const artifact: unknown = JSON.parse(
      await readFile("packages/api-contract/openapi.json", "utf8")
    );
    // Stale after a catalog change: `pnpm generate:openapi` writes it again.
    expect(artifact).toEqual(JSON.parse(JSON.stringify(createOpenApiDocument())));
  });

  it("keeps Collaboration Workspace create and update request contracts aligned", () => {
    const createOperation = openApiJsonOperation("workspaces.create");
    const createSchema = createOperation.requestBody.content["application/json"].schema;

    expect(createSchema.required).toEqual(["name"]);
    expect(apiOperations["workspaces.create"].body.parse({ name: "Product" })).toEqual({
      name: "Product"
    });
    expect(apiOperations["workspaces.update"].body.parse({})).toEqual({});
  });

  it("describes agent availability and the config replacement answer", () => {
    expect(
      apiOperations["config_agents.set_availability"].body.parse({ mode: "selected" })
    ).toEqual({
      mode: "selected"
    });
    expect(() =>
      apiOperations["config_agents.set_availability"].body.parse({ mode: "some" })
    ).toThrow();
    expect(
      apiOperations["config_assets.replace"].response.schema.parse({
        version: 2,
        hiddenAgentNames: ["a"]
      })
    ).toEqual({ version: 2, hiddenAgentNames: ["a"] });
    expect(apiOperations["config_assets.replace"].response.schema.parse({ version: 2 })).toEqual({
      version: 2
    });
  });

  it("carries conversation visibility through the workspace, conversation and move contracts", () => {
    const moveOperation = openApiJsonOperation("conversations.move");
    const conversationSchema = required(moveOperation.responses["200"]).content["application/json"]
      .schema;
    expect(moveOperation.requestBody.content["application/json"].schema.required).toEqual([
      "collaborationWorkspaceId"
    ]);
    expect(conversationSchema.required).toContain("visibility");
    expect(
      apiOperations["workspaces.create"].body.parse({
        name: "Product",
        defaultConversationVisibility: "private"
      })
    ).toEqual({ name: "Product", defaultConversationVisibility: "private" });
    expect(() =>
      apiOperations["workspaces.update"].body.parse({
        defaultConversationVisibility: "secret"
      })
    ).toThrow();
    expect(() =>
      apiOperations["conversations.move"].body.parse({
        collaborationWorkspaceId: "cws_1",
        visibility: "secret"
      })
    ).toThrow();
  });

  it("builds encoded paths from operation params and query values", () => {
    expect(
      apiOperations["conversations.messages.list"].buildPath({
        params: { conversationId: "conversation 1/2" }
      })
    ).toBe(contractPathFixtures.encodedMessages);
    expect(apiOperations["config.get"].buildPath({ query: { locale: "de" } })).toBe(
      contractPathFixtures.localizedConfig
    );
    expect(
      apiOperations["conversations.list"].buildPath({
        query: { collaborationWorkspaceId: "workspace/one" }
      })
    ).toBe(contractPathFixtures.encodedWorkspaceConversations);
    expect(apiOperations["conversations.list"].buildPath()).toBe(
      contractPathFixtures.conversations
    );
    expect(
      buildApiPath(contractPathFixtures.exampleTemplate, {
        params: { exampleId: "value/with spaces" },
        query: { view: "full" }
      })
    ).toBe(contractPathFixtures.exampleValue);
    expect(() => apiOperations["conversations.messages.list"].buildPath()).toThrow(
      /Missing path parameter "conversationId"/u
    );
    expect(() => apiOperations["config.get"].buildPath({ query: { unknown: "value" } })).toThrow(
      /Unknown query parameter "unknown"/u
    );
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
      expect(source, file).toContain("apiOperations[");
      expect(source, file).not.toMatch(
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
    expect(routeSource).not.toContain(contractPathFixtures.retiredChat);
  });
});

const conversation = {
  id: "conv_1",
  clientInstanceId: "client_1",
  collaborationWorkspaceId: "cws_1",
  createdByUserId: "user_1",
  createdByExternalUserId: "user_1",
  visibility: "private",
  title: "Moved",
  status: "active",
  createdAt,
  updatedAt: createdAt,
  retainedUntil: "2026-07-27T00:00:00.000Z"
};

function observation(sequence: number, delta = "Hello") {
  return {
    clientInstanceId: "client_1",
    runId: "run_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    sequence,
    type: "message_delta",
    payload: { type: "message_delta", runId: "run_1", sequence, createdAt, delta },
    createdAt
  };
}

/** A client whose requests are recorded and answered by `answer`. */
function recordingClient(
  answer: (request: Request) => Response | Promise<Response>,
  options: Partial<ApiClientOptions> = {}
) {
  const requests: Request[] = [];
  const client = createApiClient({
    baseUrl: "https://chat.example/",
    ...options,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return answer(request);
    }
  });
  return { client, requests };
}

const pathOf = (request: Request | undefined) =>
  request ? `${new URL(request.url).pathname}${new URL(request.url).search}` : undefined;

const eventStream = (chunks: Array<string | Uint8Array>, end: "close" | Error = "close") => {
  const encoder = new TextEncoder();
  const pending = [...chunks];
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = pending.shift();
      if (chunk !== undefined) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      } else if (end === "close") {
        controller.close();
      } else {
        controller.error(end);
      }
    },
    cancel() {
      cancelled = true;
    }
  });
  return {
    body,
    response: () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    wasCancelled: () => cancelled
  };
};

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const runParams = { conversationId: "conv_1", runId: "run_1" };

async function collect<Item>(stream: AsyncIterable<Item>): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

describe("api client derived from the operation catalog", () => {
  it("has exactly one method per operation, under the segments of its id", () => {
    const { client } = recordingClient(() => Response.json({}));
    const methodIds: string[] = [];
    const walk = (node: object, prefix: string) => {
      for (const [segment, value] of Object.entries(node)) {
        if (typeof value === "function") methodIds.push(`${prefix}${segment}`);
        else if (value && typeof value === "object") walk(value, `${prefix}${segment}.`);
      }
    };
    walk(client, "");

    expect(methodIds.filter((id) => id !== "urlFor").sort()).toEqual(
      Object.keys(apiOperations).sort()
    );
  });

  it("sends every operation with the method and path of its descriptor", async () => {
    const operations = Object.values<Operation>(apiOperations).filter(
      (operation) => !operation.body && !operation.multipart
    );
    expect(operations.length).toBeGreaterThan(40);

    for (const operation of operations) {
      const { client, requests } = recordingClient(() => new Response(null, { status: 500 }));
      const params = Object.fromEntries(
        operationPathParamNames(operation.path).map((name) => [name, `${name} 1`])
      );
      let method: unknown = client;
      for (const segment of operation.id.split(".")) {
        method = Reflect.get(Object(method), segment);
      }
      if (typeof method !== "function") {
        expect.fail(`No client method for ${operation.id}`);
      }
      const result: unknown = method({ params });
      // A stream sends its request once it is read.
      await (result instanceof Promise ? result : collect(Object(result))).catch(() => undefined);

      expect(requests[0]?.method, operation.id).toBe(operation.method);
      expect(requests[0]?.url, operation.id).toBe(
        `https://chat.example${operation.buildPath({ params })}`
      );
    }
  });

  it("types the input and the answer of a method from its operation", () => {
    const { client } = recordingClient(() => Response.json({}));
    type Thread = OperationInput<"conversations.thread.get">;
    type Listing = OperationInput<"conversations.list">;

    // Path parameters are required by name; an operation without a body takes none.
    expectTypeOf<keyof Thread>().toEqualTypeOf<"params" | "signal">();
    expectTypeOf<Thread["params"]>().toEqualTypeOf<Record<"conversationId", string>>();
    expectTypeOf(client.conversations.thread.get).parameters.toEqualTypeOf<[input: Thread]>();
    expectTypeOf<keyof OperationInput<"me.get">>().toEqualTypeOf<"signal">();
    expectTypeOf(client.me.get).parameters.toEqualTypeOf<[input?: OperationInput<"me.get">]>();

    // A query carries the descriptor's parameters and nothing else, all of them optional here.
    expectTypeOf<keyof Listing>().toEqualTypeOf<"query" | "signal">();
    expectTypeOf<keyof NonNullable<Listing["query"]>>().toEqualTypeOf<
      "limit" | "cursor" | "collaborationWorkspaceId"
    >();
    expectTypeOf<NonNullable<Listing["query"]>["limit"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf(client.conversations.list).toBeCallableWith();

    // A body follows the request schema and cannot be left out.
    expectTypeOf<keyof OperationInput<"conversations.rename">>().toEqualTypeOf<
      "params" | "body" | "signal"
    >();
    expectTypeOf<OperationInput<"conversations.rename">["body"]>().toEqualTypeOf<{
      title: string;
    }>();
    expectTypeOf(client.conversations.create).parameters.toEqualTypeOf<
      [input: OperationInput<"conversations.create">]
    >();

    // An upload takes a file; only a stream reports that it is caught up.
    expectTypeOf<keyof OperationInput<"conversations.draft_attachments.upload">>().toEqualTypeOf<
      "params" | "file" | "signal"
    >();
    expectTypeOf<keyof OperationInput<"conversations.runs.observe">>().toEqualTypeOf<
      "params" | "query" | "signal" | "onCaughtUp"
    >();

    // The answer is what the response schema parses to, by the kind of the response.
    expectTypeOf(
      client.conversations.thread.get
    ).returns.resolves.toEqualTypeOf<ConversationThreadSnapshot>();
    expectTypeOf(client.users.list).returns.resolves.toEqualTypeOf<{
      items: AdministeredUser[];
      nextCursor?: string | undefined;
    }>();
    expectTypeOf(client.conversations.files.get_content).returns.toEqualTypeOf<Promise<Blob>>();
    expectTypeOf(client.conversations.runs.observe).returns.toEqualTypeOf<
      AsyncIterable<RunObservation>
    >();
  });

  it.each([
    { name: "cookie", getToken: undefined, credentials: "include", authorization: null },
    {
      name: "token",
      getToken: () => "test-token",
      credentials: "omit",
      authorization: "Bearer test-token"
    },
    {
      name: "asynchronous token",
      getToken: async () => "later-token",
      credentials: "omit",
      authorization: "Bearer later-token"
    },
    {
      name: "empty token source",
      getToken: () => undefined,
      credentials: "omit",
      authorization: null
    }
  ])(
    "uses $name mode for JSON, uploads, downloads and event streams",
    async ({ getToken, credentials, authorization }) => {
      const { client, requests } = recordingClient(
        (request) => {
          if (request.url.endsWith("/events")) return new Response(null, { status: 204 });
          if (request.url.includes("/content")) return new Response("download");
          return Response.json({ items: [] });
        },
        { getToken, browserManagedDownloads: true }
      );
      await client.conversations.list();
      await client.conversations.files.get_content({
        params: { conversationId: "conv_1", fileId: "file_1" }
      });
      await client.conversations.draft_attachments
        .upload({ params: { conversationId: "conv_1" }, file: new File(["notes"], "notes.txt") })
        .catch(() => undefined);
      await collect(client.conversations.runs.observe({ params: runParams }));

      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.credentials).toBe(credentials);
        expect(request.headers.get("authorization")).toBe(authorization);
      }
      // A browser can only fetch a file by itself when a cookie carries the session.
      expect(client.browserManagedDownloads).toBe(getToken === undefined);
    }
  );

  it("lets a cookie client turn browser-managed downloads off", () => {
    expect(
      createApiClient({ baseUrl: "https://chat.example", browserManagedDownloads: false })
        .browserManagedDownloads
    ).toBe(false);
  });

  it("builds the path, the query and a JSON body, and parses the JSON answer", async () => {
    const { client, requests } = recordingClient(() => Response.json(conversation));

    await expect(
      client.conversations.move({
        params: { conversationId: "conv 1/2" },
        body: { collaborationWorkspaceId: "cws_2", visibility: "private" }
      })
    ).resolves.toEqual(conversation);
    await client.conversations.title.generate({ params: { conversationId: "conv_1" } });

    expect(requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      "POST /api/v1/conversations/conv%201%2F2/move",
      "POST /api/v1/conversations/conv_1/title"
    ]);
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    await expect(requests[0]?.json()).resolves.toEqual({
      collaborationWorkspaceId: "cws_2",
      visibility: "private"
    });
    // An operation without a body sends none, and no content type that would announce one.
    expect(requests[1]?.headers.get("content-type")).toBeNull();
    expect(requests[1]?.body).toBeNull();
  });

  it("leaves out query parameters that are not set", async () => {
    const { client, requests } = recordingClient(() => Response.json({ items: [] }));

    await client.conversations.list();
    await client.conversations.list({ query: { collaborationWorkspaceId: "workspace/one" } });
    await client.conversations.list({ query: { collaborationWorkspaceId: undefined, limit: 5 } });

    expect(requests.map(pathOf)).toEqual([
      contractPathFixtures.conversations,
      contractPathFixtures.encodedWorkspaceConversations,
      `${contractPathFixtures.conversations}?limit=5`
    ]);
  });

  it("refuses an input outside the request schema before any request is sent", async () => {
    const { client, requests } = recordingClient(() => Response.json(conversation));

    await expect(client.conversations.create({ body: { title: "" } })).rejects.toThrow();
    await expect(
      client.conversations.rename({ params: { conversationId: "conv_1" }, body: { title: "  " } })
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("answers one page per call and reads a list to its end on request", async () => {
    const workspace = (id: string) => ({ id, name: id, visibility: "private", createdAt });
    const { client, requests } = recordingClient((request) =>
      new URL(request.url).searchParams.get("cursor") === "second"
        ? Response.json({ items: [workspace("cws_2")] })
        : Response.json({ items: [workspace("cws_1")], nextCursor: "second" })
    );

    // The admin picker carries the id and name only: the schema drops the rest.
    await expect(client.instance.workspaces.list({ query: { limit: 1 } })).resolves.toEqual({
      items: [{ id: "cws_1", name: "cws_1", createdAt }],
      nextCursor: "second"
    });
    const all = await listAll((paging) => client.instance.workspaces.list({ query: paging }));

    expect(all.map((row) => row.id)).toEqual(["cws_1", "cws_2"]);
    expect(requests.map(pathOf)).toEqual([
      `${contractPathFixtures.adminWorkspaces}?limit=1`,
      `${contractPathFixtures.adminWorkspaces}?limit=200`,
      `${contractPathFixtures.adminWorkspaces}?limit=200&cursor=second`
    ]);
  });

  it("returns a file as a blob whatever content type it has", async () => {
    const { client, requests } = recordingClient(
      () => new Response("artifact-bytes", { headers: { "content-type": "application/json" } }),
      { getToken: () => "test-token" }
    );

    const blob = await client.conversations.artifacts.get_content({
      params: { conversationId: "conv 1", artifactId: "art/final" }
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe("artifact-bytes");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toBe(
      "https://chat.example/api/v1/conversations/conv%201/artifacts/art%2Ffinal/content"
    );
  });

  it("builds the URL of an operation for the browser to load itself", () => {
    const client = createApiClient({ baseUrl: "https://chat.example/" });
    const params = { conversationId: "conv 1", artifactId: "art/final" };

    expect(client.urlFor("conversations.artifacts.get_content", { params })).toBe(
      "https://chat.example/api/v1/conversations/conv%201/artifacts/art%2Ffinal/content"
    );
    expect(
      client.urlFor("conversations.artifacts.get_content", { params, query: { inline: "true" } })
    ).toBe(
      "https://chat.example/api/v1/conversations/conv%201/artifacts/art%2Ffinal/content?inline=true"
    );
    expect(
      client.urlFor("conversations.files.get_content", {
        params: { conversationId: "conv 1", fileId: "file/image" }
      })
    ).toBe("https://chat.example/api/v1/conversations/conv%201/files/file%2Fimage/content");
  });

  it("uploads a file as multipart and leaves the boundary to the runtime", async () => {
    const attachment = {
      id: "attachment_1",
      conversationId: "conv_1",
      fileId: "file_1",
      filename: "notes.txt",
      mimeType: "text/plain",
      byteSize: 5,
      status: "ready",
      artifactRefs: {},
      processingMetadata: {},
      warnings: [],
      createdAt,
      updatedAt: createdAt
    };
    const { client, requests } = recordingClient(() =>
      Response.json({ attachment, attachments: [attachment], outcome: "created" })
    );

    const uploaded = await client.conversations.draft_attachments.upload({
      params: { conversationId: "conv_1" },
      file: new File(["notes"], "notes.txt", { type: "text/plain" })
    });

    expect(uploaded.outcome).toBe("created");
    expect(requests[0]?.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/u);
    const form = await requests[0]?.formData();
    const file = form?.get("file");
    expect(file).toBeInstanceOf(File);
    expect(file instanceof File ? [file.name, await file.text()] : []).toEqual([
      "notes.txt",
      "notes"
    ]);
  });

  it.each([
    ["an empty answer", () => new Response(null, { status: 204 }), "not valid JSON"],
    ["a body that is not JSON", () => new Response("<html>"), "not valid JSON"],
    [
      // A conversation without visibility must not pass as a silently shared one.
      "JSON outside the response schema",
      () => Response.json({ ...conversation, visibility: undefined }),
      "does not match the contract"
    ],
    [
      "a list without its envelope",
      () => Response.json([conversation]),
      "does not match the contract"
    ]
  ])("fails on %s where the contract promises JSON", async (_name, answer, message) => {
    const { client } = recordingClient(answer);
    const call =
      message === "does not match the contract" && _name.startsWith("a list")
        ? client.conversations.list()
        : client.conversations.thread.get({ params: { conversationId: "conv_1" } });

    const error = await call.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: expect.stringContaining(message), code: undefined });
    expect(error instanceof ApiError && error.payload).toBeInstanceOf(Error);
  });

  it("maps a refusal to an ApiError with the server's code, message and correlation id", async () => {
    const { client } = recordingClient(() =>
      Response.json(
        { error: { code: "RATE_LIMITED", message: "Try later", correlationId: "corr_1" } },
        { status: 429 }
      )
    );
    const refusals = await Promise.all([
      client.conversations.list().catch((caught: unknown) => caught),
      client.conversations.files
        .get_content({ params: { conversationId: "conv_1", fileId: "file_1" } })
        .catch((caught: unknown) => caught),
      collect(client.conversations.runs.observe({ params: runParams })).catch(
        (caught: unknown) => caught
      )
    ]);

    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(ApiError);
      expect(refusal).toMatchObject({
        name: "ApiError",
        status: 429,
        code: "RATE_LIMITED",
        message: "Try later",
        correlationId: "corr_1"
      });
    }
  });

  it("does not trust the body of a refusal", async () => {
    const answers = [
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => Response.json({ error: { code: "MADE_UP", message: 42 } }, { status: 500 }),
      () => Response.json({ error: "nope" }, { status: 400 }),
      () => new Response(null, { status: 503 })
    ];
    const errors = [];
    for (const answer of answers) {
      errors.push(
        await recordingClient(answer)
          .client.conversations.list()
          .catch((caught: unknown) => caught)
      );
    }

    expect(errors).toMatchObject([
      { status: 502, message: "API request failed", payload: "<html>Bad gateway</html>" },
      { status: 500, message: "API request failed", code: undefined },
      { status: 400, message: "API request failed", code: undefined },
      { status: 503, message: "API request failed", payload: "" }
    ]);
    expect(errors.every((error) => error instanceof ApiError)).toBe(true);
  });

  it("maps a request without an answer to an ApiError of status 0", async () => {
    const offline = new TypeError("offline");
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async () => {
        throw offline;
      }
    });

    await expect(client.conversations.list()).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "API request failed",
      payload: offline
    });
  });

  it("maps an answer that breaks off while it is read", async () => {
    const { client } = recordingClient(
      () => new Response(eventStream(['{"items":'], new TypeError("connection reset")).body)
    );

    await expect(client.conversations.list()).rejects.toMatchObject({
      name: "ApiError",
      status: 0
    });
  });

  it("leaves an abort as the caller's own abort", async () => {
    const controller = new AbortController();
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener("abort", abort);
        })
    });

    const pending = client.me.get({ signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending).rejects.not.toBeInstanceOf(ApiError);
  });
});

describe("event streams of the api client", () => {
  it("asks for an event stream from the position the caller gives", async () => {
    const { client, requests } = recordingClient(() =>
      eventStream([frame(observation(8))]).response()
    );

    const observed = await collect(
      client.conversations.runs.observe({ params: runParams, query: { after: "7" } })
    );

    expect(observed).toEqual([observation(8)]);
    expect(requests.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
      "GET /api/v1/conversations/conv_1/runs/run_1/events?after=7"
    ]);
    expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(requests[0]?.headers.get("last-event-id")).toBeNull();
  });

  it("sends nothing until the stream is read", async () => {
    const { client, requests } = recordingClient(() => eventStream([]).response());

    const stream = client.conversations.runs.observe({ params: runParams });
    expect(requests).toHaveLength(0);
    await collect(stream);
    expect(requests).toHaveLength(1);
  });

  it("reports a caught-up 204 and yields nothing", async () => {
    const { client } = recordingClient(() => new Response(null, { status: 204 }));
    let caughtUp = 0;

    const observed = await collect(
      client.conversations.runs.observe({
        params: runParams,
        query: { after: "7" },
        onCaughtUp: () => {
          caughtUp += 1;
        }
      })
    );

    expect(observed).toEqual([]);
    expect(caughtUp).toBe(1);
  });

  it("ends quietly when a stream closes without events, which is not caught up", async () => {
    const stream = eventStream([": keep-alive\n\n"]);
    const { client } = recordingClient(stream.response);
    let caughtUp = false;

    const observed = await collect(
      client.conversations.runs.observe({
        params: runParams,
        onCaughtUp: () => {
          caughtUp = true;
        }
      })
    );

    expect(observed).toEqual([]);
    expect(caughtUp).toBe(false);
    expect(stream.body.locked).toBe(false);
  });

  it("reads events cut anywhere: inside a character, a line ending, a field and a frame", async () => {
    const encoder = new TextEncoder();
    const first = observation(1, "Hello 🌍");
    const second = observation(2, "second");
    const third = observation(3, "third");
    const [prefix = "", suffix = ""] = `id: 1\r\nevent: message_delta\r\ndata: ${JSON.stringify(
      first
    )}\r\n\r`.split("🌍");
    const emoji = encoder.encode("🌍");
    const secondFrame = `id: 2\ndata: ${JSON.stringify(second)}\n\n`;
    const stream = eventStream([
      // Inside the four bytes of one character.
      new Uint8Array([...encoder.encode(prefix), ...emoji.slice(0, 2)]),
      // Between the carriage return and the line feed that end the frame.
      new Uint8Array([...emoji.slice(2), ...encoder.encode(suffix)]),
      // Inside the field name of the next frame, with a comment before it.
      `\n: keep-alive\n\n${secondFrame.slice(0, 9)}`,
      // Two frames end in one chunk, the last without a blank line before the stream closes.
      `${secondFrame.slice(9)}data: ${JSON.stringify(third)}`
    ]);
    const { client } = recordingClient(stream.response);

    const observed = await collect(client.conversations.runs.observe({ params: runParams }));

    expect(observed).toEqual([first, second, third]);
    expect(stream.body.locked).toBe(false);
  });

  it("joins the data lines of one event", async () => {
    const json = JSON.stringify(observation(1));
    const cut = json.indexOf('"sequence"');
    const stream = eventStream([`data: ${json.slice(0, cut)}\ndata:${json.slice(cut)}\n\n`]);
    const { client } = recordingClient(stream.response);

    await expect(
      collect(client.conversations.runs.observe({ params: runParams }))
    ).resolves.toEqual([observation(1)]);
  });

  it("closes the connection when the reader stops early", async () => {
    const stream = eventStream([
      frame(observation(1)),
      frame(observation(2)),
      frame(observation(3))
    ]);
    const { client } = recordingClient(stream.response);
    const observed = [];

    for await (const event of client.conversations.runs.observe({ params: runParams })) {
      observed.push(event.sequence);
      break;
    }

    expect(observed).toEqual([1]);
    expect(stream.wasCancelled()).toBe(true);
    expect(stream.body.locked).toBe(false);
  });

  it("passes an abort before the answer on as the caller's abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return new Response(null, { status: 204 });
      }
    });

    const failure = await collect(
      client.conversations.runs.observe({ params: runParams, signal: controller.signal })
    ).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ name: "AbortError" });
    expect(failure).not.toBeInstanceOf(ApiError);
  });

  it("stops a running stream on abort and closes it", async () => {
    const controller = new AbortController();
    let cancelled = false;
    // Like fetch: the body fails with the abort reason once the request's signal fires.
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(frame(observation(1))));
        controller.signal.addEventListener("abort", () =>
          streamController.error(controller.signal.reason)
        );
      },
      cancel() {
        cancelled = true;
      }
    });
    const { client, requests } = recordingClient(() => new Response(body));
    const observed: number[] = [];

    const failure = await (async () => {
      for await (const event of client.conversations.runs.observe({
        params: runParams,
        signal: controller.signal
      })) {
        observed.push(event.sequence);
        controller.abort();
      }
    })().catch((caught: unknown) => caught);

    expect(observed).toEqual([1]);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(failure).not.toBeInstanceOf(ApiError);
    expect(body.locked).toBe(false);
    // An errored body has nothing left to cancel; the reader is released either way.
    expect(cancelled).toBe(false);
  });

  it("resumes after the last event it saw when the connection breaks", async () => {
    const answers = [
      eventStream([frame(observation(1)), frame(observation(2))], new TypeError("terminated")),
      eventStream([frame(observation(3))])
    ];
    const { client, requests } = recordingClient(
      () => answers.shift()?.response() ?? new Response(null, { status: 204 })
    );
    const seen: number[] = [];
    const read = async () => {
      const after = seen.at(-1);
      for await (const event of client.conversations.runs.observe({
        params: runParams,
        query: after === undefined ? {} : { after: String(after) }
      })) {
        seen.push(event.sequence);
      }
    };

    // The events before the break are delivered; the break itself is a failed call.
    await expect(read()).rejects.toMatchObject({ name: "ApiError", status: 0 });
    expect(seen).toEqual([1, 2]);
    await read();

    expect(seen).toEqual([1, 2, 3]);
    const observe = apiOperations["conversations.runs.observe"];
    expect(requests.map(pathOf)).toEqual([
      observe.buildPath({ params: runParams }),
      observe.buildPath({ params: runParams, query: { after: "2" } })
    ]);
  });

  it.each([
    ["is not JSON", "data: {not json\n\n", "not valid JSON"],
    [
      "is outside the event schema",
      frame({ ...observation(2), sequence: "two" }),
      "does not match the contract"
    ]
  ])("fails on an event that %s, after the events before it", async (_name, bad, message) => {
    const stream = eventStream([frame(observation(1)), bad, frame(observation(3))]);
    const { client } = recordingClient(stream.response);
    const seen: number[] = [];

    const failure = await (async () => {
      for await (const event of client.conversations.runs.observe({ params: runParams })) {
        seen.push(event.sequence);
      }
    })().catch((caught: unknown) => caught);

    expect(seen).toEqual([1]);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ message: expect.stringContaining(message) });
    expect(stream.wasCancelled()).toBe(true);
  });
});
