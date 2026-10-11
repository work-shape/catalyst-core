import { afterEach, describe, expect, it } from "vitest";
import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECTOR_TYPE,
  createMcpConnectorType,
  openConnectorContext
} from "@vivd-catalyst/connections";
import { type ConnectorContext, type JsonObject } from "@vivd-catalyst/core";
import { MCP_CLEANUP_TIMEOUT_MS } from "../packages/connections/src/mcp/client";
import { connection } from "./support/connections";
import {
  answering,
  loopbackEgress,
  startMcpTestServer,
  textResult,
  type McpTestServer,
  type McpTestServerOptions
} from "./support/mcp-test-server";

// What a slow, broken or hostile MCP server cannot do to the process that calls it. The
// Connections here hold no key, so nothing is stored: the type is called with a context the
// real egress checker opened.

const HOST = "mcp.example.test";
/** Well under the time of a call: what ended this early was not ended by the call's deadline. */
const SOON_MS = MCP_CLEANUP_TIMEOUT_MS + 3_000;

describe("the Connector type mcp against a server that holds on", () => {
  const servers: McpTestServer[] = [];
  const type = createMcpConnectorType();

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function connect(options: McpTestServerOptions) {
    const server = await startMcpTestServer(options);
    servers.push(server);
    const egress = loopbackEgress([{ host: HOST, port: server.port }]);
    const config = connectionConfigSchema.parse(
      connection(`held-${server.port}`, {
        connectorType: MCP_CONNECTOR_TYPE,
        settings: { url: `http://${HOST}:${server.port}/mcp` },
        authScheme: "none",
        secretHandle: undefined
      })
    );
    const open = (signal: AbortSignal): Promise<ConnectorContext> =>
      openConnectorContext({
        type,
        connection: { id: `asset-${server.port}`, revision: 1, config },
        egress: egress.checker,
        credentials: {
          resolve: () => Promise.reject(new Error("A Connection without a key resolves none"))
        },
        signal
      });
    return {
      server,
      execute: async (
        operation: string,
        input: JsonObject = {},
        signal: AbortSignal = new AbortController().signal
      ) => type.execute(operation, input, await open(signal)),
      discover: async () => {
        if (type.discover === undefined) throw new Error("The type discovers nothing");
        return type.discover(await open(new AbortController().signal));
      }
    };
  }

  /** How long `work` took, with what it answered. */
  async function timed<Result>(work: Promise<Result>): Promise<{ result: Result; ms: number }> {
    const start = Date.now();
    const result = await work;
    return { result, ms: Date.now() - start };
  }

  describe("the end of a session", () => {
    it("does not wait for a server that never answers the end of the session", async () => {
      expect(SOON_MS).toBeLessThan(MCP_CALL_TIMEOUT_MS);
      const w = await connect({
        sessions: true,
        call: () => textResult("done"),
        // The request is read and never answered.
        intercept: (request) => request.method === "DELETE"
      });

      const first = await timed(w.execute("echo"));
      expect(first.result).toEqual(textResult("done"));
      expect(first.ms).toBeLessThan(SOON_MS);
      expect(w.server.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);

      // The socket the silent server held is gone, and the next call is served all the same.
      const second = await timed(w.execute("echo"));
      expect(second.result).toEqual(textResult("done"));
      expect(second.ms).toBeLessThan(SOON_MS);
    });

    it("lets go of the session's end at once when the caller's signal ends the call", async () => {
      const w = await connect({
        sessions: true,
        call: () => textResult("done"),
        intercept: (request) => request.method === "DELETE"
      });
      const caller = new AbortController();
      const call = w.execute("echo", {}, caller.signal);
      await expect
        .poll(() => w.server.requests.some((request) => request.method === "DELETE"))
        .toBe(true);

      const start = Date.now();
      caller.abort();
      expect(await call).toEqual(textResult("done"));
      expect(Date.now() - start).toBeLessThan(MCP_CLEANUP_TIMEOUT_MS / 2);
    });

    it("does not wait for an answer nobody reads that never ends", async () => {
      const w = await connect({
        call: () => textResult("done"),
        // The notification is accepted with a body that begins and never ends.
        intercept: answering("notifications/initialized", (_request, response) => {
          response.writeHead(202, { "content-type": "text/plain" });
          response.write("wait");
        })
      });
      const { result, ms } = await timed(w.execute("echo"));
      expect(result).toEqual(textResult("done"));
      expect(ms).toBeLessThan(SOON_MS);
    });
  });
});
