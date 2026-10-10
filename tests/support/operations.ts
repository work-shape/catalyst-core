import { z } from "zod";
import {
  apiOperations,
  createOpenApiDocument,
  buildApiPath,
  defineOperation,
  defineRegisteredOperation,
  json,
  page,
  listQuerySchema,
  timestampSchema,
  type BuildApiPathOptions
} from "@vivd-catalyst/api-contract";

// The sign-in library's mount, the worker's private transport and routes a test adds itself
// are not catalog operations.
const fixtureOperation = (method: "GET" | "POST", path: string) => ({
  method,
  path,
  buildPath: (input?: BuildApiPathOptions) => buildApiPath(path, input)
});

/** The sign-in library's mount as the server's route listing shows it. */
export const authMountRoutes = ["GET /api/auth/*", "POST /api/auth/*"] as const;

/** A path under the sign-in library's mount that the library does not serve. */
export const inventedAuthPath = (name: string | number): string => `/api/auth/invented-${name}`;

/** Spellings of the sign-in path that a server or the sign-in library may read as sign-in. */
export const signInPathSpellings = {
  "dot segment": "/api/auth/./sign-in/email",
  "parent segment": "/api/auth/x/../sign-in/email",
  "encoded dot segment": "/api/auth/%2e/sign-in/email",
  "doubled slash": "/api/auth//sign-in/email",
  "mixed case": "/api/auth/Sign-In/Email",
  "encoded letter": "/api/auth/sign-in/emai%6c"
} as const;

/** Operations a test registers through the route helper to exercise the helper itself. */
const testIdentityOperation = {
  summary: "Report the authenticated caller",
  tag: "Test",
  path: "/identity",
  auth: "user",
  scope: "me:read",
  requires: [],
  response: json(z.object({ externalUserId: z.string().optional() })),
  errors: [],
  rateClass: "read"
} as const;
const testAccess = { auth: "user", scope: "conversation:read", requires: [] } as const;
const testOperation = {
  summary: "Route helper fixture",
  tag: "Test",
  errors: [],
  rateClass: "read"
} as const;
const testResult = json(z.object({ value: z.enum(["ok", "other"]), count: z.number().optional() }));
export const routeTestOperations = {
  testList: defineOperation({
    ...testOperation,
    ...testAccess,
    id: "testList",
    method: "GET",
    path: "/test/list",
    effect: "reading",
    query: listQuerySchema.extend({ filter: z.string().optional() }),
    response: page(
      z.object({ id: z.string(), createdAt: timestampSchema }),
      ["createdAt", "id"],
      true
    )
  }),
  testPublic: defineOperation({
    ...testOperation,
    id: "testPublic",
    method: "GET",
    path: "/test/public",
    auth: "public",
    effect: "reading",
    response: testResult
  }),
  /** Takes a key from a caller it does not know, as the API key exchange does. */
  testKey: defineOperation({
    ...testOperation,
    id: "testKey",
    method: "POST",
    path: "/test/key",
    auth: "public",
    effect: "changing",
    response: testResult,
    rateClass: "auth"
  }),
  testServerCredential: defineOperation({
    ...testOperation,
    id: "testServerCredential",
    method: "POST",
    path: "/test/server-credential",
    auth: "serverCredential",
    effect: "changing",
    response: testResult
  }),
  testUser: defineOperation({
    ...testOperation,
    ...testAccess,
    id: "testUser",
    method: "GET",
    path: "/test/user",
    effect: "reading",
    response: testResult
  }),
  testPrincipal: defineOperation({
    ...testOperation,
    id: "testPrincipal",
    method: "GET",
    path: "/test/principal",
    auth: "principal",
    scope: "governance:read",
    requires: ["audit.view", "usage.view"],
    effect: "reading",
    response: testResult
  }),
  /** Reads through POST, as an operation with a large input does. */
  testReadingPost: defineOperation({
    ...testOperation,
    ...testAccess,
    id: "testReadingPost",
    method: "POST",
    path: "/test/reading-post",
    effect: "reading",
    response: testResult
  }),
  testInput: defineOperation({
    ...testOperation,
    auth: "user",
    scope: "conversation:write",
    requires: ["users.manage"],
    id: "testInput",
    method: "POST",
    path: "/test/items/:itemId",
    effect: "changing",
    query: z.object({ view: z.enum(["full", "short"]).optional() }),
    body: z.object({ count: z.number().int() }),
    response: json(z.object({ itemId: z.string(), view: z.string().optional(), count: z.number() }))
  }),
  /** Returns what the `result` query names, so one route shows every kind of response. */
  testResponse: defineOperation({
    ...testOperation,
    ...testAccess,
    id: "testResponse",
    method: "GET",
    path: "/test/response",
    effect: "reading",
    query: z.object({ result: z.string().optional() }),
    response: testResult
  }),
  testIdentity: defineOperation({
    ...testIdentityOperation,
    id: "testIdentity",
    method: "GET",
    effect: "reading"
  }),
  testIdentityWrite: defineOperation({
    ...testIdentityOperation,
    id: "testIdentityWrite",
    method: "POST",
    effect: "changing"
  })
};

/** Operations a test registers in the operation registry to exercise its HTTP face. */
const registeredTestOperation = {
  summary: "Operation registry fixture",
  tag: "Test",
  auth: "principal",
  errors: [],
  rateClass: "read"
} as const;
export const registeredTestOperations = {
  testRunRead: defineRegisteredOperation({
    ...registeredTestOperation,
    id: "testRunRead",
    method: "GET",
    path: "/api/v1/test/operations/items/:itemId",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    query: z.object({ view: z.enum(["full", "short"]).optional() }),
    response: json(z.object({ itemId: z.string(), view: z.string().optional() }))
  }),
  testRunList: defineRegisteredOperation({
    ...registeredTestOperation,
    id: "testRunList",
    method: "GET",
    path: "/api/v1/test/operations/items",
    scope: "governance:read",
    requires: [],
    effect: "reading",
    query: listQuerySchema,
    response: page(
      z.object({ id: z.string(), createdAt: timestampSchema }),
      ["createdAt", "id"],
      true
    )
  }),
  /** Does what `mode` names, so one operation shows every way a changing call can end. */
  testRunChange: defineRegisteredOperation({
    ...registeredTestOperation,
    id: "testRunChange",
    method: "POST",
    path: "/api/v1/test/operations/items",
    scope: "governance:write",
    requires: ["users.manage"],
    effect: "changing",
    body: z.object({
      name: z.string().min(1),
      mode: z.enum(["ok", "not-found", "throw", "large", "gated", "own-right"]).default("ok")
    }),
    response: json(z.object({ name: z.string(), filler: z.string().optional() })),
    errors: ["NOT_FOUND"]
  })
};

/**
 * An operation that requires no right although its type says it requires one. The types
 * refuse to register an unchecked operation, so a test of the same refusal at startup has to
 * hide the empty list from them.
 */
export function createUncheckedTestOperation() {
  const requires: ["audit.view"] = ["audit.view"];
  requires.pop();
  return defineRegisteredOperation({
    ...registeredTestOperation,
    id: "testRunUnchecked",
    method: "GET",
    path: "/api/v1/test/operations/unchecked",
    scope: "governance:read",
    requires,
    effect: "reading",
    response: json(z.object({ value: z.string() }))
  });
}

export const testOperations = {
  legacyDevelopmentUsers: fixtureOperation("GET", "/auth/development/users"),
  ...apiOperations,
  authSignIn: fixtureOperation("POST", "/api/auth/sign-in/email"),
  authSignUp: fixtureOperation("POST", "/api/auth/sign-up/email"),
  authSession: fixtureOperation("GET", "/api/auth/get-session"),
  authSignOut: fixtureOperation("POST", "/api/auth/sign-out"),
  legacyChat: fixtureOperation("POST", "/api/chat"),
  testIp: fixtureOperation("GET", "/test/ip"),
  testStream: fixtureOperation("GET", "/stream"),
  ...routeTestOperations,
  ...registeredTestOperations,
  testProviderError: fixtureOperation("GET", "/test-provider-error"),
  testInternalError: fixtureOperation("GET", "/test-internal-error"),
  testExposedError: fixtureOperation("GET", "/test-exposed-error"),
  testValidationError: fixtureOperation("GET", "/test-validation-error"),
  documentExtract: fixtureOperation("POST", "/internal/document-extraction/extract"),
  documentPages: fixtureOperation("POST", "/internal/document-pages/render"),
  testHidden: fixtureOperation("GET", "/test-hidden"),
  testUnknown: fixtureOperation("GET", "/test-unknown"),
  testExposed: fixtureOperation("GET", "/test-exposed")
};
export type TestOperationName = keyof typeof testOperations;
export type TestCallInput = BuildApiPathOptions & {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
  payload?: unknown;
};

export interface TestRequest {
  operation: TestOperationName;
  input: TestCallInput;
}
export function testRequest(operation: TestOperationName, input: TestCallInput = {}): TestRequest {
  return { operation, input };
}

export function openApiJsonOperation(operation: keyof typeof apiOperations): {
  requestBody: { content: { "application/json": { schema: { required?: string[] } } } };
  responses: Record<
    string,
    { content: { "application/json": { schema: { required?: string[] } } } }
  >;
} {
  const descriptor = apiOperations[operation];
  const path = descriptor.path.replaceAll(/:([A-Za-z][\w]*)/gu, "{$1}");
  const document = createOpenApiDocument();
  // A named schema stands in the document as a reference; a test reads the schema itself.
  const resolved: unknown = JSON.parse(
    JSON.stringify(document.paths[path]?.[descriptor.method.toLowerCase()]),
    (_key, value: unknown) => {
      const reference = z.object({ $ref: z.string() }).safeParse(value);
      if (!reference.success) return value;
      const name = reference.data.$ref.split("/").at(-1) ?? "";
      // An error answer is a shared response of the document; a test here reads successes.
      return reference.data.$ref.includes("/schemas/")
        ? document.components.schemas[name]
        : undefined;
    }
  );
  return openApiJsonOperationSchema.parse(resolved);
}

const jsonContentSchema = z.object({
  content: z.object({
    "application/json": z.object({
      schema: z.looseObject({ required: z.array(z.string()).optional() })
    })
  })
});
const openApiJsonOperationSchema = z.object({
  requestBody: jsonContentSchema,
  responses: z.record(z.string(), jsonContentSchema)
});

// Fixed expectations remain independent of the path builder under test.
export const contractPathFixtures = {
  workspaces: "/api/v1/workspaces",
  agentAvailability: "/api/v1/instance/config/agents/kai/availability",
  adminWorkspaces: "/api/v1/instance/workspaces",
  workspaceAgents: "/api/v1/workspaces/cws_1/agents?locale=de",
  moveConversation: "/api/v1/conversations/{conversationId}/move",
  encodedMessages: "/api/v1/conversations/conversation%201%2F2/messages",
  localizedConfig: "/api/v1/instance/config?locale=de",
  encodedWorkspaceConversations: "/api/v1/conversations?collaborationWorkspaceId=workspace%2Fone",
  conversations: "/api/v1/conversations",
  exampleTemplate: "/api/example/:exampleId",
  exampleValue: "/api/example/value%2Fwith%20spaces?view=full",
  retiredChat: "/api/chat"
};
