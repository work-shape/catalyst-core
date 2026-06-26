import type { z } from "zod";

export type ApiHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type ApiRequestKind = "none" | "json" | "multipart";
export type ApiPathParamValue = string | number | boolean;
export type ApiQueryParamValue = string | number | boolean | undefined;

export interface BuildApiPathOptions {
  params?: Record<string, ApiPathParamValue>;
  query?: Record<string, ApiQueryParamValue>;
}

export interface ApiOperationBase {
  readonly operationId: string;
  readonly method: ApiHttpMethod;
  readonly path: string;
  readonly requestKind: ApiRequestKind;
  readonly queryParams?: readonly string[];
  readonly buildPath: (options?: BuildApiPathOptions) => string;
}

export type JsonApiOperationWithoutRequest<ResponseSchema extends z.ZodType = z.ZodType> =
  ApiOperationBase & {
    readonly responseKind: "json";
    readonly responseSchema: ResponseSchema;
    readonly requestSchema?: undefined;
  };

export type JsonApiOperationWithRequest<
  RequestSchema extends z.ZodType = z.ZodType,
  ResponseSchema extends z.ZodType = z.ZodType
> = ApiOperationBase & {
  readonly responseKind: "json";
  readonly requestSchema: RequestSchema;
  readonly responseSchema: ResponseSchema;
};

export type JsonApiOperation =
  | JsonApiOperationWithoutRequest
  | JsonApiOperationWithRequest;

export type BlobApiOperation = ApiOperationBase & {
  readonly responseKind: "blob";
};

export type ApiOperation = JsonApiOperation | BlobApiOperation;

type JsonApiOperationConfigBase = {
  operationId: string;
  method: ApiHttpMethod;
  path: string;
  queryParams?: readonly string[];
};

export function defineJsonApiOperation<ResponseSchema extends z.ZodType>(
  config: JsonApiOperationConfigBase & {
    requestKind?: Exclude<ApiRequestKind, "json">;
    responseSchema: ResponseSchema;
  }
): JsonApiOperationWithoutRequest<ResponseSchema>;
export function defineJsonApiOperation<
  RequestSchema extends z.ZodType,
  ResponseSchema extends z.ZodType
>(
  config: JsonApiOperationConfigBase & {
    requestKind?: never;
    requestSchema: RequestSchema;
    responseSchema: ResponseSchema;
  }
): JsonApiOperationWithRequest<RequestSchema, ResponseSchema>;
export function defineJsonApiOperation(
  config: JsonApiOperationConfigBase & {
    requestKind?: Exclude<ApiRequestKind, "json">;
    requestSchema?: z.ZodType;
    responseSchema: z.ZodType;
  }
): JsonApiOperation {
  return {
    ...config,
    requestKind: config.requestSchema ? "json" : config.requestKind ?? "none",
    responseKind: "json",
    buildPath: (options) => buildOperationPath(config.path, config.queryParams, options)
  } as JsonApiOperation;
}

export function defineBlobApiOperation(
  config: JsonApiOperationConfigBase
): BlobApiOperation {
  return {
    ...config,
    requestKind: "none",
    responseKind: "blob",
    buildPath: (options) => buildOperationPath(config.path, config.queryParams, options)
  };
}

export function buildApiPath(pathTemplate: string, options: BuildApiPathOptions = {}): string {
  return buildOperationPath(pathTemplate, undefined, options);
}

function buildOperationPath(
  pathTemplate: string,
  allowedQueryParams: readonly string[] | undefined,
  options: BuildApiPathOptions = {}
): string {
  const params = options.params ?? {};
  const consumedParams = new Set<string>();
  const path = pathTemplate.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${name}" for "${pathTemplate}"`);
    }
    consumedParams.add(name);
    return encodeURIComponent(String(value));
  });

  for (const name of Object.keys(params)) {
    if (!consumedParams.has(name)) {
      throw new Error(`Unknown path parameter "${name}" for "${pathTemplate}"`);
    }
  }

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (allowedQueryParams && !allowedQueryParams.includes(name)) {
      throw new Error(`Unknown query parameter "${name}" for "${pathTemplate}"`);
    }
    query.append(name, String(value));
  }

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}
