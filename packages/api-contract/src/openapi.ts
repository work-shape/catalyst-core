import { z } from "zod";
import type { ApiOperation, JsonApiOperation } from "./http-operation";

export interface OpenApiDocumentOptions {
  title?: string;
  version?: string;
}

export type ApiOperationCatalog = Record<string, ApiOperation>;

type OpenApiSchema = Record<string, unknown>;
type OpenApiParameter = {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema: OpenApiSchema;
};
type OpenApiPathItem = Record<string, unknown>;

export function createOpenApiDocumentFromOperations(
  operations: ApiOperationCatalog,
  options: OpenApiDocumentOptions = {}
) {
  const paths: Record<string, OpenApiPathItem> = {};

  for (const operation of Object.values(operations)) {
    const path = toOpenApiPath(operation.path);
    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = createOpenApiOperation(operation);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title ?? "Vivd Catalyst API",
      version: options.version ?? "0.1.0"
    },
    paths
  } as const;
}

function createOpenApiOperation(operation: ApiOperation) {
  return {
    operationId: operation.operationId,
    ...createParameters(operation),
    ...(operation.responseKind === "json" ? createJsonRequestBody(operation) : {}),
    ...createResponse(operation)
  };
}

function createParameters(operation: ApiOperation): { parameters: OpenApiParameter[] } {
  const parameters: OpenApiParameter[] = [
    ...pathParamNames(operation.path).map((name) => ({
      name,
      in: "path" as const,
      required: true,
      schema: { type: "string" }
    })),
    ...(operation.queryParams ?? []).map((name) => ({
      name,
      in: "query" as const,
      required: false,
      schema: { type: "string" }
    }))
  ];

  return { parameters };
}

function createJsonRequestBody(operation: JsonApiOperation) {
  if (operation.requestKind === "json" && operation.requestSchema) {
    return {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: toOpenApiSchema(operation.requestSchema)
          }
        }
      }
    };
  }

  if (operation.requestKind === "multipart") {
    return {
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                file: {
                  type: "string",
                  format: "binary"
                }
              },
              required: ["file"]
            }
          }
        }
      }
    };
  }

  return {};
}

function createResponse(operation: ApiOperation) {
  if (operation.responseKind === "blob") {
    return {
      responses: {
        "200": {
          description: "Binary response",
          content: {
            "application/octet-stream": {
              schema: {
                type: "string",
                format: "binary"
              }
            }
          }
        }
      }
    };
  }

  return {
    responses: {
      "200": {
        description: "Successful response",
        content: {
          "application/json": {
            schema: toOpenApiSchema(operation.responseSchema)
          }
        }
      }
    }
  };
}

function toOpenApiSchema(schema: z.ZodType): OpenApiSchema {
  const jsonSchema = z.toJSONSchema(schema) as OpenApiSchema;
  const { $schema: _schema, ...openApiSchema } = jsonSchema;
  return openApiSchema;
}

function toOpenApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}

function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/gu), (match) => match[1] ?? "");
}
