import { captureLogger } from "./registration";
import { CaptureSlots } from "./slots";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { CaptureRenderer } from "./renderer";
import { CAPTURE_MS, captureInputSchema, type CaptureOutcome } from "./protocol";

/** These are the only environment values consumed; prohibited credentials refuse startup. */
export function captureEnvironment(env: Record<string, string | undefined>) {
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value &&
        /DATABASE_URL|OBJECT.*(?:KEY|SECRET)|(?:AWS|S3|MODEL|OPENAI|ANTHROPIC).*KEY|(?:AUTH|SESSION|CONTENT).*SECRET|CONTENT_KEY/u.test(
          key
        )
    )
  )
    throw new Error("Capture environment contains another service's credentials");
  const token = env.PREVIEW_CAPTURE_SERVICE_TOKEN;
  const apiOrigin = new URL(env.PREVIEW_CAPTURE_API_ORIGIN ?? "http://api:4100");
  const interfaceOrigin = new URL(
    env.PREVIEW_CAPTURE_INTERFACE_ORIGIN ?? "http://interface.invalid"
  );
  const slots = Number(env.PREVIEW_CAPTURE_CONCURRENCY ?? 2);
  if (!token || token.length < 32 || !Number.isInteger(slots) || slots < 1)
    throw new Error("Invalid capture environment");
  for (const origin of [apiOrigin, interfaceOrigin])
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Capture origins must be origins");
  return { token, apiOrigin: apiOrigin.origin, interfaceOrigin: interfaceOrigin.origin, slots };
}
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
  const config = captureEnvironment(env);
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
