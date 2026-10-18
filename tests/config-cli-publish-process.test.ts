import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import platformContext from "./fixtures/cli-platform-context.json";

// The CLI's return value must reach the shell too. Exercise the built public bin, rather
// than only runCli(), against a disposable local HTTP fixture; no real instance is involved.
const bin = fileURLToPath(new URL("../packages/config-cli/dist/index.js", import.meta.url));
const at = "2026-10-18T00:00:00.000Z";
// Bound a stuck CLI fixture; the child is ours and receives SIGINT by its PID.
const CLI_PUBLISH_PROCESS_TIMEOUT_MS = 20_000;

async function publishing(status: "done" | "pending_confirmation" | "pending_approval") {
  let published = false;
  let unattended: string | string[] | undefined;
  const operation = apiOperations["assets.publish"];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === apiOperations["access_tokens.exchange"].path) {
      response.end(JSON.stringify({ accessToken: "fixture-access", expiresAt: at }));
    } else if (request.url === apiOperations["platform.context.get"].path) {
      response.end(
        JSON.stringify({
          ...platformContext,
          kinds: [
            {
              kind: "data_store",
              plural: "data_stores",
              lifecycle: "draft_published",
              representation: "files",
              owners: ["instance", "workspace"],
              actions: {
                read: "data_store.read",
                write: "data_store.write",
                delete: "data_store.delete",
                publish: "data_store.publish"
              }
            }
          ]
        })
      );
    } else if (
      request.method === operation.method &&
      request.url === operation.buildPath({ params: { kind: "data_store", name: "findings" } })
    ) {
      unattended = request.headers["catalyst-unattended"];
      published = status === "done";
      response.statusCode = published ? 200 : 202;
      response.end(
        JSON.stringify(
          published
            ? { draftRevision: 1, publishedRevision: 1 }
            : {
                id: "publish-1",
                operation: operation.id,
                effect: "changing",
                status,
                actor: { kind: "user", id: "fixture-user", label: "Fixture user" },
                origin: { kind: "cli", unattended: true },
                target: "live",
                inputHash: "hash",
                attempt: 1,
                correlationId: "fixture",
                createdAt: at,
                href: apiOperations["operations.get_run"].buildPath({
                  params: { runId: "publish-1" }
                })
              }
        )
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const child = spawn(
      process.execPath,
      [
        bin,
        "data-store",
        "publish",
        "findings",
        "--revision",
        "1",
        "--yes",
        "--json",
        "--instance",
        `http://127.0.0.1:${address.port}`
      ],
      {
        env: { ...process.env, CATALYST_API_KEY: "fixture-key" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CLI_PUBLISH_PROCESS_TIMEOUT_MS,
        killSignal: "SIGINT"
      }
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      output += text;
    });
    // Drain errors without reflecting credentials or unrelated environment details.
    child.stderr.resume();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      return { code, output, published, unattended };
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the public Data Store publish CLI process", () => {
  it.each(["pending_confirmation", "pending_approval"] as const)(
    "exits 3 while %s without publishing",
    async (status) => {
      const result = await publishing(status);
      expect(result).toMatchObject({ code: 3, published: false, unattended: "1" });
      expect(JSON.parse(result.output)).toMatchObject({
        status: "pending_approval",
        run: { status }
      });
    }
  );
  it("exits 0 only for the published revision", async () => {
    const result = await publishing("done");
    expect(result).toMatchObject({ code: 0, published: true, unattended: "1" });
    expect(JSON.parse(result.output)).toEqual({ draftRevision: 1, publishedRevision: 1 });
  });
});
