import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli, type CliRuntimeOptions } from "@work-shape/catalyst-cli";
import { createTestFetch, type TestInstance } from "./support/test-instance";
import { errorSchema } from "./support/access-instance";
import { setupPersonalKeyInstance } from "./support/personal-api-keys";
import { world, runJobs } from "./support/connection-discovery-world";
import { generateTestSecret } from "./support/test-connector";

const directories: string[] = [];
const instances: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function directory() {
  const cwd = await mkdtemp(join(tmpdir(), "cli-parity-"));
  directories.push(cwd);
  return cwd;
}

async function run(args: string[], options: CliRuntimeOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args, "--instance", "https://catalyst.test"], {
    cwd: await directory(),
    env: { CATALYST_API_KEY: "test-cli-key" },
    stdin: Readable.from([]),
    ...options,
    stdout: (text) => out.push(text),
    stderr: (text) => {
      err.push(text);
      options.stderr?.(text);
    }
  });
  return { code, out: out.join(""), err: err.join("") };
}

function apiFetch(answer: (request: Request) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === apiOperations["access_tokens.exchange"].path) {
      return Response.json({
        accessToken: "test-access-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    return answer(request);
  };
}

function connectionDetail(version?: number) {
  return {
    name: "outside",
    health: "ok",
    secret: version === undefined ? { state: "not_set" } : { state: "set", version },
    sharedCredential: true,
    operations: [],
    discovered: [],
    usedBy: []
  };
}

describe("catalog CLI commands", () => {
  it("reads file and stdin client input, sends a write with idempotency, and prints its JSON output", async () => {
    const cwd = await directory();
    const input = {
      params: { kind: "agent", name: "new-agent" },
      body: { config: {}, expectedRevision: null }
    };
    await writeFile(join(cwd, "input.json"), JSON.stringify(input));
    const received: Request[] = [];
    const fetchImpl = apiFetch((request) => {
      received.push(request);
      return Response.json({ version: 1, revision: 1, warnings: [] });
    });
    for (const from of [["--from", "input.json"], ["--from", "-"], []]) {
      const result = await run(["call", "assets.put", ...from], {
        cwd,
        fetchImpl,
        stdin: Readable.from([JSON.stringify(input)])
      });
      expect(result, result.err).toEqual({
        code: 0,
        out: '{\n  "version": 1,\n  "revision": 1,\n  "warnings": []\n}\n',
        err: ""
      });
    }
    expect(received).toHaveLength(3);
    for (const request of received) {
      expect(new URL(request.url).pathname).toBe(
        apiOperations["assets.put"].buildPath({ params: input.params })
      );
      expect(request.headers.get("authorization")).toBe("Bearer test-access-token");
      expect(request.headers.get("idempotency-key")).toBeTruthy();
      expect(await request.json()).toEqual(input.body);
    }
  });

  it("returns 3 and the held run as JSON, without claiming the change ran", async () => {
    const pending = {
      id: "run-1",
      operation: "assets.publish",
      effect: "changing",
      status: "pending_approval",
      actor: { kind: "user", id: "kai", label: "Kai" },
      origin: { kind: "cli" },
      target: "live",
      inputHash: "hash",
      attempt: 1,
      correlationId: "correlation",
      createdAt: new Date().toISOString(),
      href: apiOperations["operations.get_run"].buildPath({ params: { runId: "run-1" } })
    };
    const result = await run(["call", "assets.publish"], {
      stdin: Readable.from([
        JSON.stringify({ params: { kind: "app", name: "offers" }, body: { revision: 1 } })
      ]),
      fetchImpl: apiFetch(() => Response.json(pending, { status: 202 }))
    });
    expect(result.code, result.err).toBe(3);
    expect(JSON.parse(result.out)).toMatchObject({ status: "pending_approval", run: pending });
  });

  it("rejects unknown operations and malformed input before any request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect((await run(["call", "missing.operation"], { fetchImpl })).code).toBe(2);
    expect(
      (await run(["call", "assets.list"], { fetchImpl, stdin: Readable.from(["invalid json"]) }))
        .code
    ).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("handles catalog binary responses, stream refusals and multipart inputs through the client", async () => {
    const binary = await run(["call", "view_runtime.files.get"], {
      stdin: Readable.from([JSON.stringify({ params: { version: "v1", file: "runtime.js" } })]),
      fetchImpl: apiFetch(
        () => new Response("asset-bytes", { headers: { "content-type": "application/javascript" } })
      )
    });
    expect(binary.code, binary.err).toBe(0);
    expect(JSON.parse(binary.out)).toEqual({
      contentType: "application/javascript",
      base64: Buffer.from("asset-bytes").toString("base64")
    });
    const forbidden = () =>
      Response.json(
        { error: { code: "FORBIDDEN", message: "Missing the required scope" } },
        { status: 403 }
      );
    const stream = await run(["call", "conversations.runs.observe"], {
      stdin: Readable.from([
        JSON.stringify({ params: { conversationId: "conversation", runId: "run" } })
      ]),
      fetchImpl: apiFetch(forbidden)
    });
    expect(stream).toEqual({
      code: 1,
      out: "",
      err: "Refused by the instance (HTTP 403 FORBIDDEN): Missing the required scope\n"
    });
    const cwd = await directory();
    await writeFile(join(cwd, "upload.txt"), "upload bytes");
    const uploads: (FormDataEntryValue | null)[] = [];
    const upload = await run(["call", "conversations.draft_attachments.upload"], {
      cwd,
      stdin: Readable.from([
        JSON.stringify({ params: { conversationId: "conversation" }, file: "upload.txt" })
      ]),
      fetchImpl: apiFetch(async (request) => {
        uploads.push((await request.formData()).get("file"));
        return forbidden();
      })
    });
    expect(upload.code, upload.err).toBe(1);
    // The API refusal follows the same client route even for a multipart call.
    const uploaded = uploads[0];
    expect(uploaded).toBeInstanceOf(File);
    if (!(uploaded instanceof File)) throw new Error("Expected uploaded file");
    expect(uploaded.name).toBe("upload.txt");
    expect(await uploaded.text()).toBe("upload bytes");
  });

  it("routes connection test, discover and tools directly to their operations", async () => {
    const requests: string[] = [];
    const fetchImpl = apiFetch((request) => {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      return Response.json(
        path.endsWith("/test")
          ? { status: "ready", testedAt: new Date().toISOString() }
          : path.endsWith("/discover")
            ? { status: "queued" }
            : { connections: [] }
      );
    });
    for (const args of [
      ["connection", "test", "outside"],
      ["connection", "discover", "outside"],
      ["connection", "tools"]
    ]) {
      const result = await run(args, { fetchImpl });
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out)).toBeDefined();
    }
    expect(requests).toEqual([
      "POST /api/v1/connections/outside/test",
      "POST /api/v1/connections/outside/discover",
      "GET /api/v1/connection-tools"
    ]);
  });
});

describe("write-only CLI secret input", () => {
  it("sends stdin unchanged except its final line ending, using the current version, and prints only state", async () => {
    const secret = generateTestSecret();
    let body: unknown;
    const fetchImpl = apiFetch(async (request) => {
      if (request.method === "GET") return Response.json(connectionDetail(7));
      body = await request.json();
      return Response.json({ state: "set", version: 8 });
    });
    const result = await run(["connection", "secret", "set", "outside"], {
      fetchImpl,
      stdin: Readable.from([` ${secret} \r\n`])
    });
    expect(body).toEqual({ value: ` ${secret} `, expectedVersion: 7 });
    expect(result).toEqual({ code: 0, out: '{\n  "state": "set",\n  "version": 8\n}\n', err: "" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reuses the secret write idempotency key after a dropped connection", async () => {
    const secret = generateTestSecret();
    const keys: (string | null)[] = [];
    const fetchImpl = apiFetch((request) => {
      if (request.method === "GET") return Response.json(connectionDetail());
      keys.push(request.headers.get("idempotency-key"));
      if (keys.length === 1) throw new TypeError("The test connection dropped");
      return Response.json({ state: "set", version: 1 });
    });
    const result = await run(["connection", "secret", "set", "outside"], {
      fetchImpl,
      sleep: async () => {},
      stdin: Readable.from([secret])
    });
    expect(result.code, result.err).toBe(0);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(result.out + result.err).not.toContain(secret);
  });

  it.each(["CONFLICT", "REVISION_CONFLICT"])("keeps other 409s as refusals (%s)", async (code) => {
    let reads = 0;
    const result = await run(["connection", "secret", "set", "outside"], {
      stdin: Readable.from([generateTestSecret()]),
      fetchImpl: apiFetch((request) => {
        if (request.method === "GET") {
          reads += 1;
          return Response.json(connectionDetail());
        }
        return Response.json({ error: { code, message: "Write refused" } }, { status: 409 });
      })
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain(`HTTP 409 ${code}`);
    expect(reads).toBe(1);
  });

  it("keeps OUTPUT_NOT_RETAINED as a refusal for generic calls", async () => {
    const result = await run(["call", "connections.set_secret"], {
      stdin: Readable.from([
        JSON.stringify({
          params: { name: "outside" },
          body: { value: generateTestSecret(), expectedVersion: null }
        })
      ]),
      fetchImpl: apiFetch(() =>
        Response.json(
          { error: { code: "OUTPUT_NOT_RETAINED", message: "Already carried out" } },
          { status: 409 }
        )
      )
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("HTTP 409 OUTPUT_NOT_RETAINED");
  });

  it("refuses secret arguments and flags without echoing them or contacting the server", async () => {
    const secret = generateTestSecret();
    const fetchImpl = vi.fn<typeof fetch>();
    for (const extra of [[secret], ["--value", secret], ["--secret", secret], ["--from", secret]]) {
      const result = await run(["connection", "secret", "set", "outside", ...extra], { fetchImpl });
      expect(result.code).toBe(2);
      expect(result.out + result.err).not.toContain(secret);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts a reflected secret from API errors on both the named command and call", async () => {
    const secret = generateTestSecret();
    const fetchImpl = apiFetch((request) =>
      request.method === "GET"
        ? Response.json(connectionDetail())
        : Response.json(
            {
              error: {
                code: "CONFLICT",
                message: `Reflected ${secret}`,
                details: { issues: [{ message: secret }] }
              }
            },
            { status: 409 }
          )
    );
    const named = await run(["connection", "secret", "set", "outside"], {
      fetchImpl,
      stdin: Readable.from([secret])
    });
    const generic = await run(["call", "connections.set_secret"], {
      fetchImpl,
      stdin: Readable.from([
        JSON.stringify({
          params: { name: "outside" },
          body: { value: secret, expectedVersion: null }
        })
      ])
    });
    for (const result of [named, generic]) {
      expect(result.code).toBe(1);
      expect(result.err).toContain("HTTP 409 CONFLICT");
      expect(result.out + result.err).not.toContain(secret);
    }
  });

  it.each([false, true])(
    "hides terminal entry and restores terminal state (cancel=%s)",
    async (cancel) => {
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode: vi.fn()
      });
      expect(input.isPaused()).toBe(false);
      const pause = vi.spyOn(input, "pause");
      const secret = generateTestSecret();
      let body: unknown;
      const result = await run(["connection", "secret", "set", "outside"], {
        stdin: input,
        fetchImpl: apiFetch(async (request) => {
          if (request.method === "GET") return Response.json(connectionDetail());
          body = await request.json();
          return Response.json({ state: "set", version: 1 });
        }),
        stderr: (text) => {
          if (text !== "Secret (hidden): ") return;
          input.emit("keypress", secret, { name: "paste" });
          input.emit(
            "keypress",
            undefined,
            cancel ? { ctrl: true, name: "c" } : { name: "return" }
          );
        }
      });
      expect(result.code).toBe(cancel ? 1 : 0);
      expect(result.err).toBe(
        cancel ? "Secret (hidden): \nSecret entry cancelled.\n" : "Secret (hidden): \n"
      );
      expect(result.out + result.err).not.toContain(secret);
      expect(body).toEqual(cancel ? undefined : { value: secret, expectedVersion: null });
      expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
      expect(input.listenerCount("keypress")).toBe(0);
      expect(input.isPaused()).toBe(true);
      expect(pause).toHaveBeenCalled();
    }
  );
});

describe("CLI parity against persisted operations", () => {
  it("stores the stdin secret in the real Secret Store without echoing it", async () => {
    const w = world();
    const instance = await w.start();
    instances.push(instance);
    const name = "made-here";
    const made = await instance.call("assets.put", {
      params: { kind: "connection", name },
      payload: {
        config: {
          name,
          displayName: "Made here",
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
    const secret = generateTestSecret();
    const result = await run(["connection", "secret", "set", name], {
      stdin: Readable.from([`${secret}\n`]),
      // This fixture uses development auth; the exchange above returns a synthetic token.
      // The separate personal-key test below exercises the real bearer authentication path.
      fetchImpl: apiFetch((request) => {
        request.headers.delete("authorization");
        return createTestFetch(instance)(request);
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ state: "set", version: 1 });
    expect(result.out + result.err).not.toContain(secret);
    // Discovery resolves the encrypted value from the real store, not from the CLI response.
    await runJobs(instance);
    expect(w.connector.handed).toContain(secret);
  });

  it("reads secret state after the server commits and its answer is lost", async () => {
    const w = world();
    const instance = await w.start();
    instances.push(instance);
    const name = "retry-secret";
    const made = await instance.call("assets.put", {
      params: { kind: "connection", name },
      payload: {
        config: {
          name,
          displayName: "Retry secret",
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
    const secret = generateTestSecret();
    const forward = createTestFetch(instance);
    const statuses: number[] = [];
    const keys: (string | null)[] = [];
    let reads = 0;
    const result = await run(["connection", "secret", "set", name], {
      stdin: Readable.from([secret]),
      sleep: async () => {},
      fetchImpl: apiFetch(async (request) => {
        request.headers.delete("authorization");
        const response = await forward(request);
        if (request.method === "GET") reads += 1;
        if (request.method === "PUT") {
          statuses.push(response.status);
          keys.push(request.headers.get("idempotency-key"));
          if (statuses.length === 1) {
            // The real server has completed the transaction and produced its successful reply.
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ state: "set", version: 1 });
            throw new TypeError("The reply was lost after the server committed");
          }
          expect(response.status).toBe(409);
          expect(errorSchema.parse(await response.clone().json()).error.code).toBe(
            "OUTPUT_NOT_RETAINED"
          );
        }
        return response;
      })
    });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ state: "set", version: 1 });
    expect(result.err).toBe("");
    expect(result.out).not.toContain(secret);
    expect(statuses).toEqual([200, 409]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(reads).toBe(2);
    // Discovery reads the actual encrypted value; version 1 also proves no second write ran.
    await runJobs(instance);
    expect(w.connector.handed).toContain(secret);
  });

  it("lets the server refuse a real personal key and shows the same error as the API", async () => {
    const t = await setupPersonalKeyInstance();
    instances.push(t.instance);
    await t.grant(t.kai.id, "agent.read", { workspaceId: t.kaiTeam });
    const issued = await t.issue([`agent.read:${t.kaiTeam}`]);
    const headers = await t.tokenFor(issued.secret);
    const direct = await t.instance.call("me.update", {
      headers,
      payload: { displayLabel: "Changed" }
    });
    expect(direct.statusCode).toBe(403);
    const error = errorSchema.parse(direct.json());
    const result = await run(["call", "me.update"], {
      env: { CATALYST_API_KEY: issued.secret },
      fetchImpl: createTestFetch(t.instance),
      stdin: Readable.from([JSON.stringify({ body: { displayLabel: "Changed" } })])
    });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(error).toMatchObject({ error: { code: "FORBIDDEN" } });
    // Compare the exact API refusal, including the scope message.
    expect(result.err).toContain(
      `Refused by the instance (HTTP 403 FORBIDDEN): ${error.error.message}`
    );
  });
});
