import { describe, expect, it } from "vitest";
import {
  API_VERSION_PREFIX,
  apiOperations,
  createOpenApiDocument,
  openApiDocumentSchema
} from "@work-shape/catalyst-api-contract";
import type { AuthAdapter } from "@work-shape/catalyst-auth";
import { AppError } from "@work-shape/catalyst-core";
import { required } from "./support/assertions";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { dataStoreRoutes } from "./support/data-store-routes";
import { createTestInstanceWith, type TestStore } from "./support/test-instance";

const released = createOpenApiDocument();

describe("the reference an instance serves", () => {
  // Refuses a request that names no caller, as an instance refuses one without a credential.
  const signedInOnly = (): AuthAdapter => {
    const callers = createCallerAuthAdapter();
    const [callerHeader] = Object.keys(asCaller().headers);
    return {
      id: "signed-in-only",
      credentialMode: "ambient",
      authenticate: (request) =>
        required(callerHeader) in request.headers
          ? callers.authenticate(request)
          : Promise.reject(new AppError("UNAUTHENTICATED", "No credential"))
    };
  };
  const withApprovals = (stores: TestStore) => ({
    authAdapter: signedInOnly(),
    approvalRequests: { store: stores.approvals, handlers: new Map() }
  });
  const pathsOf = (body: unknown) => Object.keys(openApiDocumentSchema.parse(body).paths);

  it("refuses a caller without a credential and answers a person and a key", async () => {
    const instance = await createTestInstanceWith(withApprovals);
    for (const operation of ["openapi.get", "docs.get"] as const) {
      const anonymous = await instance.call(operation);
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
      // Neither a scope nor a right is asked of whoever is signed in.
      for (const caller of [
        asCaller({ kind: "user", scopes: [] }),
        asCaller({ kind: "service", scopes: [] })
      ]) {
        expect((await instance.call(operation, {}, caller)).statusCode).toBe(200);
      }
    }
  });

  it("describes every operation the instance registered, as the release does", async () => {
    // The routes of a module come from its assembly, which a server built here does not have.
    const instance = await createTestInstanceWith(withApprovals, await dataStoreRoutes());
    const response = await instance.call("openapi.get", {}, asCaller());
    expect(pathsOf(response.json())).toEqual(Object.keys(released.paths));
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(released)));
  });

  it("leaves out the operations of a part the instance runs without", async () => {
    const instance = await createTestInstanceWith(() => ({ authAdapter: signedInOnly() }));
    const response = await instance.call("openapi.get", {}, asCaller());
    const paths = pathsOf(response.json());
    const approvalPaths = Object.keys(released.paths).filter((path) =>
      path.startsWith(`${API_VERSION_PREFIX}/approval-requests`)
    );
    expect(approvalPaths.length).toBeGreaterThan(0);
    // Nor does this server hold the routes of a module, which only its assembly adds.
    const moduleRoutes = [
      `${API_VERSION_PREFIX}/data-stores`,
      `${API_VERSION_PREFIX}/app-data-sources`,
      `${API_VERSION_PREFIX}/knowledge-bases`,
      // What deleting a Workflow ends in Knowledge Bases is the knowledge module's.
      `${API_VERSION_PREFIX}/workflows/{workflow}/knowledge-sources`
    ];
    expect(paths).toEqual(
      Object.keys(released.paths).filter(
        (path) =>
          !approvalPaths.includes(path) && !moduleRoutes.some((prefix) => path.startsWith(prefix))
      )
    );
    const document = openApiDocumentSchema.parse(response.json());
    expect(document.tags.map((tag) => tag.name)).not.toContain(
      apiOperations["approval_requests.list"].tag
    );
    expect(Object.keys(document.components.schemas)).not.toContain("ApprovalRequestView");

    const page = await instance.call("docs.get", {}, asCaller());
    expect(page.body).not.toContain("approval-requests");
    expect(page.body).toContain(apiOperations["conversations.list"].id);
  });

  it("serves the page as a document that can load nothing", async () => {
    const instance = await createTestInstanceWith(withApprovals);
    const page = await instance.call("docs.get", {}, asCaller());
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toMatch(
      /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; .*; frame-ancestors 'none'$/u
    );
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain(`href="${apiOperations["openapi.get"].path}" download`);
    // No script, no image, no stylesheet and no font: one style element is all the page has.
    expect(page.body).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|url\(|@import/iu);
    expect(page.body.match(/<style>/gu)).toHaveLength(1);
    expect(page.body).toContain("text/event-stream");
    expect(page.body).toContain("x-server-credential");
  });
});
