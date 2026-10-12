import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH_MOUNT_PATH } from "@vivd-catalyst/api-client";
import { runLocalKeyCli } from "@vivd-catalyst/client-assembly";
import { afterEach, describe, expect, it } from "vitest";
import { testOperations } from "./support/operations";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

// `catalyst-local-key` does for a local development instance what an operator does by
// hand under Administration, API Access. The browser runner creates its key with the same code
// against a running instance; these tests hold the rules around it.

const localSecret = "cat_test_local-secret-never-print-this";
const appConfig = resolve("tests/fixtures/e2e-app.yaml");
const principal = {
  id: "sp_local",
  clientInstanceId: "demo-e2e",
  displayLabel: "Local config CLI",
  name: "local-config-cli",
  status: "active",
  permissionRefs: [],
  permissions: ["config_assets.read", "config_assets.release"],
  createdAt: "2026-10-09T10:00:00Z",
  updatedAt: "2026-10-09T10:00:00Z"
};

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function localJson(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

/** An instance that knows the seeded superadmin and, when told so, an earlier CLI principal. */
function localInstance(options: { existingPrincipal: boolean }) {
  const requests: Recorded[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const text = await request.text();
    requests.push({
      method: request.method,
      path,
      headers: request.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined
    });
    if (path === `${AUTH_MOUNT_PATH}/sign-in/email`) {
      return localJson(200, {}, { "set-cookie": "session=signed-in; Path=/; HttpOnly" });
    }
    if (request.headers.get("cookie") !== "session=signed-in") {
      return localJson(401, {
        error: { code: "UNAUTHENTICATED", message: "", correlationId: "r" }
      });
    }
    if (request.method === "GET" && path === testOperations["service_principals.list"].path) {
      return localJson(200, {
        items: options.existingPrincipal ? [{ principal, credentials: [] }] : []
      });
    }
    if (path === testOperations["service_principals.create"].path) {
      return localJson(200, { principal, credentials: [] });
    }
    return localJson(200, {
      credential: {
        id: "cred_local",
        clientInstanceId: "demo-e2e",
        servicePrincipalId: principal.id,
        name: "local development",
        keyPrefix: "cat_test_local",
        scopes: ["config_assets:read", "config_assets:release"],
        createdAt: "2026-10-09T10:00:00Z"
      },
      secret: localSecret
    });
  };
  return { requests, fetchImpl };
}

describe("catalyst-local-key", () => {
  async function workingCopy(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "catalyst-local-key-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  async function run(
    cwd: string,
    instanceUrl: string,
    fetchImpl: typeof fetch,
    extra: string[] = []
  ) {
    const output: string[] = [];
    const code = await runLocalKeyCli(
      ["--instance", instanceUrl, "--config", appConfig, ...extra],
      {
        cwd,
        fetchImpl,
        env: {},
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text)
      }
    );
    return { code, output: output.join("") };
  }

  it("signs in as the seeded superadmin, creates the principal and a key with the two config scopes, and writes the key without printing it", async () => {
    const cwd = await workingCopy();
    const instanceUrl = "http://127.0.0.1:4210";
    await writeFile(join(cwd, ".env"), "KEEP=1\nCATALYST_API_KEY=old\nALSO=kept\n");
    const instance = localInstance({ existingPrincipal: false });

    const result = await run(cwd, instanceUrl, instance.fetchImpl);

    expect(result.output).not.toContain(localSecret);
    expect(result.code).toBe(0);
    expect(result.output).toContain("wrote CATALYST_API_KEY to");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(
      `KEEP=1\nCATALYST_API_KEY=${localSecret}\nALSO=kept\n`
    );
    const [signIn, list, createPrincipal, createKey] = instance.requests;
    expect(signIn?.body).toEqual({
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password"
    });
    expect(signIn?.headers.get("origin")).toBe("http://127.0.0.1:5273");
    expect(list?.headers.get("origin")).toBe("http://127.0.0.1:5273");
    expect(createPrincipal?.body).toEqual({
      displayLabel: "Local config CLI",
      permissions: ["config_assets.read", "config_assets.release"]
    });
    expect(createKey?.body).toEqual({
      name: "local development",
      scopes: ["config_assets:read", "config_assets:release"]
    });
    expect(instance.requests).toHaveLength(4);
  });

  it("reuses the principal of an earlier call and writes a variable and file it is told", async () => {
    const cwd = await workingCopy();
    const instanceUrl = "http://localhost:4210";
    const instance = localInstance({ existingPrincipal: true });

    const result = await run(cwd, instanceUrl, instance.fetchImpl, [
      "--write-env",
      "local.env",
      "--env-name",
      "CATALYST_API_KEY_LOCAL"
    ]);

    expect(result.code).toBe(0);
    expect(instance.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
    expect(instance.requests[2]?.path).toBe(
      testOperations["api_credentials.create"].buildPath({
        params: { servicePrincipalId: principal.id }
      })
    );
    expect(await readFile(join(cwd, "local.env"), "utf8")).toBe(
      `CATALYST_API_KEY_LOCAL=${localSecret}\n`
    );
  });

  it("refuses any host other than this machine before it sends a request", async () => {
    const cwd = await workingCopy();
    const instanceUrl = "https://catalyst.example.com";
    const instance = localInstance({ existingPrincipal: false });

    const result = await run(cwd, instanceUrl, instance.fetchImpl);

    expect(result.code).toBe(1);
    expect(result.output).toContain("Refusing to create a local API key on 'catalyst.example.com'");
    expect(instance.requests).toEqual([]);
  });

  it("refuses a config that is not a development config", async () => {
    const cwd = await workingCopy();
    const instanceUrl = "http://127.0.0.1:4210";
    const production = join(cwd, "app.yaml");
    await writeFile(
      production,
      (await readFile(appConfig, "utf8")).replace(
        "environment: development",
        "environment: production"
      )
    );
    const instance = localInstance({ existingPrincipal: false });
    const output: string[] = [];

    const code = await runLocalKeyCli(["--instance", instanceUrl, "--config", production], {
      cwd,
      fetchImpl: instance.fetchImpl,
      env: {},
      stderr: (text) => output.push(text)
    });

    expect(code).toBe(1);
    expect(instance.requests).toEqual([]);
  });

  it("asks for the address of the instance and sends nothing without one", async () => {
    const cwd = await workingCopy();
    const instance = localInstance({ existingPrincipal: false });
    const output: string[] = [];

    const code = await runLocalKeyCli(["--instance", "local"], {
      cwd,
      fetchImpl: instance.fetchImpl,
      env: {},
      stderr: (text) => output.push(text)
    });

    expect(code).toBe(2);
    expect(output.join("")).toContain("--instance must be the URL of the local instance");
    expect(instance.requests).toEqual([]);
  });
});
