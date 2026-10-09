import { z } from "zod";
import {
  API_VERSION_PREFIX,
  operationPathParamNames,
  type Operation
} from "./operations/define-operation";

export interface OpenApiDocumentOptions {
  title?: string;
  version?: string;
}

export type ApiOperationCatalog = Record<string, Operation>;

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
    // The document describes the versioned API. The unversioned health probe and operations
    // of development instances are registered without being part of it.
    if (operation.devOnly || !operation.path.startsWith(`${API_VERSION_PREFIX}/`)) {
      continue;
    }
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

function createOpenApiOperation(operation: Operation) {
  return {
    operationId: operation.id,
    ...createParameters(operation),
    ...createRequestBody(operation),
    ...createResponse(operation)
  };
}

// Query constraints include the list limit default and maximum from the sole schema.
function createParameters(operation: Operation): { parameters: OpenApiParameter[] } {
  const parameters: OpenApiParameter[] = [
    ...operationPathParamNames(operation.path).map((name) => ({
      name,
      in: "path" as const,
      required: true,
      schema: { type: "string" }
    })),
    ...Object.entries(operation.query?.shape ?? {}).map(([name, schema]) => ({
      name,
      in: "query" as const,
      required: !schema.safeParse(undefined).success,
      schema: toOpenApiSchema(schema)
    }))
  ];

  return { parameters };
}

function createRequestBody(operation: Operation) {
  if (operation.body) {
    return {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: toOpenApiSchema(operation.body)
          }
        }
      }
    };
  }

  if (operation.multipart) {
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

// An event stream is documented by the schema of one event until CB-5 owns the document.
function createResponse(operation: Operation) {
  if (operation.response.kind === "blob") {
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
            schema: toOpenApiSchema(operation.response.schema)
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
