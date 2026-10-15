import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { z } from "zod";
import { createEgressChecker, type EgressAllowEntry } from "@work-shape/catalyst-connections";
import { AppError, type JsonObject, type Logger } from "@work-shape/catalyst-core";

// An MCP server over Streamable HTTP, in this process, for the tests of the `mcp` Connector
// type. It is written by hand and shares no code with the client it tests: it speaks the
// protocol's messages over plain `node:http`. A test can make it misbehave in every way an
// outside server could: refuse, redirect, echo, send without end, or say nothing.

/** One request as the server received it. */
export interface McpTestRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON-RPC method of a POST, where the body named one. */
  rpc?: string;
  /** The body of a POST as it was parsed. */
  body?: unknown;
  /** The name the client asked for in the TLS handshake, on an `https` server. */
  serverName?: string;
}

export interface McpTestServerOptions {
  /** The tools as `tools/list` sends them. Anything is allowed: the client must cope. */
  tools?: readonly unknown[];
  /** How many tools one page of `tools/list` holds. One page unless given. */
  pageSize?: number;
  /** A header every request must carry with exactly this value. 401 otherwise. */
  requireHeader?: { name: string; value: string };
  /** Answer requests as an event stream instead of one JSON document. */
  eventStream?: boolean;
  /** Hand out a session id at the handshake and demand it afterwards. */
  sessions?: boolean;
  tls?: { key: string; certificate: string };
  /** The result of `tools/call`, as the protocol's result object. */
  call?(name: string, input: unknown, request: McpTestRequest): unknown;
  /**
   * Answers a request itself, before the protocol is spoken. Returns whether it did. For a
   * server that misbehaves.
   */
  intercept?(request: McpTestRequest, response: ServerResponse): boolean;
}

export interface McpTestServer {
  readonly port: number;
  /** Every request in the order it arrived. */
  readonly requests: McpTestRequest[];
  /** How many TCP connections were opened to the server. */
  readonly connections: number;
  /** How many of them are open now. */
  readonly open: number;
  /** The requests of one JSON-RPC method. */
  rpc(method: string): McpTestRequest[];
  close(): Promise<void>;
}

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional()
});

const SESSION_ID = "session-of-the-test-server";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

export async function startMcpTestServer(
  options: McpTestServerOptions = {}
): Promise<McpTestServer> {
  const requests: McpTestRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  const send = (response: ServerResponse, id: unknown, body: Record<string, unknown>): void => {
    const message = JSON.stringify({ jsonrpc: "2.0", id, ...body });
    if (options.eventStream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${message}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(message);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const recorded: McpTestRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers
    };
    if (request.socket instanceof TLSSocket) {
      const { servername } = request.socket;
      if (typeof servername === "string") recorded.serverName = servername;
    }
    const text = await readBody(request);
    const rpc = rpcSchema.safeParse(text === "" ? {} : JSON.parse(text));
    if (text !== "") recorded.body = JSON.parse(text);
    if (rpc.success && rpc.data.method !== undefined) recorded.rpc = rpc.data.method;
    requests.push(recorded);

    if (options.intercept?.(recorded, response) === true) return;
    const required = options.requireHeader;
    if (required && request.headers[required.name.toLowerCase()] !== required.value) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized." }));
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST" || !rpc.success) {
      response.writeHead(405).end();
      return;
    }
    const { id, method, params } = rpc.data;
    if (method === "initialize") {
      if (options.sessions === true) response.setHeader("mcp-session-id", SESSION_ID);
      send(response, id, {
        result: {
          protocolVersion: params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-test-server", version: "1" }
        }
      });
      return;
    }
    if (options.sessions === true && request.headers["mcp-session-id"] !== SESSION_ID) {
      response.writeHead(404).end();
      return;
    }
    if (method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (method === "tools/list") {
      const tools = options.tools ?? [];
      const size = options.pageSize ?? Math.max(tools.length, 1);
      const start = Number(params?.cursor ?? 0);
      const next = start + size;
      send(response, id, {
        result: {
          tools: tools.slice(start, next),
          ...(next < tools.length ? { nextCursor: String(next) } : {})
        }
      });
      return;
    }
    if (method === "tools/call") {
      const name = typeof params?.name === "string" ? params.name : "";
      send(response, id, {
        result: options.call?.(name, params?.arguments, recorded) ?? { content: [] }
      });
      return;
    }
    send(response, id, { error: { code: -32601, message: "Method not found" } });
  };

  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
  const server: Server = options.tls
    ? createHttpsServer({ key: options.tls.key, cert: options.tls.certificate }, listener)
    : createHttpServer(listener);
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The MCP test server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    requests,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    rpc: (method) => requests.filter((request) => request.rpc === method),
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

/** An `intercept` that answers every request of one JSON-RPC method itself. */
export function answering(
  rpc: string,
  answer: (request: McpTestRequest, response: ServerResponse) => void
): NonNullable<McpTestServerOptions["intercept"]> {
  return (request, response) => {
    if (request.rpc !== rpc) return false;
    answer(request, response);
    return true;
  };
}

/** The id of a JSON-RPC request, for an answer a test writes by hand. */
export function rpcId(body: unknown): unknown {
  return typeof body === "object" && body !== null && "id" in body ? body.id : null;
}

/** Writes into an answer until the client lets go of it, and counts what it wrote. */
export function sendWithoutEnd(response: ServerResponse, written: { bytes: number }): void {
  const chunk = Buffer.alloc(64 * 1024, "a");
  response.writeHead(200, { "content-type": "application/json" });
  const more = () => {
    while (!response.destroyed) {
      written.bytes += chunk.byteLength;
      if (!response.write(chunk)) {
        response.once("drain", more);
        return;
      }
    }
  };
  more();
}

/** A tool as a server lists one. */
export const tool = (name: string, further: JsonObject = {}): JsonObject => ({
  name,
  description: `The tool ${name}.`,
  inputSchema: { type: "object", properties: { month: { type: "string" } } },
  ...further
});

/** The result of a tool call that holds one text. */
export const textResult = (text: string): JsonObject => ({ content: [{ type: "text", text }] });

export type AllowedTestTarget = { host: string; port: number; protocol?: "http" | "https" };

/**
 * The operator's list of a test: each entry a private target on loopback, and a resolver
 * that answers 127.0.0.1 for every name. Nothing else is allowed.
 */
export function loopbackEgress(entries: AllowedTestTarget[]) {
  const asked: string[] = [];
  const allow: EgressAllowEntry[] = entries.map((entry) => ({
    protocol: entry.protocol ?? "http",
    host: entry.host,
    port: entry.port,
    network: "private",
    cidrs: ["127.0.0.0/8"]
  }));
  const checker = createEgressChecker({
    allow,
    resolve(host) {
      asked.push(host);
      return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    }
  });
  return { checker, asked };
}

/** A logger that keeps every line it was handed, as text. */
export function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const write = (input: unknown, message?: string) => lines.push(JSON.stringify([input, message]));
  const logger: Logger = {
    debug: write,
    info: write,
    warn: write,
    error: write,
    child: () => logger
  };
  return { logger, lines };
}

/** The refusal a call ended with. Anything but an `AppError` fails the test. */
export async function refusal(work: Promise<unknown>): Promise<AppError> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught
  );
  if (!(error instanceof AppError)) throw new Error("Expected a refusal with a reason");
  return error;
}

/** Everything a refusal could tell anybody: its message, its details and its code. */
export const told = (error: AppError) => JSON.stringify([error.message, error.details, error.code]);
