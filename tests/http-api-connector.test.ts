import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  HTTP_API_CONNECTOR_TYPE,
  HTTP_API_RESULT_MAX_BYTES,
  connectionOriginOf,
  createConnectionCredentialResolver,
  createHttpApiConnectorType,
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
  createConnectorTypeRegistry,
  findConnectorTypeIssues,
  type ConnectionOperationConfig,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { required } from "./support/assertions";
import { connection } from "./support/connections";
import { loopbackEgress, refusal, told } from "./support/mcp-test-server";
import {
  json,
  startRestTestServer,
  status,
  type RestHandler,
  type RestTestServer
} from "./support/rest-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./support/test-connector";
import { createTestInstance, type TestPostgresStore } from "./support/test-instance";

// The Connector type `http_api` against a REST interface in this process, through the real
// egress checker (with a resolver of the test), the real Secret Store over real rows and
// `openConnectorContext`. Every test fails without the type: nothing else speaks REST.

const clientInstanceId = asClientInstanceId("http-api-connector-test");
/** The name the Connection is configured with. The test's resolver answers 127.0.0.1 for it. */
const HOST = "rest.example.test";
const INSTANCE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/** The declared operations of the tests, as a person pastes them. */
const operations: JsonValue[] = [
  {
    name: "list_clients",
    effect: "reading",
    exposure: ["workflow"],
    enabled: true,
    method: "GET",
    path: "/clients",
    description: "Lists the Mandanten with their number.",
    query: { top: { schema: { type: "integer", minimum: 1 } } }
  },
  {
    name: "open_items",
    effect: "reading",
    exposure: ["workflow"],
    enabled: true,
    method: "GET",
    path: "/clients/{clientId}/open-items",
    description: "Reads the open items of one Mandant.",
    pathParams: { clientId: { schema: { type: "string" } } },
    query: {
      fiscalYear: { schema: { type: "integer" }, required: true },
      settled: { schema: { type: "boolean" } }
    }
  }
];

describe("the Connector type http_api", () => {
  let stores: TestPostgresStore;
  let type: ConnectorTypeDefinition;
  const servers: RestTestServer[] = [];
  let connected = 0;
  const storeKey = generateSecretStoreKey();

  beforeEach(async () => {
    stores = (await createTestInstance({ postgres: {} })).stores;
    type = createHttpApiConnectorType();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  interface Setup {
    authScheme?: "none" | "bearer" | "header";
    settings?: JsonObject;
    key?: string;
    path?: string;
    operations?: JsonValue[];
  }

  /** A server, and a Connection to it whose key is in the Secret Store. */
  async function connect(handler: RestHandler, setup: Setup = {}) {
    const server = await startRestTestServer(handler);
    servers.push(server);
    connected += 1;
    const name = `rest-${connected}`;
    const key = setup.key ?? generateTestSecret();
    const authScheme = setup.authScheme ?? "bearer";
    const handle = authScheme === "none" ? undefined : createConnectionSecretHandle();
    await applyAtCurrentRevisions(stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "connection",
          name,
          config: connection(name, {
            connectorType: HTTP_API_CONNECTOR_TYPE,
            settings: {
              baseUrl: `http://${HOST}:${server.port}${setup.path ?? "/datevconnect"}`,
              headers: { "x-client-instance-id": INSTANCE_ID },
              ...setup.settings
            },
            authScheme,
            secretHandle: handle,
            operations: setup.operations ?? operations
          })
        }
      ]
    });
    const stored = required(
      await stores.configAssets.getConfigAsset({ clientInstanceId, kind: "connection", name })
    );
    const config = connectionConfigSchema.parse(stored.config);
    const keyring = await loadSecretKeyring({
      keys: [{ id: "k1", ref: "STORE_KEY" }],
      secrets: { resolve: () => Promise.resolve(storeKey) }
    });
    if (handle !== undefined) {
      await createSecretStore({ clientInstanceId, keyring, store: stores.connections }).put({
        binding: { connectionAssetId: stored.id, subject: SHARED_CREDENTIAL_SUBJECT },
        value: key,
        source: "runtime",
        handle,
        origin: connectionOriginOf(type, config)
      });
    }
    const egress = loopbackEgress([{ host: HOST, port: server.port }]);
    const open = () =>
      openConnectorContext({
        type,
        connection: { id: stored.id, revision: stored.revision, config },
        egress: egress.checker,
        credentials: createConnectionCredentialResolver({
          clientInstanceId,
          keyring,
          store: stores.connections
        }),
        signal: new AbortController().signal
      });
    return {
      server,
      key,
      test: async () => type.test(await open()),
      execute: async (operation: string, input: JsonValue) =>
        type.execute(operation, input, await open())
    };
  }

  const reasonOf = async (work: Promise<unknown>) => connectionCallReasonOf(await refusal(work));

  describe("a call", () => {
    it("sends the declared path, encoded, the declared query, the fixed header and the bearer, and nothing else", async () => {
      const w = await connect(json({ number: 10001, items: [] }));
      const result = await w.execute("open_items", {
        clientId: "a b&c?d",
        fiscalYear: 2026,
        settled: false
      });

      expect(result).toEqual({ number: 10001, items: [] });
      expect(w.server.requests).toHaveLength(1);
      const [sent] = w.server.requests;
      expect(sent?.method).toBe("GET");
      const url = new URL(required(sent).url, "http://any");
      expect(url.pathname).toBe("/datevconnect/clients/a%20b%26c%3Fd/open-items");
      expect([...url.searchParams].sort()).toEqual([
        ["fiscalYear", "2026"],
        ["settled", "false"]
      ]);
      expect(sent?.headers).toEqual({
        host: `${HOST}:${w.server.port}`,
        accept: "application/json",
        authorization: `Bearer ${w.key}`,
        "x-client-instance-id": INSTANCE_ID,
        connection: "close"
      });
    });

    it("answers a JSON list as { items }, and sends no query value the input leaves out", async () => {
      const w = await connect(json([{ number: 10001 }, { number: 10002 }]));
      expect(await w.execute("list_clients", null)).toEqual({
        items: [{ number: 10001 }, { number: 10002 }]
      });
      expect(await w.execute("list_clients", { top: 5 })).toMatchObject({ items: [{}, {}] });
      expect(w.server.requests.map((request) => request.url)).toEqual([
        "/datevconnect/clients",
        "/datevconnect/clients?top=5"
      ]);
    });

    it("sends the key in the named header under the scheme header, and no key under none", async () => {
      const keyed = await connect(json({}), {
        authScheme: "header",
        settings: { headerName: "X-Gateway-Key" }
      });
      await keyed.execute("list_clients", {});
      expect(keyed.server.requests[0]?.headers["x-gateway-key"]).toBe(keyed.key);
      expect(keyed.server.requests[0]?.headers.authorization).toBeUndefined();

      const open = await connect(json({}), { authScheme: "none" });
      await open.execute("list_clients", {});
      expect(Object.keys(required(open.server.requests[0]).headers).sort()).toEqual([
        "accept",
        "connection",
        "host",
        "x-client-instance-id"
      ]);
    });

    it("refuses a path parameter with '/', '.' or '..', an undeclared parameter or an address, and contacts nothing", async () => {
      const w = await connect(json({}));
      const refused: JsonObject[] = [
        { clientId: "10001/../../admin", fiscalYear: 2026 },
        { clientId: "..", fiscalYear: 2026 },
        // A URL drops a '.' segment: the call would reach /clients/open-items.
        { clientId: ".", fiscalYear: 2026 },
        { clientId: "", fiscalYear: 2026 },
        { clientId: "https://elsewhere.example/x", fiscalYear: 2026 },
        { clientId: "10001", fiscalYear: 2026, host: "elsewhere.example" },
        { clientId: "10001", fiscalYear: 2026, authorization: "Bearer other" },
        { clientId: "10001", fiscalYear: { $gt: 1 } }
      ];
      for (const input of refused) {
        expect(await reasonOf(w.execute("open_items", input))).toBe("input_invalid");
      }
      expect(await reasonOf(w.execute("delete_everything", {}))).toBe("operation_unknown");
      expect(w.server.requests).toEqual([]);
    });

    it("sends a path parameter with dots or an encoded dot as a segment of its own, under the declared path", async () => {
      const w = await connect(json({}));
      for (const clientId of ["%2e%2e", ".%2E", "a..b", ".hidden", "..."]) {
        await w.execute("open_items", { clientId, fiscalYear: 2026 });
      }
      expect(
        w.server.requests.map((request) => new URL(request.url, "http://any").pathname)
      ).toEqual([
        "/datevconnect/clients/%252e%252e/open-items",
        "/datevconnect/clients/.%252E/open-items",
        "/datevconnect/clients/a..b/open-items",
        "/datevconnect/clients/.hidden/open-items",
        "/datevconnect/clients/.../open-items"
      ]);
    });

    it("refuses a declared path with a dot segment stored before the save refused it, and contacts nothing", async () => {
      const paths = [
        "/clients/%2e%2e/admin",
        "/clients/.%2E/admin",
        "/clients/%2E/admin",
        "/../admin"
      ];
      const w = await connect(json({}), {
        operations: paths.map((path, index) => ({
          name: `climb_${index}`,
          effect: "reading",
          exposure: ["workflow"],
          enabled: true,
          method: "GET",
          path,
          description: "Climbs out of the base path."
        }))
      });
      for (const [index] of paths.entries()) {
        expect(await reasonOf(w.execute(`climb_${index}`, null))).toBe("input_invalid");
      }
      expect(w.server.requests).toEqual([]);
    });

    it("follows no redirect and reads no body of a refusal", async () => {
      const w = await connect(status(302, { location: `http://elsewhere.example.test/steal` }));
      expect(await reasonOf(w.execute("list_clients", {}))).toBe("upstream_error");
      expect(w.server.requests).toHaveLength(1);

      const cases: [number, string][] = [
        [401, "upstream_unauthorized"],
        [403, "upstream_unauthorized"],
        [404, "upstream_error"],
        [409, "upstream_conflict"],
        [429, "upstream_rate_limited"],
        [503, "connection_unavailable"]
      ];
      for (const [code, reason] of cases) {
        w.server.answer(json({ echoed: w.key }, code));
        const error = await refusal(w.execute("list_clients", {}));
        expect(connectionCallReasonOf(error)).toBe(reason);
        expect(told(error)).not.toContain(w.key);
      }
    });

    it("fails an answer over the byte cap or not JSON as output_invalid, and one that holds the key as output_rejected", async () => {
      const w = await connect((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`"${"x".repeat(HTTP_API_RESULT_MAX_BYTES)}"`);
      });
      expect(await reasonOf(w.execute("list_clients", {}))).toBe("output_invalid");

      w.server.answer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>sign in</html>");
      });
      expect(await reasonOf(w.execute("list_clients", {}))).toBe("output_invalid");
      w.server.answer(json("just a string"));
      expect(await reasonOf(w.execute("list_clients", {}))).toBe("output_invalid");

      w.server.answer(json([{ note: `token ${w.key}` }]));
      const rejected = await refusal(w.execute("list_clients", {}));
      expect(connectionCallReasonOf(rejected)).toBe("output_rejected");
      expect(told(rejected)).not.toContain(w.key);
    });
  });

  describe("a test", () => {
    it("asks the test path and keeps nothing of the answer: 2xx is ready, else unavailable", async () => {
      const w = await connect(json({ status: "healthy", key: "sample document" }), {
        settings: { testPath: "/health" }
      });
      expect(await w.test()).toEqual({ status: "ready" });
      expect(w.server.requests.map((request) => request.url)).toEqual(["/datevconnect/health"]);
      expect(w.server.requests[0]?.headers.authorization).toBe(`Bearer ${w.key}`);

      w.server.answer(status(404));
      expect(await w.test()).toEqual({ status: "unavailable" });
      w.server.answer(status(401));
      expect(await w.test()).toEqual({ status: "unauthorized" });
    });

    it("without a test path asks the base address: 401 or 403 is key refused, any other answer reachable", async () => {
      const w = await connect(status(401));
      expect(await w.test()).toEqual({ status: "unauthorized" });
      w.server.answer(status(403));
      expect(await w.test()).toEqual({ status: "unauthorized" });
      for (const code of [200, 404, 500]) {
        w.server.answer(status(code));
        expect(await w.test()).toEqual({ status: "ready" });
      }
      expect(new Set(w.server.requests.map((request) => request.url))).toEqual(
        new Set(["/datevconnect"])
      );
    });

    it("is unavailable when nothing answers", async () => {
      const w = await connect(status(200));
      await w.server.close();
      expect(await w.test()).toEqual({ status: "unavailable" });
    });
  });

  describe("the settings", () => {
    const read = (settings: JsonObject) => type.settingsSchema.safeParse(settings);
    const base = { baseUrl: "https://api.example.test/datevconnect" };

    it("refuse a fixed header that can carry a credential with credential_in_settings, and accept x-client-instance-id", () => {
      for (const name of [
        "Authorization",
        "Proxy-Authorization",
        "Cookie",
        "X-Api-Key",
        "x-auth-token",
        "Client-Secret",
        "X-Session",
        "X-Password",
        "AUTH"
      ]) {
        const parsed = read({ ...base, headers: { [name]: "value" } });
        expect(parsed.success, name).toBe(false);
        expect(JSON.stringify(parsed), name).toContain("credential_in_settings");
      }
      expect(read({ ...base, headers: { "x-client-instance-id": INSTANCE_ID } }).success).toBe(
        true
      );
    });

    it("refuse an address with a user, a query or another scheme, a transport header and a test path with a dot segment", () => {
      for (const baseUrl of [
        "https://user:pass@api.example.test",
        "https://api.example.test/?key=1",
        "ftp://api.example.test",
        "api.example.test"
      ]) {
        expect(read({ baseUrl }).success, baseUrl).toBe(false);
      }
      expect(read({ ...base, headers: { Host: "elsewhere.example" } }).success).toBe(false);
      expect(read({ ...base, headers: { "x-a": "1\r\nX-Injected: 2" } }).success).toBe(false);
      expect(read({ ...base, headerName: "Host" }).success).toBe(false);
      for (const testPath of ["/../admin", "/%2e%2e/admin", "/.%2E/admin", "/%2E/health"]) {
        expect(read({ ...base, testPath }).success, testPath).toBe(false);
      }
      expect(read({ ...base, testPath: "/health?full=1" }).success).toBe(false);
      expect(read({ ...base, testPath: "/health", headerName: "X-Gateway-Key" }).success).toBe(
        true
      );
    });
  });

  describe("the declarations", () => {
    const issuesOf = (connectorType: string, operation: Partial<ConnectionOperationConfig>) =>
      findConnectorTypeIssues(createConnectorTypeRegistry([type, createMcpConnectorType()]), {
        connectorType,
        settings:
          connectorType === "mcp"
            ? { url: "https://mcp.example.test/mcp" }
            : { baseUrl: "https://api.example.test" },
        authScheme: "bearer",
        operations: [
          {
            name: "read",
            effect: "reading",
            exposure: [],
            enabled: true,
            method: "GET",
            path: "/things/{id}",
            description: "Reads one thing.",
            pathParams: { id: { schema: { type: "string" } } },
            ...operation
          }
        ]
      }).map((issue) => `${issue.path?.join(".")}: ${issue.message}`);

    it("accept a GET that reads, and refuse another method, the effect changing and a path that does not fit its parameters", () => {
      expect(issuesOf("http_api", {})).toEqual([]);
      expect(issuesOf("http_api", { method: "DELETE" })).toEqual([
        "operations.0.method: This first cut of http_api reads only: the method is GET, not 'DELETE'"
      ]);
      expect(issuesOf("http_api", { effect: "changing" })).toEqual([
        "operations.0.effect: This first cut of http_api reads only: the effect is 'reading'"
      ]);
      expect(issuesOf("http_api", { path: "/things" }).join()).toContain("has no {id} in the path");
      expect(issuesOf("http_api", { path: "/things/{other}" }).join()).toContain(
        "'pathParams' does not declare"
      );
      // A URL reads %2e in any case as a dot, so each of these leaves the base path or drops a segment.
      for (const path of [
        "/things/../{id}",
        "/things/./{id}",
        "/things/%2e%2e/{id}",
        "/things/.%2E/{id}",
        "/things/%2E./{id}",
        "/things/%2e/{id}"
      ]) {
        expect(issuesOf("http_api", { path }).join(), path).toContain("'..'");
      }
      expect(issuesOf("http_api", { path: "/things/a..b/%252e%252e/{id}" })).toEqual([]);
      expect(issuesOf("http_api", { path: "https://elsewhere.example/{id}" }).join()).toContain(
        "starts with '/'"
      );
      expect(
        issuesOf("http_api", { pathParams: { id: { schema: { type: "object" } } } }).join()
      ).toContain("names its 'type'");
    });

    it("reserve scope until SCOPE-2, and refuse every declared field on a type that reads its operations from the outside system", () => {
      expect(
        issuesOf("http_api", { scope: { mandant: { input: "id", output: "items[].number" } } })
      ).toEqual([expect.stringMatching(/^operations\.0\.scope: .*SCOPE-2/u)]);
      expect(issuesOf("mcp", {})).toEqual([
        "operations.0.description: Connector type 'mcp' reads its operations from the outside system, so an operation declares no 'description'",
        "operations.0.method: Connector type 'mcp' reads its operations from the outside system, so an operation declares no 'method'",
        "operations.0.path: Connector type 'mcp' reads its operations from the outside system, so an operation declares no 'path'",
        "operations.0.pathParams: Connector type 'mcp' reads its operations from the outside system, so an operation declares no 'pathParams'"
      ]);
    });
  });
});
