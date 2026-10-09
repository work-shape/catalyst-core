import { z } from "zod";
import {
  apiOperations,
  createOpenApiDocument,
  buildApiPath,
  defineOperation,
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
  return openApiJsonOperationSchema.parse(document.paths[path]?.[descriptor.method.toLowerCase()]);
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
