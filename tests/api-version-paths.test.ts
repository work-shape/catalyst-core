import { readdir } from "node:fs/promises";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it } from "vitest";
import {
  API_VERSION_PREFIX,
  apiOperations,
  createOpenApiDocument,
  operationAreas,
  type ApiOperationName,
  type Operation
} from "@work-shape/catalyst-api-contract";
import { createStandaloneAuthRuntime, type StandaloneAuthRuntime } from "@work-shape/catalyst-auth";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { authMountRoutes } from "./support/operations";
import { removedAssetPaths, retiredApiPaths } from "./support/retired-api-paths";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  callTestPath,
  createTestInstanceWith,
  listTestRoutes,
  type TestInstance,
  type TestStore
} from "./support/test-instance";
import { dataStoreRoutes } from "./support/data-store-routes";

// The inventory of the versioned API: what is registered, under which id and path, and what
// answers nothing any more. Paths and ids are hard to change once a release carries them, so
// a change to either shows up here as a changed line.

const names = Object.keys(apiOperations).filter(
  (name): name is ApiOperationName => name in apiOperations
);
// Read through the descriptor's own type: each catalog entry is narrower than a test needs.
const descriptor = (name: ApiOperationName): Operation => apiOperations[name];
const routeOf = (name: ApiOperationName) => `${descriptor(name).method} ${descriptor(name).path}`;
// Outside the versioned API: the health and readiness probes, the runtime files a sandboxed
// view frame loads as script addresses, the shell document that frames a view, and the files
// of a Page, which its frame loads by relative addresses.
const unversioned: readonly ApiOperationName[] = [
  "health.get",
  "ready.get",
  "app_kit.files.get",
  "view_runtime.files.get",
  "view_shell.files.get",
  "app_content.files.get"
];
const versioned = names.filter((name) => !unversioned.includes(name));

const capturedMail = {
  sender: { send: () => Promise.resolve({ ok: true as const }) },
  appUrl: "https://ui.example.test",
  listCaptured: () => []
};

/** The parts a default instance runs without, so that every operation is registered. */
const optionalParts = (stores: TestStore) => ({
  approvalRequests: { store: stores.approvals, handlers: new Map() }
});

describe("the operation catalog", () => {
  it("files every operation under exactly one area", () => {
    const filed = Object.values(operationAreas).flatMap((area) => Object.keys(area));
    expect([...filed].sort()).toEqual([...names].sort());
  });

  // One reviewed pin per area of `api-contract/src/operations`, so a change to one area does not
  // edit the pin of another.
  it.each(Object.entries(operationAreas))(
    "lists the operations of %s under their canonical id, method and path",
    async (area, operations) => {
      const lines = Object.keys(operations)
        .filter((name): name is ApiOperationName => name in apiOperations)
        .map((name) => `${name}  ${routeOf(name)}`)
        .sort();
      await expect(`${lines.join("\n")}\n`).toMatchFileSnapshot(
        `./__snapshots__/api-paths/${area}.txt`
      );
    }
  );

  it("keeps no pin of an area that is gone", async () => {
    const pinned = await readdir(new URL("./__snapshots__/api-paths/", import.meta.url));
    expect(pinned.sort()).toEqual(
      Object.keys(operationAreas)
        .map((area) => `${area}.txt`)
        .sort()
    );
  });

  it("names every operation <resource>.<verb> and keys it by that id", () => {
    for (const name of names) {
      expect(descriptor(name).id, name).toBe(name);
      expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*(?:\.[a-z]+(?:_[a-z]+)*){1,2}$/u);
    }
  });

  it("puts every operation except the two probes and the files of a view's frame under the version prefix", () => {
    expect(API_VERSION_PREFIX.split("/")).toEqual(["", "api", "v1"]);
    for (const name of versioned) {
      expect(descriptor(name).path.startsWith(`${API_VERSION_PREFIX}/`), name).toBe(true);
    }
    expect(routeOf("health.get")).toBe("GET /health");
    expect(descriptor("health.get").auth).toBe("public");
    expect(routeOf("ready.get")).toBe("GET /ready");
    expect(descriptor("ready.get").auth).toBe("public");
    expect(routeOf("view_runtime.files.get")).toBe("GET /app-runtime/view/:version/:file");
    expect(descriptor("view_runtime.files.get").auth).toBe("public");
    expect(routeOf("view_shell.files.get")).toBe("GET /app-runtime/view-shell/:version/:file");
    expect(descriptor("view_shell.files.get").auth).toBe("public");
    // Public because its frame has no origin and so no session to send: the token in the
    // address is the authorization.
    expect(routeOf("app_content.files.get")).toBe("GET /app-content/*");
    expect(descriptor("app_content.files.get").auth).toBe("public");
  });

  it("scopes paths by resource and never by a role name", () => {
    for (const name of names) {
      expect(descriptor(name).path, name).not.toMatch(/\/(?:super)?admin(?:\/|$)/u);
    }
    const scopes = new Set(versioned.map((name) => descriptor(name).path.split("/")[3]));
    expect([...scopes].sort()).toEqual([
      "agents",
      "app-actions",
      "app-content-sessions",
      "app-data-sources",
      "approval-requests",
      "apps",
      "assets",
      "auth",
      "connection-tools",
      "connections",
      "connector-types",
      "context",
      "conversations",
      "data-stores",
      "dev",
      "docs",
      "feedback",
      "guardrails",
      "instance",
      "knowledge-bases",
      "me",
      "openapi.json",
      "operations",
      "password-reset",
      "password-setup",
      "project-files",
      "projects",
      "scheduled-starts",
      "skills",
      "workflow-runs",
      "workflows",
      "workspaces"
    ]);
  });

  it("gives every method and path to one operation", () => {
    expect(new Set(names.map(routeOf)).size).toBe(names.length);
  });

  it("keeps session-token issuance for embedding hosts as one operation without an alias", () => {
    const issuing = names.filter((name) => descriptor(name).auth === "serverCredential");
    expect(issuing).toEqual(["session_tokens.issue"]);
    expect(routeOf("session_tokens.issue")).toBe(
      `POST ${API_VERSION_PREFIX}/instance/session-tokens`
    );
    expect(routeOf("access_tokens.exchange")).toBe(`POST ${API_VERSION_PREFIX}/auth/access-token`);
  });
});

describe("the released document", () => {
  const document = createOpenApiDocument();
  const documented = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      path,
      method: method.toUpperCase(),
      operation
    }))
  );

  it("describes every versioned operation and the readiness probe under its canonical id", () => {
    const ids = documented.map(({ operation }) =>
      typeof operation === "object" && operation !== null && "operationId" in operation
        ? operation.operationId
        : undefined
    );
    expect(ids.sort()).toEqual(
      [...versioned.filter((name) => descriptor(name).devOnly !== true), "ready.get"].sort()
    );
  });

  it("leaves out the development mail listing and every unversioned path but the readiness probe", () => {
    expect(descriptor("captured_mail.list").devOnly).toBe(true);
    const paths = Object.keys(document.paths);
    expect(paths.filter((path) => !path.startsWith(`${API_VERSION_PREFIX}/`))).toEqual([
      descriptor("ready.get").path
    ]);
    expect(paths).not.toContain(descriptor("captured_mail.list").path);
    expect(paths).not.toContain(descriptor("health.get").path);
    expect(paths.some((path) => path.startsWith("/app-runtime"))).toBe(false);
    expect(paths.some((path) => path.startsWith("/app-content"))).toBe(false);
    expect(names.filter((name) => descriptor(name).devOnly === true)).toEqual([
      "captured_mail.list"
    ]);
  });
});

describe("a running instance", () => {
  let instance: TestInstance;
  let development: TestInstance;
  beforeAll(async () => {
    // The routes of a module come from its assembly, which a server built here does not have.
    const moduleRoutes = await dataStoreRoutes();
    instance = await createTestInstanceWith(optionalParts, moduleRoutes);
    development = await createTestInstanceWith(
      (stores) => ({ ...optionalParts(stores), mail: capturedMail }),
      moduleRoutes
    );
  });

  it("registers the catalog and nothing beside it", async () => {
    const registered = (await listTestRoutes(development))
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    // The preflight route belongs to the CORS plugin.
    expect(registered).toEqual([...names.map(routeOf), "OPTIONS *"].sort());
  });

  it("registers the development mail listing only where mail is captured", async () => {
    const released = (await listTestRoutes(instance)).map(
      ({ method, path }) => `${method} ${path}`
    );
    expect(released).not.toContain(routeOf("captured_mail.list"));
    expect((await instance.call("captured_mail.list")).statusCode).toBe(404);
    expect((await development.call("captured_mail.list")).statusCode).toBe(200);
  });

  it("answers the health probe without a credential at its unversioned path", async () => {
    const health = await instance.call("health.get");
    expect(health.statusCode).toBe(200);
    expect((await callTestPath(instance, "GET", `${API_VERSION_PREFIX}/health`)).statusCode).toBe(
      404
    );
  });

  it.each(retiredApiPaths)("answers 404 at the retired path %s %s", async (method, path) => {
    // A full set of credentials shows that the refusal is the missing route, not the caller.
    const response = await callTestPath(development, method, path, {
      "x-dev-user-id": "superadmin",
      "x-server-credential": "server-credential"
    });
    expect(response.statusCode).toBe(404);
  });

  // The asset addresses under `/instance/config/assets` are gone without an alias: the same
  // calls are made at `/api/v1/assets`.
  it.each(removedAssetPaths)(
    "answers 404 at the removed asset address %s %s",
    async (method, path) => {
      const response = await callTestPath(development, method, path, {
        "x-dev-user-id": "superadmin",
        "x-server-credential": "server-credential"
      });
      expect(response.statusCode).toBe(404);
      for (const name of names) {
        expect(name).not.toMatch(/^config_assets\.(?:get|put|delete|revert|revisions\.list)$/u);
      }
    }
  );

  it("retired every path the previous release answered", () => {
    const current = new Set(names.map(routeOf));
    for (const [method, path] of retiredApiPaths) {
      expect(current.has(`${method} ${path}`), `${method} ${path}`).toBe(false);
    }
    // The paths the unversioned release answered are frozen: the list changes only when a
    // release retires more paths.
    expect(retiredApiPaths.length).toBe(93);
  });
});

describe("the sign-in library's mount", () => {
  let auth: StandaloneAuthRuntime;
  let instance: TestInstance;
  beforeAll(async () => {
    auth = await createStandaloneAuthRuntime({
      clientInstanceId: asClientInstanceId("api_version_paths_test"),
      databaseUrl: await fileTestDatabaseUrl(),
      secret: "test-secret-at-least-32-characters-long",
      baseUrl: "http://localhost:3000"
    });
    instance = await createTestInstanceWith(
      (stores) => ({ ...optionalParts(stores), standaloneAuth: auth }),
      await dataStoreRoutes()
    );
  });
  afterAll(async () => {
    await auth?.close();
  });

  it("stays at /api/auth beside the versioned operations", async () => {
    // The library owns what is below its mount: the session lookup answers without a session,
    // and a sign-in with unknown credentials is refused by the library itself.
    const session = await instance.call("authSession");
    expect(session.statusCode).toBe(200);
    expect(session.json()).toBeNull();
    const signIn = await instance.call("authSignIn", {
      headers: { origin: "http://localhost:3000" },
      payload: { email: "nobody@example.test", password: "not-a-password" }
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

    // The mount is no catalog operation, and the catalog is registered beside it unchanged.
    const registered = (await listTestRoutes(instance)).map(
      ({ method, path }) => `${method} ${path}`
    );
    const catalog = names.filter((name) => descriptor(name).devOnly !== true).map(routeOf);
    expect(registered.sort()).toEqual([...catalog, "OPTIONS *", ...authMountRoutes].sort());
  });

  it("does not answer for the API-key exchange, which moved under the version prefix", async () => {
    // The exchange's retired path lies below the mount, where the library answers for it.
    const retiredExchange = retiredApiPaths.find(([, path]) => path.endsWith("/auth/access-token"));
    if (!retiredExchange) throw new Error("The retired API-key exchange path is not listed");
    const retired = await callTestPath(instance, retiredExchange[0], retiredExchange[1]);
    expect(retired.statusCode).toBe(404);
    // An older CLI sends its key as a bearer there. The mount refuses explicit credentials
    // before it routes, so that caller reads 401 and not 404.
    const withKey = await callTestPath(instance, retiredExchange[0], retiredExchange[1], {
      authorization: "Bearer cat_live_an_older_cli_key"
    });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
    // The operation itself answers: this instance has no API access configured.
    const exchange = await instance.call("access_tokens.exchange");
    expect(exchange.statusCode).toBe(404);
    expect(exchange.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "API access is not configured" }
    });
  });
});
