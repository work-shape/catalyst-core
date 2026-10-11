import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createSampleData, utcMonthAnchor } from "./data.js";
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

export function createSampleMcpServer(options: { key: string; anchor?: string; now?: Date }) {
  const key = z.string().min(MINIMUM_KEY_LENGTH).safeParse(options.key);
  if (!key.success) throw new SampleMcpKeyError();
  const digest = createHash("sha256").update(key.data).digest();
  const data = createSampleData(options.anchor ?? utcMonthAnchor(options.now ?? new Date()));
  const cleanups = new Set<Promise<void>>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split("?")[0];
    if (path === "/healthz" && request.method === "GET") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (path !== "/mcp") {
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
    const matches = timingSafeEqual(digest, suppliedDigest);
    if (token === undefined || !matches) {
      response.setHeader("WWW-Authenticate", "Bearer");
      json(response, 401, { error: "Unauthorized." });
      return;
    }
    const body = await readBody(request);
    if (response.destroyed) return;
    const mcp = new McpServer({ name: "demo-sample-mcp", version: "1.0.0" });
    registerSampleTools(mcp, data);
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
