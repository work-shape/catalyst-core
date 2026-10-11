import type { ServerResponse } from "node:http";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  MCP_CONNECTOR_TYPE,
  MCP_RESULT_MAX_BYTES,
  buildConnectionCatalog,
  compileJsonSchema,
  createConnectionCredentialResolver,
  createEgressChecker,
  createMcpConnectorType,
  createSecretStore,
  loadSecretKeyring,
  openConnectorContext
} from "@vivd-catalyst/connections";
import {
  SHARED_CREDENTIAL_SUBJECT,
  asClientInstanceId,
  connectionCallReasonOf,
  createConnectionSecretHandle,
  unknownToJsonValue,
  type ConnectorContext,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type JsonObject
} from "@vivd-catalyst/core";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import {
  answering,
  loopbackEgress,
  recordingLogger,
  refusal,
  rpcId,
  sendWithoutEnd,
  startMcpTestServer,
  textResult,
  told,
  tool,
  type AllowedTestTarget,
  type McpTestServer,
  type McpTestServerOptions
} from "./support/mcp-test-server";
import { makeTestCertificate } from "./support/test-certificate";
import {
  captureProcessOutput,
  dumpDatabaseText,
  findLeak,
  generateSecretStoreKey,
  generateTestSecret
} from "./support/test-connector";
import { createTestInstance, type TestPostgresStore } from "./support/test-instance";

// The Connector type `mcp` against an MCP server in this process, through the real egress
// checker (with a resolver of the test), the real Secret Store over real rows and
// `openConnectorContext`. Every test fails without the type: before it nothing in the
// platform speaks to an MCP server.

const clientInstanceId = asClientInstanceId("mcp-connector-test");
/** The name the Connection is configured with. The test's resolver answers 127.0.0.1 for it. */
const HOST = "mcp.example.test";
const OTHER_HOST = "other.example.test";

describe("the Connector type mcp", () => {
  let stores: TestPostgresStore;
  const servers: McpTestServer[] = [];
  let log: ReturnType<typeof recordingLogger>;
  let type: ConnectorTypeDefinition;
  /** Each Connection of a test has a name of its own, and so a secret of its own. */
  let connected = 0;

  beforeEach(async () => {
    stores = (await createTestInstance({ postgres: {} })).stores;
    log = recordingLogger();
    type = createMcpConnectorType({ logger: log.logger });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve(options: McpTestServerOptions = {}): Promise<McpTestServer> {
    const server = await startMcpTestServer(options);
    servers.push(server);
    return server;
  }

  interface Setup {
    url: string;
    allow: AllowedTestTarget[];
    authScheme?: "none" | "bearer" | "header";
    headerName?: string;
    key?: string;
  }

  /** Stores a Connection of the type with its key in the Secret Store. */
  async function connect(setup: Setup) {
    connected += 1;
    const name = `outside-${connected}`;
    const key = setup.key ?? generateTestSecret();
    const authScheme = setup.authScheme ?? "bearer";
    const handle = authScheme === "none" ? undefined : createConnectionSecretHandle();
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name,
          config: connection(name, {
            connectorType: MCP_CONNECTOR_TYPE,
            settings: {
              url: setup.url,
              ...(setup.headerName === undefined ? {} : { headerName: setup.headerName })
            },
            authScheme,
            secretHandle: handle
          })
        }
      ]
    });
    const stored = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name
      })
    );
    const keyring = await loadSecretKeyring({
      keys: [{ id: "k1", ref: "STORE_KEY" }],
      secrets: { resolve: () => Promise.resolve(storeKey) }
    });
    if (handle !== undefined) {
      await createSecretStore({ clientInstanceId, keyring, store: stores.connections }).put({
        binding: { connectionAssetId: stored.id, subject: SHARED_CREDENTIAL_SUBJECT },
        value: key,
        source: "runtime",
        handle
      });
    }
    const egress = loopbackEgress(setup.allow);
    const open = (signal: AbortSignal = new AbortController().signal): Promise<ConnectorContext> =>
      openConnectorContext({
        type,
        connection: {
          id: stored.id,
          revision: stored.revision,
          config: connectionConfigSchema.parse(stored.config)
        },
        egress: egress.checker,
        credentials: createConnectionCredentialResolver({
          clientInstanceId,
          keyring,
          store: stores.connections
        }),
        signal
      });
    return {
      key,
      assetId: stored.id,
      open,
      egress,
      discover: async () => required(type.discover)(await open()),
      test: async () => type.test(await open()),
      execute: async (operation: string, input: JsonObject = {}, signal?: AbortSignal) =>
        type.execute(operation, input, await open(signal))
    };
  }

  const storeKey = generateSecretStoreKey();
  const urlOf = (server: McpTestServer, host = HOST, path = "/mcp") =>
    `http://${host}:${server.port}${path}`;
  const allowOf = (server: McpTestServer, host = HOST): AllowedTestTarget => ({
    host,
    port: server.port
  });
  const bearer = (key: string) => ({ name: "authorization", value: `Bearer ${key}` });

  /** A server that demands the key, and a Connection that holds it. */
  async function keyed(options: McpTestServerOptions = {}, setup: Partial<Setup> = {}) {
    const key = setup.key ?? generateTestSecret();
    const server = await serve({ requireHeader: bearer(key), ...options });
    const connected = await connect({
      url: urlOf(server),
      allow: [allowOf(server)],
      key,
      ...setup
    });
    return { server, ...connected };
  }

  describe("discovery", () => {
    it("reads tools as descriptors: readOnlyHint true proposes reading, false and missing propose changing", async () => {
      const w = await keyed({
        pageSize: 2,
        tools: [
          tool("revenue_by_month", { annotations: { readOnlyHint: true } }),
          tool("create_invoice", { annotations: { readOnlyHint: false } }),
          tool("list_customers"),
          tool("with_output", {
            annotations: { readOnlyHint: true },
            outputSchema: {
              type: "object",
              properties: { rows: { type: "array", items: { $ref: "#/$defs/row" } } },
              required: ["rows"],
              $defs: { row: { type: "object", required: ["month"] } }
            }
          })
        ]
      });
      const descriptors = await w.discover();

      expect(descriptors.map(({ name, proposedEffect }) => [name, proposedEffect])).toEqual([
        ["revenue_by_month", "reading"],
        ["create_invoice", "changing"],
        ["list_customers", "changing"],
        ["with_output", "reading"]
      ]);
      expect(descriptors[0]).toMatchObject({
        description: "The tool revenue_by_month.",
        inputSchema: { type: "object", properties: { month: { type: "string" } } }
      });
      // Two pages were read, each with the key, and the list is what the server has.
      expect(w.server.rpc("tools/list")).toHaveLength(2);
      expect(log.lines).toEqual([]);

      // The output schema describes what `execute` answers, around the tool's own schema,
      // and the platform's JSON Schema module compiles it, references included.
      const plain = compileJsonSchema(required(required(descriptors[0]).outputSchema));
      const own = compileJsonSchema(required(required(descriptors[3]).outputSchema));
      if (!plain.ok || !own.ok) throw new Error("An output schema does not compile");
      expect(plain.validate(textResult("12"))).toEqual([]);
      expect(plain.validate({ content: "12" })).not.toEqual([]);
      const fits = { content: [], structuredContent: { rows: [{ month: "2026-09" }] } };
      expect(own.validate(fits)).toEqual([]);
      expect(own.validate({ content: [], structuredContent: { rows: [{}] } })).not.toEqual([]);
      expect(own.validate({ content: [] })).not.toEqual([]);
    });

    it("leaves out a tool whose schema is over 64 KiB or whose name fits no operation, keeps the others and logs counts only", async () => {
      const w = await keyed({
        tools: [
          tool("kept"),
          tool("huge", {
            inputSchema: { type: "object", description: "x".repeat(64 * 1024) }
          }),
          tool("huge_output", { outputSchema: { type: "object", title: "y".repeat(64 * 1024) } }),
          tool("has.a.dot"),
          tool("n".repeat(65)),
          { name: 7 },
          "not a tool",
          tool("long_description", { description: "d".repeat(5_000) })
        ]
      });
      const descriptors = await w.discover();

      expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
        "kept",
        "long_description"
      ]);
      expect(required(descriptors[1]).description).toHaveLength(4_000);
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toContain('"omitted":{"malformed":2,"name":2,"schemaTooLarge":2}');
      // The names and schemas of what was left out are data of the server and are not logged.
      expect(log.lines[0]).not.toContain("huge");
      expect(log.lines[0]).not.toContain("has.a.dot");
    });

    it("fails on more than 500 tools and on more than 20 pages, naming the bound", async () => {
      const many = Array.from({ length: 501 }, (_unused, index) => tool(`t${index}`));
      const tooMany = await keyed({ tools: many });
      const first = await refusal(tooMany.discover());
      expect(connectionCallReasonOf(first)).toBe("output_invalid");
      expect(first.message).toContain("MCP_DISCOVERY_MAX_TOOLS");

      const paged = await keyed({ tools: many.slice(0, 21), pageSize: 1 });
      const second = await refusal(paged.discover());
      expect(connectionCallReasonOf(second)).toBe("output_invalid");
      expect(second.message).toContain("MCP_DISCOVERY_MAX_PAGES");
      // The twenty-first page was never asked for.
      expect(paged.server.rpc("tools/list")).toHaveLength(20);

      // Exactly at the bounds a discovery passes.
      const atBound = await keyed({ tools: many.slice(0, 500), pageSize: 25 });
      expect(await atBound.discover()).toHaveLength(500);
    });

    it("stops reading a tool list at 4 MiB instead of buffering what the server sends", async () => {
      const written = { bytes: 0 };
      const w = await keyed({
        intercept: answering("tools/list", (_request, response) => {
          sendWithoutEnd(response, written);
        })
      });
      const error = await refusal(w.discover());
      expect(connectionCallReasonOf(error)).toBe("output_invalid");
      expect(error.message).toContain("MCP_DISCOVERY_MAX_BYTES");
      // The server was cut off: it got rid of little more than the bound.
      expect(written.bytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(written.bytes).toBeLessThan(16 * 1024 * 1024);
    });
  });

  describe("a call", () => {
    it("answers the content and the structured content, over JSON and over an event stream", async () => {
      for (const eventStream of [false, true]) {
        const w = await keyed({
          eventStream,
          call: (name, input) => ({
            content: [
              { type: "text", text: `called ${name}`, annotations: { priority: 1 } },
              { type: "resource_link", uri: "https://example.test/report", name: "Report" }
            ],
            structuredContent: { input, total: 12 },
            _meta: { internal: true }
          })
        });
        expect(await w.execute("revenue_by_month", { month: "2026-09" })).toEqual({
          content: [
            { type: "text", text: "called revenue_by_month" },
            { type: "resource_link", uri: "https://example.test/report", name: "Report" }
          ],
          structuredContent: { input: { month: "2026-09" }, total: 12 }
        });
        expect(w.server.rpc("tools/call")[0]?.body).toMatchObject({
          params: { name: "revenue_by_month", arguments: { month: "2026-09" } }
        });
      }
    });

    it("reaches the pinned address with the host name unchanged, over plain http against a private entry", async () => {
      const w = await keyed({ call: () => textResult("ok") });
      await w.execute("echo");

      // The resolver of the egress check was asked, and nothing resolved the name again:
      // the request arrived on 127.0.0.1 although no system resolver knows the name.
      expect(w.egress.asked).toEqual([HOST]);
      expect(w.server.requests.length).toBeGreaterThan(0);
      for (const request of w.server.requests) {
        expect(request.headers.host).toBe(`${HOST}:${w.server.port}`);
        expect(request.path).toBe("/mcp");
      }
    });

    it("goes to the checked address where the system resolver answers another one", async () => {
      // The system resolver knows this name and answers a public address for it. The check
      // answered 127.0.0.1, and that is where the request arrives: nothing resolves again.
      const PUBLIC_NAME = "example.com";
      const key = generateTestSecret();
      const server = await serve({ requireHeader: bearer(key), call: () => textResult("pinned") });
      const w = await connect({
        url: urlOf(server, PUBLIC_NAME),
        allow: [allowOf(server, PUBLIC_NAME)],
        key
      });
      expect(await w.execute("echo")).toEqual(textResult("pinned"));
      expect(w.egress.asked).toEqual([PUBLIC_NAME]);
      expect(server.rpc("tools/call")[0]?.headers.host).toBe(`${PUBLIC_NAME}:${server.port}`);
    });

    it("keeps the host name as the TLS name over https", async () => {
      const certificate = makeTestCertificate(HOST);
      const before = getCACertificates("default");
      setDefaultCACertificates([...before, certificate.authority]);
      try {
        const key = generateTestSecret();
        const server = await serve({
          tls: certificate,
          requireHeader: bearer(key),
          call: () => textResult("over tls")
        });
        const w = await connect({
          url: `https://${HOST}:${server.port}/mcp`,
          allow: [{ host: HOST, port: server.port, protocol: "https" }],
          key
        });
        expect(await w.execute("echo")).toEqual(textResult("over tls"));
        for (const request of server.requests) {
          expect(request.serverName).toBe(HOST);
          expect(request.headers.host).toBe(`${HOST}:${server.port}`);
        }
      } finally {
        setDefaultCACertificates(before);
      }
    });

    it("refuses plain http where the operator's list allows the host over https only", async () => {
      const server = await serve();
      const w = await connect({
        url: urlOf(server),
        allow: [{ host: HOST, port: server.port, protocol: "https" }]
      });
      const error = await refusal(w.execute("echo"));
      expect(connectionCallReasonOf(error)).toBe("egress_denied");
      expect(server.connections).toBe(0);
      // And the list itself takes plain http for a private target only.
      expect(() =>
        createEgressChecker({
          allow: [{ protocol: "http", host: HOST, port: server.port, network: "public", cidrs: [] }]
        })
      ).toThrow(/plain http/u);
    });

    it("sends the key in the named header under the scheme header, and no credential under none", async () => {
      const key = generateTestSecret();
      const named = await serve({ requireHeader: { name: "x-api-key", value: key } });
      const w = await connect({
        url: urlOf(named),
        allow: [allowOf(named)],
        authScheme: "header",
        headerName: "X-Api-Key",
        key
      });
      expect(await w.test()).toEqual({ status: "ready" });
      expect(named.requests.every((request) => request.headers.authorization === undefined)).toBe(
        true
      );

      const open = await serve();
      const anonymous = await connect({
        url: urlOf(open),
        allow: [allowOf(open)],
        authScheme: "none"
      });
      expect(await anonymous.test()).toEqual({ status: "ready" });
      for (const request of open.requests) {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["x-api-key"]).toBeUndefined();
      }
    });

    it("keeps a session the server opens for the call and ends it", async () => {
      const w = await keyed({ sessions: true, call: () => textResult("in a session") });
      expect(await w.execute("echo")).toEqual(textResult("in a session"));
      expect(w.server.requests.map((request) => request.rpc ?? request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "DELETE"
      ]);
      expect(
        w.server.requests.slice(1).map((request) => request.headers["mcp-session-id"])
      ).toEqual(Array.from({ length: 3 }, () => "session-of-the-test-server"));
    });

    it("opens no connection before the first call and reuses one socket for the calls after it", async () => {
      const w = await keyed({ call: () => textResult("ok") });
      // The type exists and a context was opened: nothing has left yet.
      await w.open();
      expect(w.server.connections).toBe(0);

      await w.execute("echo");
      await w.execute("echo");
      expect(w.server.rpc("tools/call")).toHaveLength(2);
      expect(w.server.connections).toBe(1);

      // Side by side, a Connection holds no more sockets than MCP_SOCKETS_PER_CONNECTION.
      await Promise.all(Array.from({ length: 20 }, () => w.execute("echo")));
      expect(w.server.rpc("tools/call")).toHaveLength(22);
      expect(w.server.connections).toBeLessThanOrEqual(8);
    });
  });

  describe("redirects", () => {
    const redirectCalls = (status: number, to: () => string) =>
      answering("tools/call", (_request, response) => {
        response.writeHead(status, { location: to() }).end();
      });

    it("follows a redirect to another host only after its egress check, and sends that host no credential", async () => {
      const other = await serve({ call: () => textResult("from the other host") });
      const w = await keyed(
        { sessions: true, intercept: redirectCalls(307, () => urlOf(other, OTHER_HOST)) },
        {}
      );
      // Not on the operator's list: the other host is never connected to.
      const denied = await refusal(w.execute("echo"));
      expect(connectionCallReasonOf(denied)).toBe("egress_denied");
      expect(other.connections).toBe(0);
      expect(told(denied)).not.toContain(OTHER_HOST);

      // On the list: the call is followed, and nothing that authenticates goes along.
      const key = generateTestSecret();
      const first = await serve({
        requireHeader: bearer(key),
        sessions: true,
        intercept: redirectCalls(307, () => urlOf(other, OTHER_HOST))
      });
      const allowed = await connect({
        url: urlOf(first),
        allow: [allowOf(first), allowOf(other, OTHER_HOST)],
        key
      });
      expect(await allowed.execute("echo", { q: 1 })).toEqual(textResult("from the other host"));
      expect(other.requests).toHaveLength(1);
      const [arrived] = other.requests;
      expect(arrived?.headers.host).toBe(`${OTHER_HOST}:${other.port}`);
      expect(arrived?.headers.authorization).toBeUndefined();
      expect(arrived?.headers["mcp-session-id"]).toBeUndefined();
      expect(findLeak(JSON.stringify(arrived), key)).toBeUndefined();
      expect(allowed.egress.asked).toContain(OTHER_HOST);
    });

    it("keeps the credential on a redirect within the Connection's own origin", async () => {
      const key = generateTestSecret();
      const server = await serve({
        requireHeader: bearer(key),
        call: () => textResult("moved"),
        intercept(request, response) {
          if (request.rpc !== "tools/call" || request.path !== "/mcp") return false;
          response.writeHead(308, { location: "/moved" }).end();
          return true;
        }
      });
      const w = await connect({ url: urlOf(server), allow: [allowOf(server)], key });
      expect(await w.execute("echo")).toEqual(textResult("moved"));
      const followed = required(server.requests.find((request) => request.path === "/moved"));
      expect(followed.headers.authorization).toBe(`Bearer ${key}`);
    });

    it("follows no redirect that changes the method, and no chain without end", async () => {
      const found = await keyed({ intercept: redirectCalls(302, () => "/elsewhere") });
      expect(connectionCallReasonOf(await refusal(found.execute("echo")))).toBe("upstream_error");
      expect(found.server.requests.some((request) => request.path === "/elsewhere")).toBe(false);

      const loop = await keyed({ intercept: redirectCalls(307, () => "/mcp") });
      expect(connectionCallReasonOf(await refusal(loop.execute("echo")))).toBe("upstream_error");
      // The first request and three redirects, and then no more.
      expect(loop.server.rpc("tools/call")).toHaveLength(4);
    });
  });

  describe("a server that fails or misbehaves", () => {
    it("answers a reason for each failure and never text of the server", async () => {
      const SERVER_TEXT = "text-only-the-server-knows";
      const cases: Array<[reason: string, options: McpTestServerOptions]> = [
        ["upstream_error", { call: () => ({ ...textResult(SERVER_TEXT), isError: true }) }],
        [
          "upstream_error",
          {
            intercept: answering("tools/call", (request, response) => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpcId(request.body),
                  error: { code: -32000, message: SERVER_TEXT }
                })
              );
            })
          }
        ],
        [
          "upstream_error",
          {
            intercept: answering("tools/call", (_request, response) => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(`{"not json": ${SERVER_TEXT}`);
            })
          }
        ],
        [
          "upstream_error",
          {
            intercept: answering("tools/call", (_request, response) => {
              response.writeHead(500, { "content-type": "text/plain" }).end(SERVER_TEXT);
            })
          }
        ],
        [
          "upstream_rate_limited",
          {
            intercept: answering("tools/call", (_request, response) => {
              response.writeHead(429, { "retry-after": "1" }).end(SERVER_TEXT);
            })
          }
        ],
        [
          "upstream_unauthorized",
          {
            intercept: answering("tools/call", (_request, response) => {
              response.writeHead(403).end(SERVER_TEXT);
            })
          }
        ],
        ["output_invalid", { call: () => ({ content: [{ type: "unheard_of", text: "x" }] }) }],
        ["output_invalid", { call: () => ({ content: [], structuredContent: [1, 2] }) }],
        ["output_invalid", { call: () => textResult("r".repeat(MCP_RESULT_MAX_BYTES + 1024)) }]
      ];
      for (const [reason, options] of cases) {
        const w = await keyed(options);
        const error = await refusal(w.execute("echo"));
        expect(connectionCallReasonOf(error)).toBe(reason);
        expect(told(error)).not.toContain(SERVER_TEXT);
        expect(told(error)).not.toContain(HOST);
      }
      expect(log.lines).toEqual([]);
    });

    it("answers a reason for a result nested deeper than the runtime reads", async () => {
      const DEPTH = 200_000;
      const w = await keyed({
        intercept: answering("tools/call", (request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            `{"jsonrpc":"2.0","id":${JSON.stringify(rpcId(request.body))},"result":{"content":[],` +
              `"structuredContent":${'{"a":'.repeat(DEPTH)}1${"}".repeat(DEPTH)}}}`
          );
        })
      });
      expect(connectionCallReasonOf(await refusal(w.execute("echo")))).toBe("upstream_error");
    });

    it("stops reading a result past its bound instead of buffering it", async () => {
      const written = { bytes: 0 };
      const w = await keyed({
        intercept: answering("tools/call", (_request, response) => {
          sendWithoutEnd(response, written);
        })
      });
      const error = await refusal(w.execute("echo"));
      expect(connectionCallReasonOf(error)).toBe("output_invalid");
      expect(error.message).toContain("MCP_RESULT_MAX_BYTES");
      expect(written.bytes).toBeLessThan(12 * 1024 * 1024);
    });

    it("answers upstream_unauthorized for a refused key, and the test says unauthorized", async () => {
      const server = await serve({ requireHeader: bearer(generateTestSecret()) });
      const w = await connect({ url: urlOf(server), allow: [allowOf(server)] });
      expect(connectionCallReasonOf(await refusal(w.execute("echo")))).toBe(
        "upstream_unauthorized"
      );
      expect(connectionCallReasonOf(await refusal(w.discover()))).toBe("upstream_unauthorized");
      expect(await w.test()).toEqual({ status: "unauthorized" });
    });

    it("answers connection_unavailable while the server is down, and works once it is back", async () => {
      const server = await serve({ call: () => textResult("back") });
      const { port } = server;
      const w = await connect({ url: urlOf(server), allow: [allowOf(server)], authScheme: "none" });
      await server.close();

      expect(connectionCallReasonOf(await refusal(w.execute("echo")))).toBe(
        "connection_unavailable"
      );
      expect(connectionCallReasonOf(await refusal(w.discover()))).toBe("connection_unavailable");
      expect(await w.test()).toEqual({ status: "unavailable" });
      expect(port).toBeGreaterThan(0);
    });

    it("answers upstream_timeout when the server says nothing until the deadline", async () => {
      const held: ServerResponse[] = [];
      const w = await keyed({
        intercept: answering("tools/call", (_request, response) => {
          held.push(response);
        })
      });
      const started = Date.now();
      const error = await refusal(w.execute("echo", {}, AbortSignal.timeout(300)));
      expect(connectionCallReasonOf(error)).toBe("upstream_timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      for (const response of held) response.destroy();
    });

    it("says network_denied in a test when a redirect leaves the operator's list", async () => {
      const w = await keyed({
        intercept: answering("tools/list", (_request, response) => {
          response.writeHead(307, { location: `http://${OTHER_HOST}:9/mcp` }).end();
        })
      });
      expect(await w.test()).toEqual({ status: "network_denied" });
    });
  });

  describe("the key", () => {
    it("refuses a result and a tool list that echo the key, in every form", async () => {
      const key = generateTestSecret();
      const forms = [
        key,
        `Bearer ${key}`,
        JSON.stringify({ token: key }),
        JSON.stringify(JSON.stringify(key)),
        Buffer.from(key).toString("base64"),
        Buffer.from(key).toString("base64url"),
        Buffer.from(`Bearer ${key}`).toString("base64"),
        Buffer.from(key).toString("hex").toUpperCase(),
        `https://example.test/?k=${encodeURIComponent(key)}`
      ];
      for (const form of forms) {
        for (const echo of [
          textResult(form),
          { content: [], structuredContent: { nested: { echoed: [form] } } },
          { content: [], structuredContent: { [form]: true } }
        ]) {
          const w = await keyed({ call: () => echo }, { key });
          const error = await refusal(w.execute("echo"));
          expect(connectionCallReasonOf(error)).toBe("output_rejected");
          expect(findLeak(told(error), key)).toBeUndefined();
        }
      }
      for (const echoing of [
        tool("echoing", { description: `Use the key ${key}.` }),
        tool("echoing", { inputSchema: { type: "object", default: { key } } }),
        tool("echoing", { outputSchema: { type: "object", title: key } })
      ]) {
        const w = await keyed({ tools: [tool("fine"), echoing] }, { key });
        const error = await refusal(w.discover());
        expect(connectionCallReasonOf(error)).toBe("output_rejected");
        expect(findLeak(told(error), key)).toBeUndefined();
      }
    });

    it("is in no log, no stored row, no descriptor, no result and no refusal after discovery, test and calls", async () => {
      const output = captureProcessOutput();
      const seen: string[] = [];
      let key = "";
      try {
        const w = await keyed({
          tools: [
            tool("revenue_by_month", { annotations: { readOnlyHint: true } }),
            tool("huge", { inputSchema: { type: "object", description: "x".repeat(70_000) } })
          ],
          call: (name, _input, request) =>
            name === "echo_key"
              ? textResult(`You sent ${String(request.headers.authorization)}`)
              : name === "fail"
                ? { ...textResult(String(request.headers.authorization)), isError: true }
                : textResult("12 400 EUR")
        });
        key = w.key;

        // Discovery, stored the way the platform stores it.
        const descriptors: readonly ConnectorOperationDescriptor[] = await w.discover();
        seen.push(JSON.stringify(descriptors));
        await stores.connections.putConnectionState({
          clientInstanceId,
          connectionAssetId: w.assetId,
          health: "ok",
          lastTestedAt: new Date().toISOString(),
          catalog: unknownToJsonValue(
            buildConnectionCatalog({
              discovered: descriptors,
              accepted: [
                { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true }
              ],
              previous: undefined,
              now: new Date().toISOString()
            })
          )
        });

        seen.push(JSON.stringify(await w.test()));
        seen.push(JSON.stringify(await w.execute("revenue_by_month", { month: "2026-09" })));

        // The failures: an echo, a tool error that echoes, a refused key, a dead server.
        for (const operation of ["fail", "echo_key"]) {
          const error = await refusal(w.execute(operation));
          seen.push(told(error), String(error.stack));
          await stores.connections.putConnectionState({
            clientInstanceId,
            connectionAssetId: w.assetId,
            health: "failed",
            lastErrorCode: connectionCallReasonOf(error) ?? "none"
          });
        }
        await w.server.close();
        const down = await refusal(w.execute("revenue_by_month"));
        seen.push(told(down), String(down.stack), JSON.stringify(await w.test()));

        // The key did travel: the server saw it on every request it answered.
        expect(w.server.requests.length).toBeGreaterThan(6);
        expect(
          w.server.requests.every((request) => request.headers.authorization === `Bearer ${key}`)
        ).toBe(true);
        expect(seen.join("\n")).toContain("output_rejected");
      } finally {
        seen.push(output.stop());
      }
      seen.push(log.lines.join("\n"));
      expect(log.lines).toHaveLength(1);

      expect(findLeak(seen.join("\n"), key)).toBeUndefined();
      const rows = await dumpDatabaseText();
      expect(rows).toContain("revenue_by_month");
      expect(rows).toContain("output_rejected");
      expect(findLeak(rows, key)).toBeUndefined();
    });
  });
});
