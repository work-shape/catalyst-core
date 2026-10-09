import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it } from "vitest";
import {
  API_VERSION_PREFIX,
  apiOperations,
  createOpenApiDocument,
  type ApiOperationName,
  type Operation
} from "@vivd-catalyst/api-contract";
import { createStandaloneAuthRuntime, type StandaloneAuthRuntime } from "@vivd-catalyst/auth";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { retiredApiPaths } from "./support/retired-api-paths";
import { fileTestDatabaseUrl } from "./support/test-database";
import {
  callTestPath,
  createTestInstanceWith,
  listTestRoutes,
  type TestInstance,
  type TestStore
} from "./support/test-instance";

// The inventory of the versioned API: what is registered, under which id and path, and what
// answers nothing any more. Paths and ids are hard to change once a release carries them, so
// a change to either shows up here as a changed line.

const names = Object.keys(apiOperations).filter(
  (name): name is ApiOperationName => name in apiOperations
);
// Read through the descriptor's own type: each catalog entry is narrower than a test needs.
const descriptor = (name: ApiOperationName): Operation => apiOperations[name];
const routeOf = (name: ApiOperationName) => `${descriptor(name).method} ${descriptor(name).path}`;
const versioned = names.filter((name) => name !== "health.get");

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
  it("lists every operation under its canonical id, method and path", () => {
    expect(names.map((name) => `${name}  ${routeOf(name)}`).sort()).toMatchInlineSnapshot(`
      [
        "access_tokens.exchange  POST /api/v1/auth/access-token",
        "api_credentials.create  POST /api/v1/instance/service-principals/:servicePrincipalId/credentials",
        "api_credentials.revoke  POST /api/v1/instance/api-credentials/:credentialId/revoke",
        "approval_requests.count_pending  GET /api/v1/approval-requests/pending-count",
        "approval_requests.decide  POST /api/v1/approval-requests/:requestId/decide",
        "approval_requests.get  GET /api/v1/approval-requests/:requestId",
        "approval_requests.list  GET /api/v1/approval-requests",
        "approval_requests.revert  POST /api/v1/approval-requests/:requestId/revert",
        "approval_requests.withdraw  POST /api/v1/approval-requests/:requestId/withdraw",
        "audit_activities.list  GET /api/v1/instance/audit-activities",
        "audit_events.list  GET /api/v1/instance/audit-events",
        "branding.get  GET /api/v1/instance/branding",
        "captured_mail.list  GET /api/v1/dev/captured-mail",
        "config.get  GET /api/v1/instance/config",
        "config_agents.set_availability  PUT /api/v1/instance/config/agents/:name/availability",
        "config_agents.set_default  PUT /api/v1/instance/config/default-agent",
        "config_assets.delete  POST /api/v1/instance/config/assets/:kind/:name/delete",
        "config_assets.export  GET /api/v1/instance/config/export",
        "config_assets.get  GET /api/v1/instance/config/assets/:kind/:name",
        "config_assets.get_overview  GET /api/v1/instance/config/assets",
        "config_assets.put  PUT /api/v1/instance/config/assets/:kind/:name",
        "config_assets.replace  POST /api/v1/instance/config/import",
        "config_assets.revert  POST /api/v1/instance/config/assets/:kind/:name/revert",
        "config_assets.revisions.list  GET /api/v1/instance/config/assets/:kind/:name/revisions",
        "config_assets.validate  POST /api/v1/instance/config/validate",
        "conversations.artifacts.get_content  GET /api/v1/conversations/:conversationId/artifacts/:artifactId/content",
        "conversations.artifacts.get_preview  GET /api/v1/conversations/:conversationId/artifacts/:artifactId/preview",
        "conversations.artifacts.retry_preview  POST /api/v1/conversations/:conversationId/artifacts/:artifactId/preview/retry",
        "conversations.artifacts.start_preview  POST /api/v1/conversations/:conversationId/artifacts/:artifactId/preview",
        "conversations.attachments.get_preview  GET /api/v1/conversations/:conversationId/attachments/:attachmentId/preview",
        "conversations.attachments.start_preview  POST /api/v1/conversations/:conversationId/attachments/:attachmentId/preview",
        "conversations.create  POST /api/v1/conversations",
        "conversations.delete  DELETE /api/v1/conversations/:conversationId",
        "conversations.draft_attachments.delete  DELETE /api/v1/conversations/:conversationId/draft-attachments/:attachmentId",
        "conversations.draft_attachments.list  GET /api/v1/conversations/:conversationId/draft-attachments",
        "conversations.draft_attachments.retry  POST /api/v1/conversations/:conversationId/draft-attachments/:attachmentId/retry",
        "conversations.draft_attachments.upload  POST /api/v1/conversations/:conversationId/draft-attachments",
        "conversations.files.get_content  GET /api/v1/conversations/:conversationId/files/:fileId/content",
        "conversations.list  GET /api/v1/conversations",
        "conversations.messages.list  GET /api/v1/conversations/:conversationId/messages",
        "conversations.move  POST /api/v1/conversations/:conversationId/move",
        "conversations.rename  PATCH /api/v1/conversations/:conversationId/title",
        "conversations.resources.list  GET /api/v1/conversations/:conversationId/resources",
        "conversations.runs.cancel  POST /api/v1/conversations/:conversationId/runs/:runId/cancel",
        "conversations.runs.command  POST /api/v1/conversations/:conversationId/runs/:runId/commands",
        "conversations.runs.create  POST /api/v1/conversations/runs",
        "conversations.runs.observe  GET /api/v1/conversations/:conversationId/runs/:runId/events",
        "conversations.runs.start  POST /api/v1/conversations/:conversationId/runs",
        "conversations.structured_data.get  GET /api/v1/conversations/:conversationId/structured-data/:structuredDataResourceId",
        "conversations.thread.get  GET /api/v1/conversations/:conversationId/thread",
        "conversations.title.generate  POST /api/v1/conversations/:conversationId/title",
        "health.get  GET /health",
        "instance.workspaces.list  GET /api/v1/instance/workspaces",
        "me.delete  DELETE /api/v1/me",
        "me.get  GET /api/v1/me",
        "me.model_preference.get  GET /api/v1/me/model-preference",
        "me.model_preference.set  PUT /api/v1/me/model-preference",
        "me.password.change  POST /api/v1/me/password",
        "me.update  PATCH /api/v1/me",
        "password_reset.request  POST /api/v1/password-reset",
        "password_setup.complete  POST /api/v1/password-setup",
        "service_principals.create  POST /api/v1/instance/service-principals",
        "service_principals.list  GET /api/v1/instance/service-principals",
        "service_principals.update  PATCH /api/v1/instance/service-principals/:servicePrincipalId",
        "session_tokens.issue  POST /api/v1/instance/session-tokens",
        "usage.get_summary  GET /api/v1/instance/usage",
        "users.create  POST /api/v1/instance/users",
        "users.delete  DELETE /api/v1/instance/users/:userId",
        "users.identities.delete  DELETE /api/v1/instance/users/:userId/identities/:authSource/:externalUserId",
        "users.identities.upsert  PUT /api/v1/instance/users/:userId/identities",
        "users.invitation.send  POST /api/v1/instance/users/:userId/invitation",
        "users.list  GET /api/v1/instance/users",
        "users.password.reset  POST /api/v1/instance/users/:userId/password",
        "users.update  PATCH /api/v1/instance/users/:userId",
        "workspaces.access_requests.approve  POST /api/v1/workspaces/:collaborationWorkspaceId/access-requests/:userId/approve",
        "workspaces.access_requests.create  POST /api/v1/workspaces/:collaborationWorkspaceId/access-requests",
        "workspaces.access_requests.decline  DELETE /api/v1/workspaces/:collaborationWorkspaceId/access-requests/:userId",
        "workspaces.access_requests.list  GET /api/v1/workspaces/:collaborationWorkspaceId/access-requests",
        "workspaces.agents.list  GET /api/v1/workspaces/:collaborationWorkspaceId/agents",
        "workspaces.create  POST /api/v1/workspaces",
        "workspaces.delete  DELETE /api/v1/workspaces/:collaborationWorkspaceId",
        "workspaces.deletion_impact.get  GET /api/v1/workspaces/:collaborationWorkspaceId/deletion-impact",
        "workspaces.directory.list  GET /api/v1/workspaces/directory",
        "workspaces.ensure_personal  POST /api/v1/workspaces/personal",
        "workspaces.get  GET /api/v1/workspaces/:collaborationWorkspaceId",
        "workspaces.list  GET /api/v1/workspaces",
        "workspaces.member_candidates.list  GET /api/v1/workspaces/:collaborationWorkspaceId/member-candidates",
        "workspaces.members.add  POST /api/v1/workspaces/:collaborationWorkspaceId/members",
        "workspaces.members.leave  DELETE /api/v1/workspaces/:collaborationWorkspaceId/members/me",
        "workspaces.members.list  GET /api/v1/workspaces/:collaborationWorkspaceId/members",
        "workspaces.members.remove  DELETE /api/v1/workspaces/:collaborationWorkspaceId/members/:userId",
        "workspaces.members.update_role  PATCH /api/v1/workspaces/:collaborationWorkspaceId/members/:userId",
        "workspaces.update  PATCH /api/v1/workspaces/:collaborationWorkspaceId",
      ]
    `);
  });

  it("names every operation <resource>.<verb> and keys it by that id", () => {
    for (const name of names) {
      expect(descriptor(name).id, name).toBe(name);
      expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*(?:\.[a-z]+(?:_[a-z]+)*){1,2}$/u);
    }
  });

  it("puts every operation except the health probe under the version prefix", () => {
    expect(API_VERSION_PREFIX.split("/")).toEqual(["", "api", "v1"]);
    for (const name of versioned) {
      expect(descriptor(name).path.startsWith(`${API_VERSION_PREFIX}/`), name).toBe(true);
    }
    expect(routeOf("health.get")).toBe("GET /health");
    expect(descriptor("health.get").auth).toBe("public");
  });

  it("scopes paths by resource and never by a role name", () => {
    for (const name of names) {
      expect(descriptor(name).path, name).not.toMatch(/\/(?:super)?admin(?:\/|$)/u);
    }
    const scopes = new Set(versioned.map((name) => descriptor(name).path.split("/")[3]));
    expect([...scopes].sort()).toEqual([
      "approval-requests",
      "auth",
      "conversations",
      "dev",
      "instance",
      "me",
      "password-reset",
      "password-setup",
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

  it("describes every versioned operation under its canonical id", () => {
    const ids = documented.map(({ operation }) =>
      typeof operation === "object" && operation !== null && "operationId" in operation
        ? operation.operationId
        : undefined
    );
    expect(ids.sort()).toEqual(
      versioned.filter((name) => descriptor(name).devOnly !== true).sort()
    );
  });

  it("leaves out the development mail listing and the unversioned health probe", () => {
    expect(descriptor("captured_mail.list").devOnly).toBe(true);
    const paths = Object.keys(document.paths);
    expect(paths.every((path) => path.startsWith(`${API_VERSION_PREFIX}/`))).toBe(true);
    expect(paths).not.toContain(descriptor("captured_mail.list").path);
    expect(paths).not.toContain(descriptor("health.get").path);
    expect(names.filter((name) => descriptor(name).devOnly === true)).toEqual([
      "captured_mail.list"
    ]);
  });
});

describe("a running instance", () => {
  let instance: TestInstance;
  let development: TestInstance;
  beforeAll(async () => {
    instance = await createTestInstanceWith(optionalParts);
    development = await createTestInstanceWith((stores) => ({
      ...optionalParts(stores),
      mail: capturedMail
    }));
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

  it("retired every path the previous release answered", () => {
    const current = new Set(names.map(routeOf));
    for (const [method, path] of retiredApiPaths) {
      expect(current.has(`${method} ${path}`), `${method} ${path}`).toBe(false);
    }
    // Each operation moved; none was dropped beside the alias and none was added.
    expect(retiredApiPaths.length).toBe(versioned.length + 1);
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
    instance = await createTestInstanceWith((stores) => ({
      ...optionalParts(stores),
      standaloneAuth: auth
    }));
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
    expect(registered.sort()).toEqual([...catalog, "OPTIONS *"].sort());
  });

  it("does not answer for the API-key exchange, which moved under the version prefix", async () => {
    // The exchange's retired path lies below the mount, where the library answers for it.
    const retiredExchange = retiredApiPaths.find(([, path]) => path.endsWith("/auth/access-token"));
    if (!retiredExchange) throw new Error("The retired API-key exchange path is not listed");
    const retired = await callTestPath(instance, retiredExchange[0], retiredExchange[1]);
    expect(retired.statusCode).toBe(404);
    // The operation itself answers: this instance has no API access configured.
    const exchange = await instance.call("access_tokens.exchange");
    expect(exchange.statusCode).toBe(404);
    expect(exchange.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "API access is not configured" }
    });
  });
});
