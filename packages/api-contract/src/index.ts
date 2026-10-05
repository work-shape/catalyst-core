import { apiOperations } from "./api-operations";
import { createOpenApiDocumentFromOperations } from "./openapi";

export * from "./api-operations";
export * from "./configuration";
export * from "./collaboration-workspaces";
export * from "./conversations";
export * from "./errors";
export * from "./governance";
export * from "./http-operation";
export * from "./identity";
export * from "./openapi";

export function createOpenApiDocument() {
  return createOpenApiDocumentFromOperations(apiOperations);
}

export const openApiDocument = createOpenApiDocument();

export type ApiOperationName = keyof typeof apiOperations;
export * from "./approval-requests";
