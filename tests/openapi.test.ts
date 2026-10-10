import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  API_VERSION_PREFIX,
  COMMON_OPERATION_ERRORS,
  apiOperations,
  createOpenApiDocument,
  createOpenApiDocumentFromOperations,
  findBreakingChanges,
  isRegisteredOperation,
  openApiDocumentSchema,
  renderApiReferencePage,
  selectContractBaseline,
  type OpenApiDocument,
  type Operation
} from "@vivd-catalyst/api-contract";
import type { AuthAdapter } from "@vivd-catalyst/auth";
import { APP_ERROR_STATUS_CODES, AppError } from "@vivd-catalyst/core";
import { z } from "zod";
import { required } from "./support/assertions";
import { registeredTestOperations } from "./support/operations";
import { retiredApiPaths } from "./support/retired-api-paths";
import { asCaller, createCallerAuthAdapter } from "./support/route-callers";
import { createTestInstanceWith, type TestStore } from "./support/test-instance";

const released = createOpenApiDocument();
const operations: readonly Operation[] = Object.values(apiOperations);
const documentedOperation = (id: keyof typeof apiOperations) =>
  required(
    Object.values(released.paths)
      .flatMap((methods) => Object.values(methods))
      .find((operation) => operation.operationId === id)
  );
const schemeNames = (id: keyof typeof apiOperations) =>
  documentedOperation(id).security.flatMap((requirement) => Object.keys(requirement));

describe("the released OpenAPI document", () => {
  it("carries the release version and is the same on every generation", async () => {
    const manifest = z
      .object({ version: z.string() })
      .parse(JSON.parse(await readFile("packages/api-contract/package.json", "utf8")));
    expect(released.info.version).toBe(manifest.version);
    expect(JSON.stringify(createOpenApiDocument())).toBe(JSON.stringify(released));
    expect(Object.keys(released.paths)).toEqual(Object.keys(released.paths).toSorted());
    expect(openApiDocumentSchema.safeParse(released).success).toBe(true);
  });

  it("states for every operation which credentials it accepts and with which scope", () => {
    expect(Object.keys(released.components.securitySchemes)).toEqual([
      "sessionCookie",
      "sessionToken",
      "accessToken",
      "apiKey",
      "serverCredential"
    ]);
    expect(schemeNames("branding.get")).toEqual([]);
    expect(documentedOperation("conversations.list").security).toEqual([
      { sessionCookie: ["conversation:read"] },
      { sessionToken: ["conversation:read"] }
    ]);
    expect(schemeNames("config_assets.get")).toEqual([
      "sessionCookie",
      "sessionToken",
      "accessToken"
    ]);
    expect(documentedOperation("openapi.get").security).toEqual([
      { sessionCookie: [] },
      { sessionToken: [] },
      { accessToken: [] }
    ]);
    expect(schemeNames("session_tokens.issue")).toEqual(["serverCredential"]);
    expect(schemeNames("access_tokens.exchange")).toEqual(["apiKey"]);
  });

  it("describes a list, a stream, a file and a page by what they answer", () => {
    const answer = (id: keyof typeof apiOperations, status: string) => {
      const response = required(documentedOperation(id).responses[status]);
      if ("$ref" in response) throw new Error(`${id} ${status} is a reference`);
      return response;
    };
    expect(answer("conversations.list", "200").content).toMatchObject({
      "application/json": { schema: { required: ["items"] } }
    });
    expect(Object.keys(required(answer("conversations.runs.observe", "200").content))).toEqual([
      "text/event-stream"
    ]);
    expect(answer("conversations.runs.observe", "204").content).toBeUndefined();
    expect(answer("conversations.artifacts.get_content", "200").content).toEqual({
      "application/octet-stream": { schema: { type: "string", format: "binary" } }
    });
    expect(answer("docs.get", "200").content).toEqual({
      "text/html": { schema: { type: "string" } }
    });
    expect(documentedOperation("workspaces.create").requestBody).toEqual({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateCollaborationWorkspaceRequest" }
        }
      }
    });
  });

  it("declares an answer for every error code an operation can answer with", () => {
    for (const operation of operations) {
      if (operation.devOnly || !operation.path.startsWith(`${API_VERSION_PREFIX}/`)) continue;
      const documented = documentedOperation(operation.id as keyof typeof apiOperations);
      const anonymous = documented.security.length === 0;
      const codes = [
        ...COMMON_OPERATION_ERRORS.filter(
          (code) => !anonymous || (code !== "UNAUTHENTICATED" && code !== "FORBIDDEN")
        ),
        ...operation.errors
      ];
      for (const code of codes) {
        const response = required(documented.responses[String(APP_ERROR_STATUS_CODES[code])]);
        if (!("$ref" in response)) throw new Error(`${operation.id} ${code} is not a reference`);
        const name = response.$ref.replace("#/components/responses/", "");
        expect(released.components.responses[name]?.description).toContain(code);
      }
    }
    expect(Object.keys(documentedOperation("branding.get").responses)).not.toContain("401");
  });

  it("gives the codes that share a status one answer that names each of them", () => {
    const registered = createOpenApiDocumentFromOperations(registeredTestOperations);
    const change = documentedOperationOf(registered, "testRunChange");
    expect(change.responses["403"]).toEqual({
      $ref: "#/components/responses/ForbiddenOrPolicyDeniedOrGuardrailBlockedOrDeclined"
    });
    const refusal = required(
      registered.components.responses.ForbiddenOrPolicyDeniedOrGuardrailBlockedOrDeclined
    );
    for (const code of ["FORBIDDEN", "POLICY_DENIED", "GUARDRAIL_BLOCKED", "DECLINED"]) {
      expect(refusal.description).toContain(`\`${code}\``);
    }
    const conflict = change.responses["409"];
    if (!conflict || !("$ref" in conflict)) throw new Error("409 is not a reference");
    const repeated = required(
      registered.components.responses[conflict.$ref.replace("#/components/responses/", "")]
    );
    for (const code of [
      "IDEMPOTENCY_KEY_REUSED",
      "OPERATION_IN_PROGRESS",
      "OPERATION_EXPIRED",
      "OUTPUT_NOT_RETAINED"
    ]) {
      expect(repeated.description).toContain(code);
    }
    // An answer for one code keeps the name it always had.
    expect(Object.keys(released.components.responses)).toContain("Forbidden");
  });

  it("declares 202, the key and the run headers on operations of the registry only", () => {
    const registered = createOpenApiDocumentFromOperations(registeredTestOperations);
    expect(openApiDocumentSchema.safeParse(registered).success).toBe(true);
    const change = documentedOperationOf(registered, "testRunChange");
    const read = documentedOperationOf(registered, "testRunRead");
    const header = (name: string) => ({ $ref: `#/components/headers/${name}` });

    expect(Object.keys(change.responses)).toContain("202");
    expect(change.responses["202"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/OperationRun" } } },
      headers: {
        "Operation-Run-Id": header("OperationRunId"),
        Location: header("Location"),
        "Idempotent-Replayed": header("IdempotentReplayed")
      }
    });
    expect(change.responses["200"]).toMatchObject({
      headers: {
        "Operation-Run-Id": header("OperationRunId"),
        "Idempotent-Replayed": header("IdempotentReplayed")
      }
    });
    expect(change.responses["200"]).not.toHaveProperty("headers.Location");
    expect(change.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header", required: false })
    );

    // A reading operation of the registry names its run and never waits.
    expect(Object.keys(read.responses)).not.toContain("202");
    expect(read.responses["200"]).toMatchObject({
      headers: { "Operation-Run-Id": header("OperationRunId") }
    });
    expect(read.parameters.map((parameter) => parameter.in)).not.toContain("header");

    // Each header is declared once and referred to from there.
    expect(Object.keys(required(registered.components.headers))).toEqual([
      "OperationRunId",
      "Location",
      "IdempotentReplayed"
    ]);

    // In the released document a hand-written route declares none of it. The deletions that a
    // job may finish answer 202 without a body and without a run.
    const ofRegistry = new Set(operations.filter(isRegisteredOperation).map(({ id }) => id));
    expect([...ofRegistry]).toContain("instance.jobs.retry");
    const deferred: string[] = [];
    for (const operation of Object.values(released.paths).flatMap((methods) =>
      Object.values(methods)
    )) {
      const declared = ofRegistry.has(operation.operationId);
      expect(JSON.stringify(operation).includes("components/headers"), operation.operationId).toBe(
        declared
      );
      if (!declared && Object.keys(operation.responses).includes("202")) {
        deferred.push(operation.operationId);
        expect(operation.responses["202"], operation.operationId).not.toHaveProperty("content");
      }
    }
    expect(deferred.sort()).toEqual(["me.delete", "users.delete", "workspaces.delete"]);
    expect(Object.keys(required(released.components.headers))).toEqual([
      "OperationRunId",
      "Location",
      "IdempotentReplayed"
    ]);

    const page = renderApiReferencePage(registered, {
      documentHref: "openapi.json",
      theme: {
        light: {
          surfaceColor: "#ffffff",
          backgroundColor: "#f5f5f5",
          textColor: "#1a1a1a",
          mutedTextColor: "#5e5e5e",
          borderColor: "#e5e5e5",
          accentColor: "#1a1a1a"
        }
      }
    });
    expect(page.html).toContain("Idempotency-Key");
    expect(page.html).toContain("Operation-Run-Id");
  });

  it("names every schema it refers to and holds no schema nothing refers to", () => {
    const text = JSON.stringify(released);
    const referenced = new Set(
      Array.from(text.matchAll(/"#\/components\/schemas\/([^"]+)"/gu), (match) => match[1])
    );
    expect([...referenced].toSorted()).toEqual(Object.keys(released.components.schemas));
    expect(text).not.toContain("$defs");
  });
});

describe("the breaking-change comparison", () => {
  const changed = (change: (document: OpenApiDocument) => void) => {
    const document = structuredClone(released);
    change(document);
    return findBreakingChanges(released, document);
  };
  const schema = (document: OpenApiDocument, name: string) =>
    z
      .looseObject({
        properties: z.record(z.string(), z.record(z.string(), z.unknown())),
        required: z.array(z.string())
      })
      .parse(document.components.schemas[name]);

  it("finds nothing between a document and itself", () => {
    expect(findBreakingChanges(released, structuredClone(released))).toEqual([]);
  });

  it("accepts a new operation, a new optional request field and a new answered field", () => {
    expect(
      changed((document) => {
        document.paths[`${API_VERSION_PREFIX}/new`] = {
          get: { ...documentedOperation("me.get"), operationId: "new.get" }
        };
        const request = schema(document, "CreateCollaborationWorkspaceRequest");
        request.properties.note = { type: "string" };
        document.components.schemas.CreateCollaborationWorkspaceRequest = request;
        const answer = schema(document, "Conversation");
        answer.properties.note = { type: "string" };
        answer.required.push("note");
        document.components.schemas.Conversation = answer;
      })
    ).toEqual([]);
  });

  it("fails on a removed operation", () => {
    expect(
      changed((document) => {
        delete document.paths[apiOperations["me.get"].path]?.get;
      })
    ).toEqual(["GET /api/v1/me: the operation was removed"]);
  });

  it("fails on a new required request field and on a removed answered field", () => {
    const findings = changed((document) => {
      const request = schema(document, "CreateCollaborationWorkspaceRequest");
      request.properties.owner = { type: "string" };
      request.required.push("owner");
      document.components.schemas.CreateCollaborationWorkspaceRequest = request;
    });
    expect(findings).toEqual([
      "POST /api/v1/workspaces: request body: the field owner is now required"
    ]);
    expect(
      changed((document) => {
        const answer = schema(document, "ExchangeApiKeyResponse");
        delete answer.properties.accessToken;
        document.components.schemas.ExchangeApiKeyResponse = answer;
      })
    ).toEqual(["POST /api/v1/auth/access-token: answer 200: the field accessToken was removed"]);
  });

  it("fails on a narrowed request value, a widened answer and a dropped credential", () => {
    const findings = changed((document) => {
      const limit = required(
        documentedOperationOf(document, "conversations.list").parameters.find(
          (parameter) => parameter.name === "limit"
        )
      );
      limit.schema = { ...limit.schema, maximum: 10 };
      documentedOperationOf(document, "config_assets.get").security.pop();
      documentedOperationOf(document, "branding.get").security.push({ sessionCookie: [] });
    });
    expect(findings).toEqual([
      "GET /api/v1/conversations: query parameter limit: maximum accepts less than before",
      "GET /api/v1/instance/branding: the operation now asks for a credential",
      "GET /api/v1/instance/config/assets/{kind}/{name}: the credential accessToken is no longer accepted"
    ]);
  });

  it("takes the newest release whose document has versioned paths as the baseline", () => {
    // The paths of the last release before the version prefix existed.
    const beforeVersioning = {
      paths: Object.fromEntries(retiredApiPaths.map(([, path]) => [path, {}]))
    };
    expect(selectContractBaseline([{ tag: "v0.6.3", document: beforeVersioning }])).toBeUndefined();
    expect(
      selectContractBaseline([
        { tag: "v0.9.0", document: "not a document" },
        { tag: "v0.8.0", document: released },
        { tag: "v0.7.0", document: released },
        { tag: "v0.6.3", document: beforeVersioning }
      ])?.tag
    ).toBe("v0.8.0");
  });
});

function documentedOperationOf(document: OpenApiDocument, id: string) {
  return required(
    Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .find((operation) => operation.operationId === id)
  );
}

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
    const instance = await createTestInstanceWith(withApprovals);
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
    expect(paths).toEqual(
      Object.keys(released.paths).filter((path) => !approvalPaths.includes(path))
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
      /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; /u
    );
    expect(page.body).toContain(`href="${apiOperations["openapi.get"].path}" download`);
    // No script, no image, no stylesheet and no font: one style element is all the page has.
    expect(page.body).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|url\(|@import/iu);
    expect(page.body.match(/<style>/gu)).toHaveLength(1);
    expect(page.body).toContain("text/event-stream");
    expect(page.body).toContain("x-server-credential");
  });

  it("escapes the text of a document and refuses a colour that is no colour", () => {
    const hostile = structuredClone(released);
    hostile.info.title = `<script>alert("x")</script>`;
    documentedOperationOf(hostile, "me.get").summary = `<img src=x onerror=alert(1)>`;
    const theme = {
      surfaceColor: "#ffffff",
      backgroundColor: "#f5f5f5",
      textColor: "#1a1a1a",
      mutedTextColor: "#5e5e5e",
      borderColor: "#e5e5e5",
      accentColor: "#1a1a1a"
    };
    const page = renderApiReferencePage(hostile, {
      documentHref: "openapi.json",
      theme: { light: theme }
    });
    expect(page.html).not.toMatch(/<script|<img/u);
    expect(page.html).toContain("&lt;script&gt;");
    expect(() =>
      renderApiReferencePage(released, {
        documentHref: "openapi.json",
        theme: { light: { ...theme, accentColor: "red}</style><script>" } }
      })
    ).toThrow("Unsupported CSS value");
  });
});
