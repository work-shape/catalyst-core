import type { OperationEffect, OperationScope, PlatformAction } from "@vivd-catalyst/core";
import { listEnvelopeSchema } from "../shared";
import type { z } from "zod";
import type { ApiErrorCode } from "../errors";

/** Every product operation's path starts here; `/health` is the one unversioned operation. */
export const API_VERSION_PREFIX = "/api/v1";

export type OperationMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Who may call an operation. `user` accepts a person's credential and refuses service
 * principals, `principal` accepts both, `serverCredential` accepts the instance's server
 * credential, and `public` authenticates nobody.
 */
export type OperationAuth = "public" | "user" | "principal" | "serverCredential";

/** The limiter bucket an operation counts against. */
export type OperationRateClass = "read" | "write" | "auth";

export type OperationResponse =
  | { readonly kind: "json"; readonly schema: z.ZodType }
  | {
      readonly kind: "page";
      readonly schema: z.ZodType;
      readonly order: readonly string[];
      readonly descending: boolean;
    }
  | { readonly kind: "sse"; readonly schema: z.ZodType }
  | { readonly kind: "blob"; readonly contentType: string };

export function json<Schema extends z.ZodType>(schema: Schema) {
  return { kind: "json", schema } as const;
}

/** List handlers return store rows; the helper owns the sole wire envelope. */
export function page<Schema extends z.ZodType>(
  schema: Schema,
  order: readonly string[],
  descending = false
) {
  return { kind: "page", schema: listEnvelopeSchema(schema), order, descending } as const;
}

/** A stream of server-sent events whose `data` is one value of `schema`. */
export function sse<Schema extends z.ZodType>(schema: Schema) {
  return { kind: "sse", schema } as const;
}

/** A body the handler sends itself: a file, or a page. */
export function blob(contentType = "application/octet-stream") {
  return { kind: "blob", contentType } as const;
}

export type OperationQuerySchema = z.ZodObject<Record<string, z.ZodType>>;

type OperationAccess =
  | {
      readonly auth: "serverCredential";
      readonly scope?: never;
      readonly requires?: never;
      readonly credential?: never;
    }
  | {
      readonly auth: "public";
      readonly scope?: never;
      readonly requires?: never;
      /** The credential the handler reads and authenticates itself; the route helper does not. */
      readonly credential?: "apiKey";
    }
  | {
      readonly auth: "user" | "principal";
      /** The one credential scope the caller's credential must carry; `null` asks for none. */
      readonly scope: OperationScope | null;
      readonly credential?: never;
      /** Actions the holder must be allowed at instance level, all of them. */
      readonly requires: readonly PlatformAction[];
    };

export type OperationConfig = OperationAccess & {
  /** Catalog key, OpenAPI operationId and client method name. */
  readonly id: string;
  readonly method: OperationMethod;
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  readonly effect: OperationEffect;
  readonly query?: OperationQuerySchema;
  readonly body?: z.ZodType;
  /** The request is a multipart upload with one `file` part instead of a JSON body. */
  readonly multipart?: true;
  readonly response: OperationResponse;
  /** Error codes beyond the common set every operation can answer with. */
  readonly errors: readonly ApiErrorCode[];
  readonly rateClass: OperationRateClass;
  /** Registered only on development instances and absent from the released document. */
  readonly devOnly?: true;
};

export interface BuildApiPathOptions {
  params?: Record<string, string | number | boolean>;
  query?: Record<string, string | number | boolean | undefined>;
}

export type Operation<Config extends OperationConfig = OperationConfig> = Config & {
  readonly buildPath: (options?: BuildApiPathOptions) => string;
};

/** The error codes any operation can answer with, whatever it declares. */
export const COMMON_OPERATION_ERRORS = [
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "INTERNAL"
] as const satisfies readonly ApiErrorCode[];

export function defineOperation<const Config extends OperationConfig>(
  config: Config
): Operation<Config> {
  return {
    ...config,
    buildPath: (options) =>
      buildPath(config.path, config.query ? Object.keys(config.query.shape) : [], options)
  };
}

/** The names of the `:param` segments of a path template, as a union. */
export type OperationPathParamName<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | OperationPathParamName<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

export function operationPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM), (match) => match[1] ?? "");
}

const PATH_PARAM = /:([A-Za-z][A-Za-z0-9_]*)/gu;

/** Fills a path template without knowing which query parameters its operation declares. */
export function buildApiPath(pathTemplate: string, options: BuildApiPathOptions = {}): string {
  return buildPath(pathTemplate, undefined, options);
}

function buildPath(
  pathTemplate: string,
  queryParamNames: readonly string[] | undefined,
  options: BuildApiPathOptions = {}
): string {
  const params = options.params ?? {};
  const consumedParams = new Set<string>();
  const path = pathTemplate.replaceAll(PATH_PARAM, (_match, name: string) => {
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
    if (queryParamNames && !queryParamNames.includes(name)) {
      throw new Error(`Unknown query parameter "${name}" for "${pathTemplate}"`);
    }
    query.append(name, String(value));
  }

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}
