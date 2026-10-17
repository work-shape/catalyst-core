import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createAccountingSample } from "./accounting/sample.js";
import { registerAccountingTools } from "./accounting/tools.js";
import { createSampleData, utcMonthAnchor } from "./data.js";
import { createSampleOAuth, type SampleOAuthMode, type SampleOAuthOptions } from "./oauth.js";
import { registerSampleTools } from "./tools.js";

export const SAMPLE_MCP_PORT = 8787;
export const MINIMUM_KEY_LENGTH = 32;
export const MAXIMUM_BODY_BYTES = 1024 * 1024;
export const SAMPLE_MCP_KEY_NAME = "DEMO_SAMPLE_MCP_KEY";

/** The key is unset or too short. The message names the variable and never the value. */
export class SampleMcpKeyError extends Error {
  constructor() {
    super(`${SAMPLE_MCP_KEY_NAME} must contain at least ${MINIMUM_KEY_LENGTH} characters.`);
    this.name = "SampleMcpKeyError";
  }
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function cleanup() {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function onError() {
      cleanup();
      reject(new BodyError(400, "The request body could not be read."));
    }
    function onAborted() {
      onError();
    }
    function onData(chunk: unknown) {
      if (!Buffer.isBuffer(chunk)) {
        onError();
        return;
      }
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) {
        cleanup();
        request.resume();
        reject(new BodyError(413, "The request body is too large."));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      cleanup();
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(body);
      } catch {
        reject(new BodyError(400, "The request body must be valid JSON."));
      }
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

/** What a request names: the JSON-RPC method and, for a tool call, the tool. */
const namedRequestSchema = z.object({
  method: z.string().regex(/^[a-z][a-z/_]{0,63}$/u),
  // A name of another shape is left out of the line, and the method is still logged.
  params: z
    .object({
      name: z
        .string()
        .regex(/^[a-z][a-z_]{0,63}$/u)
        .optional()
        .catch(undefined)
    })
    .optional()
    .catch(undefined)
});

/** What is logged of a request to an endpoint: its answer and what it named, never a header or an argument. */
function requestLine(path: string, status: number, body?: unknown): string {
  const named = namedRequestSchema.safeParse(body);
  const what = named.success ? [named.data.method, named.data.params?.name] : [];
  return [`POST ${path}`, status, ...what].filter((part) => part !== undefined).join(" ");
}

export function createSampleMcpServer(options: {
  key: string;
  anchor?: string;
  now?: Date;
  /** The seed of the accounting sample. Left out, it is the one fixed seed of the server. */
  accountingSeed?: number;
  /** The last month the accounting sample has bookings for, as `YYYY-MM`. Left out, it is the sample's own. */
  accountingLastMonth?: string;
  /** Receives one line per request to an endpoint, so the developer sees who calls. */
  log?: (line: string) => void;
  /**
   * Serves the sample tools a second time behind an OAuth sign-in, at `/dcr/mcp` and
   * `/registered/mcp`, with the authorization server in front of them (`oauth.ts`).
   */
  oauth?: SampleOAuthOptions;
}) {
  const key = z.string().min(MINIMUM_KEY_LENGTH).safeParse(options.key);
  if (!key.success) throw new SampleMcpKeyError();
  const digest = createHash("sha256").update(key.data).digest();
  const data = createSampleData(options.anchor ?? utcMonthAnchor(options.now ?? new Date()));
  const accounting = createAccountingSample({
    seed: options.accountingSeed,
    lastMonth: options.accountingLastMonth
  });
  // Each endpoint stands for one outside system, and a Connection is one MCP address. The key
  // guards them, except the two that the authorization server of `oauth` guards.
  const oauth = options.oauth && createSampleOAuth(options.oauth, options.log);
  interface Endpoint {
    name: string;
    register(mcp: McpServer): void;
    /** The mode of the sign-in that guards it. Without one, the key does. */
    signIn?: SampleOAuthMode;
  }
  const signedIn = (mode: SampleOAuthMode): [string, Endpoint] => [
    `/${mode}/mcp`,
    {
      name: `demo-sample-mcp-${mode}`,
      register: (mcp) => registerSampleTools(mcp, data),
      signIn: mode
    }
  ];
  const endpoints = new Map<string, Endpoint>([
    ["/mcp", { name: "demo-sample-mcp", register: (mcp) => registerSampleTools(mcp, data) }],
    [
      "/accounting/mcp",
      {
        name: "demo-sample-accounting-mcp",
        register: (mcp) => registerAccountingTools(mcp, accounting)
      }
    ],
    ...(oauth ? [signedIn("dcr"), signedIn("registered")] : [])
  ]);
  const cleanups = new Set<Promise<void>>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split("?")[0] ?? "";
    if (path === "/healthz" && request.method === "GET") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (oauth && (await oauth.handle(request, response, path))) return;
    const endpoint = endpoints.get(path);
    if (endpoint === undefined) {
      json(response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      json(response, 405, { error: "Use POST." });
      return;
    }
    const token = /^Bearer ([^\s]+)$/u.exec(request.headers.authorization ?? "")?.[1];
    const suppliedDigest = createHash("sha256")
      .update(token ?? "")
      .digest();
    const matches =
      endpoint.signIn === undefined
        ? timingSafeEqual(digest, suppliedDigest)
        : oauth?.accepts(endpoint.signIn, token) === true;
    if (token === undefined || !matches) {
      response.setHeader(
        "WWW-Authenticate",
        endpoint.signIn === undefined || !oauth ? "Bearer" : oauth.challengeOf(endpoint.signIn)
      );
      options.log?.(requestLine(path, 401));
      json(response, 401, { error: "Unauthorized." });
      return;
    }
    const body = await readBody(request);
    response.once("finish", () => options.log?.(requestLine(path, response.statusCode, body)));
    if (response.destroyed) return;
    const mcp = new McpServer({ name: endpoint.name, version: "1.0.0" });
    endpoint.register(mcp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    response.once("close", () => {
      const cleanup = Promise.allSettled([mcp.close(), transport.close()]).then(() => undefined);
      cleanups.add(cleanup);
      cleanup.then(() => cleanups.delete(cleanup)).catch(() => cleanups.delete(cleanup));
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  const http = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, error instanceof BodyError ? error.status : 500, {
        error: error instanceof BodyError ? error.message : "The request could not be handled."
      });
    });
  });
  return {
    /** The authorization server in front of the signed-in endpoints, where `oauth` is set. */
    oauth,
    listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          const address = http.address();
          if (address === null || typeof address === "string") {
            reject(new Error("The sample server has no TCP address."));
            return;
          }
          resolve({ port: address.port });
        });
      });
    },
    async close(): Promise<void> {
      if (http.listening)
        await new Promise<void>((resolve, reject) => {
          http.close((error) => (error ? reject(error) : resolve()));
        });
      await Promise.all(cleanups);
    }
  };
}
