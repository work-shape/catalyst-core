import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  MCP_CALL_TIMEOUT_MS,
  JSON_SCHEMA_MAX_DEPTH,
  MCP_CONNECTOR_TYPE,
  compileJsonSchema,
  createMcpConnectorType,
  openConnectorContext
} from "@vivd-catalyst/connections";
import {
  connectionCallReasonOf,
  type ConnectorContext,
  type JsonObject
} from "@vivd-catalyst/core";
import {
  MCP_CLEANUP_TIMEOUT_MS,
  MCP_TRANSPORT_HEADER_NAMES,
  createMcpSocketPool
} from "../packages/connections/src/mcp/client";
import { connection } from "./support/connections";
import {
  answering,
  loopbackEgress,
  startMcpTestServer,
  textResult,
  tool,
  type McpTestServer,
  type McpTestServerOptions
} from "./support/mcp-test-server";

// What a slow, broken or hostile MCP server cannot do to the process that calls it. The
// Connections here hold no key, so nothing is stored: the type is called with a context the
// real egress checker opened.

const HOST = "mcp.example.test";
const OTHER_HOST = "other.example.test";
/** Well under the time of a call: what ended this early was not ended by the call's deadline. */
const SOON_MS = MCP_CLEANUP_TIMEOUT_MS + 3_000;

describe("the Connector type mcp against a server that holds on", () => {
  const servers: McpTestServer[] = [];
  const type = createMcpConnectorType();

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve(options: McpTestServerOptions = {}): Promise<McpTestServer> {
    const server = await startMcpTestServer(options);
    servers.push(server);
    return server;
  }

  async function connect(options: McpTestServerOptions, others: McpTestServer[] = []) {
    const server = await serve(options);
    const egress = loopbackEgress([
      { host: HOST, port: server.port },
      ...others.map((other) => ({ host: OTHER_HOST, port: other.port }))
    ]);
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
      open,
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

  describe("the sockets of a process", () => {
    it("closes the socket of a request a redirect sent to another origin with that request", async () => {
      const other = await serve({ call: () => textResult("from the other") });
      const w = await connect(
        {
          intercept: answering("tools/call", (_request, response) => {
            response
              .writeHead(307, { location: `http://${OTHER_HOST}:${other.port}/mcp` })
              .end();
          })
        },
        [other]
      );
      expect(await w.execute("echo")).toEqual(textResult("from the other"));
      expect(other.connections).toBe(1);
      await expect.poll(() => other.open).toBe(0);
      // The Connection's own server keeps its one socket for the next call.
      expect(w.server.open).toBe(1);
    });

    it("destroys the agent that makes room in a full pool, and never one that serves a request", async () => {
      const held: { end(): void }[] = [];
      const server = await serve({ intercept: () => true });
      const grant = await loopbackEgress([{ host: HOST, port: server.port }]).checker.check({
        protocol: "http",
        host: HOST,
        port: server.port
      });
      /** A request on the agent that the server reads and never answers. */
      const hold = async (agent: NonNullable<ReturnType<typeof pool.agentFor>>) => {
        const arrived = server.requests.length;
        const request = httpRequest({ host: "127.0.0.1", port: server.port, agent });
        request.on("error", () => undefined);
        request.end();
        held.push({ end: () => request.destroy() });
        await expect.poll(() => server.requests.length).toBe(arrived + 1);
      };
      const pool = createMcpSocketPool(2);
      const agentOf = (connectionId: string, address = grant.address) => {
        const agent = pool.agentFor(connectionId, { ...grant, address });
        if (agent === undefined) throw new Error("The pool has no room");
        return { agent, destroyed: vi.spyOn(agent, "destroy") };
      };

      const first = agentOf("first");
      const second = agentOf("second");
      expect(agentOf("first").agent).toBe(first.agent);
      await hold(first.agent);

      // Full: the one that serves nothing leaves, though the other was used longer ago.
      expect(agentOf("second").agent).toBe(second.agent);
      const third = agentOf("third");
      expect(second.destroyed).toHaveBeenCalledTimes(1);
      expect(first.destroyed).not.toHaveBeenCalled();

      // Every kept agent serves a request: nothing is destroyed and nothing more is kept.
      await hold(third.agent);
      expect(pool.agentFor("fourth", grant)).toBeUndefined();
      // Another address of the same server is another agent, under the same ceiling.
      expect(pool.agentFor("first", { ...grant, address: "127.0.0.2" })).toBeUndefined();
      expect(first.destroyed).not.toHaveBeenCalled();
      expect(third.destroyed).not.toHaveBeenCalled();

      for (const request of held) request.end();
      await expect.poll(() => Object.keys(first.agent.sockets).length).toBe(0);
      const moved = agentOf("first", "127.0.0.2");
      expect(moved.agent).not.toBe(first.agent);
      expect(first.destroyed).toHaveBeenCalledTimes(1);
      moved.agent.destroy();
      third.agent.destroy();
    });
  });

  describe("the header of the key", () => {
    const settings = (headerName: string) =>
      type.settingsSchema.safeParse({ url: `https://${HOST}/mcp`, headerName });

    it("refuses at the settings every header the transport writes itself, in any case", () => {
      for (const name of MCP_TRANSPORT_HEADER_NAMES) {
        expect(settings(name).success, name).toBe(false);
        expect(settings(name.toUpperCase()).success, name).toBe(false);
      }
      for (const name of ["Host", "Content-Length", "Transfer-Encoding", "Connection"]) {
        expect(settings(name).success, name).toBe(false);
      }
      for (const name of ["Mcp-Session-Id", "MCP-Protocol-Version", "Upgrade", "TE"]) {
        expect(settings(name).success, name).toBe(false);
      }
      expect(settings("X-Api-Key").success).toBe(true);
      expect(settings("Authorization").success).toBe(true);
    });

    it("sends no request where a credential names such a header all the same", async () => {
      const w = await connect({ call: () => textResult("done") });
      const context = await w.open(new AbortController().signal);
      const work = type.execute(
        "echo",
        {},
        {
          ...context,
          credentialFor: () => ({
            scheme: "header",
            secret: "a-name-and-no-key",
            headers: { Host: "a-name-and-no-key" }
          })
        }
      );
      const reason = await work.then(
        () => undefined,
        (error: unknown) => connectionCallReasonOf(error)
      );
      expect(reason).toBe("connection_not_configured");
      expect(w.server.requests).toHaveLength(0);
    });
  });

  describe("a schema the server lists", () => {
    /** A schema whose properties nest `depth` schemas inside one another. */
    const nested = (depth: number): JsonObject => {
      let schema: JsonObject = { type: "string" };
      for (let level = 0; level < depth; level += 1) {
        schema = { type: "object", properties: { inner: schema } };
      }
      return schema;
    };

    it("leaves out the one tool whose schema is too deep or holds too many nodes, and keeps the others", async () => {
      const w = await connect({
        tools: [
          tool("first"),
          // Under the bound in bytes, and far deeper than a schema is compiled.
          tool("deep_input", { inputSchema: nested(1_000) }),
          tool("deep_output", { outputSchema: nested(1_000) }),
          // Within the depth on its own, and over it inside the schema of a result.
          tool("deep_as_result", { outputSchema: nested(JSON_SCHEMA_MAX_DEPTH / 2 - 1) }),
          tool("wide", {
            inputSchema: { type: "object", enum: Array.from({ length: 21_000 }, () => 1) }
          }),
          tool("last", { outputSchema: nested(4) })
        ]
      });
      const descriptors = await w.discover();
      expect(descriptors.map((descriptor) => descriptor.name)).toEqual(["first", "last"]);
      for (const descriptor of descriptors) {
        expect(compileJsonSchema(descriptor.inputSchema).ok).toBe(true);
        if (descriptor.outputSchema !== undefined) {
          expect(compileJsonSchema(descriptor.outputSchema).ok).toBe(true);
        }
      }
    });
  });
});
