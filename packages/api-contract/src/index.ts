import { apiOperations } from "./operations";
import { createOpenApiDocumentFromOperations } from "./openapi";

export * from "./approval-requests";
export * from "./collaboration-workspaces";
export * from "./configuration";
export * from "./conversations";
export * from "./errors";
export * from "./governance";
export * from "./identity";
export * from "./openapi";
export * from "./operations";
export * from "./operations/define-operation";
export * from "./system";

export function createOpenApiDocument() {
  return createOpenApiDocumentFromOperations(apiOperations);
}

export const openApiDocument = createOpenApiDocument();

export * from "./shared";
