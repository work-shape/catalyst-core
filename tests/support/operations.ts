import { z } from "zod";
import {
  apiOperations,
  createOpenApiDocument,
  buildApiPath,
  type BuildApiPathOptions
} from "@vivd-catalyst/api-contract";

// Mounts and fixture routes absent from the product catalog stay behind test support until CB-4.
const fixtureOperation = (method: "GET" | "POST", path: string) => ({
  method,
  path,
  buildPath: (input?: BuildApiPathOptions) => buildApiPath(path, input)
});
export const testOperations = {
  legacyDevelopmentUsers: fixtureOperation("GET", "/auth/development/users"),
  legacyIssueSessionToken: fixtureOperation("POST", "/auth/session-token"),
  ...apiOperations,
  health: fixtureOperation("GET", "/health"),
  capturedMail: fixtureOperation("GET", "/api/dev/captured-mail"),
  authSignIn: fixtureOperation("POST", "/api/auth/sign-in/email"),
  authSignUp: fixtureOperation("POST", "/api/auth/sign-up/email"),
  authSession: fixtureOperation("GET", "/api/auth/get-session"),
  authSignOut: fixtureOperation("POST", "/api/auth/sign-out"),
  legacyChat: fixtureOperation("POST", "/api/chat"),
  testIp: fixtureOperation("GET", "/test/ip"),
  testStream: fixtureOperation("GET", "/stream"),
  testIdentity: fixtureOperation("GET", "/identity"),
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
  workspaces: "/api/collaboration-workspaces",
  agentAvailability: "/api/admin/config/agents/kai/availability",
  adminWorkspaces: "/api/admin/collaboration-workspaces",
  workspaceAgents: "/api/collaboration-workspaces/cws_1/agents?locale=de",
  moveConversation: "/api/conversations/{conversationId}/move",
  encodedMessages: "/api/conversations/conversation%201%2F2/messages",
  localizedConfig: "/api/config?locale=de",
  encodedWorkspaceConversations: "/api/conversations?collaborationWorkspaceId=workspace%2Fone",
  conversations: "/api/conversations",
  exampleTemplate: "/api/example/:exampleId",
  exampleValue: "/api/example/value%2Fwith%20spaces?view=full",
  retiredChat: "/api/chat"
};
