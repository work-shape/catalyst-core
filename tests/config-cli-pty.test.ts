import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { createTestFetch, type TestInstance } from "./support/test-instance";
import { world, runJobs } from "./support/connection-discovery-world";
import { generateTestSecret } from "./support/test-connector";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = fileURLToPath(new URL("../packages/config-cli/dist/index.js", import.meta.url));
const driver = fileURLToPath(new URL("./support/cli-secret-pty.py", import.meta.url));
const instances: TestInstance[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  // Build the shipped entrypoint rather than importing runCli into this test's process.
  await execute("pnpm", ["--filter", "@work-shape/catalyst-cli", "build"], {
    cwd: root,
    timeout: 90_000
  });
}, 100_000);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

/** The child uses real HTTP; the fixture uses development auth and a synthetic exchange. */
async function listen(instance: TestInstance): Promise<string> {
  const forward = createTestFetch(instance);
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === apiOperations["access_tokens.exchange"].path) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            accessToken: "pty-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          })
        );
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && name !== "authorization") headers.set(name, value);
      }
      const answer = await forward(
        new Request(url, {
          method: request.method,
          headers,
          ...(body === "" ? {} : { body })
        })
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      response.writeHead(500);
      response.end("Test HTTP bridge failed");
    }
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test HTTP port");
  return `http://127.0.0.1:${address.port}`;
}

const flagsSchema = z.object({ ECHO: z.boolean(), ICANON: z.boolean(), ISIG: z.boolean() });
const resultSchema = z.object({
  prompted: z.boolean(),
  hung: z.boolean(),
  code: z.number().nullable(),
  before: flagsSchema,
  during: flagsSchema,
  after: flagsSchema,
  output: z.string()
});

describe("built CLI with a real terminal", () => {
  it.each([false, true])(
    "exits after hidden secret entry and restores the terminal (cancel=%s)",
    async (cancel) => {
      const w = world();
      const instance = await w.start();
      instances.push(instance);
      const name = "tty-secret";
      const made = await instance.call("assets.put", {
        params: { kind: "connection", name },
        payload: {
          config: {
            name,
            displayName: "TTY",
            connectorType: "discovering",
            settings: { url: "https://93.184.216.34/mcp" },
            authScheme: "bearer",
            enabled: true,
            operations: []
          },
          expectedRevision: null
        }
      });
      expect(made.statusCode, made.body).toBe(200);
      const url = await listen(instance);
      const secret = generateTestSecret();
      const child = execFile("python3", [driver], { timeout: 20_000 });
      const answer = new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout?.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve(output) : reject(new Error(`PTY driver exit ${code}`))
        );
      });
      child.stdin?.end(JSON.stringify({ node: process.execPath, cli, url, name, secret, cancel }));
      const result = resultSchema.parse(JSON.parse(await answer));
      expect(result.prompted).toBe(true);
      expect(result.hung).toBe(false);
      expect(result.code).toBe(cancel ? 1 : 0);
      expect(result.output).not.toContain(secret);
      expect(result.during.ECHO).toBe(false);
      expect(result.after).toEqual(result.before);
      if (cancel) {
        expect(result.output).toContain("Secret entry cancelled.");
        expect(w.connector.handed).not.toContain(secret);
      } else {
        expect(result.output).toContain('"state": "set"');
        await runJobs(instance);
        expect(w.connector.handed).toContain(secret);
      }
    }
  );
});
