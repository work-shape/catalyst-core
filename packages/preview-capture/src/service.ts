import { captureLogger, captureEnvironment } from "./registration";
export { captureEnvironment } from "./registration";
import { CaptureSlots } from "./slots";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { CaptureRenderer } from "./renderer";
import { CAPTURE_MS, captureInputSchema, type CaptureOutcome } from "./protocol";

function authorized(request: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new Error("Too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function startCaptureService(env: Record<string, string | undefined>) {
  const config = await captureEnvironment(env);
  const renderer = new CaptureRenderer({
    ...config,
    hostScript: await readFile(new URL("./host.js", import.meta.url), "utf8")
  });
  const evidence = await renderer.verifySandbox();
  // Only process/namespace ids: never a token, address, page diagnostic or image.
  captureLogger.info({ event: "preview_capture_sandbox", ...evidence });
  const slots = new CaptureSlots(config.slots);
  async function capture(raw: unknown): Promise<CaptureOutcome> {
    const input = captureInputSchema.parse(raw);
    if (input.deadline <= Date.now() || input.deadline > Date.now() + CAPTURE_MS)
      return { status: "refused", code: "capture_failed" };
    return slots.run(input.deadline, () => renderer.capture(input));
  }
  const handle = async (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      response.end('{"ok":true}');
      return;
    }
    if (
      request.method !== "POST" ||
      request.url !== "/capture" ||
      !authorized(request, config.token)
    ) {
      response.writeHead(403);
      response.end('{"code":"not_available"}');
      return;
    }
    try {
      response.end(JSON.stringify(await capture(await body(request))));
    } catch {
      response.writeHead(400);
      response.end('{"code":"capture_failed"}');
    }
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      response.destroy();
    });
  });
  server.requestTimeout = 25_000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve) => {
    server.listen(Number(env.PORT ?? 4120), "0.0.0.0", resolve);
  });
  const close = async () => {
    server.close();
    await renderer.close();
  };
  process.once("SIGTERM", () => {
    close().catch(() => undefined);
  });
  process.once("SIGINT", () => {
    close().catch(() => undefined);
  });
  return { server, close };
}
