import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  type OperationEffect,
  type OperationScope,
  type PlatformAction
} from "@vivd-catalyst/core";
import { operationRunSchema } from "../operation-runs";
import { listEnvelopeSchema } from "../shared";
import type { z } from "zod";
import type { ApiErrorCode } from "../errors";

/**
 * Every product operation's path starts here. The probes `/health` and `/ready` and the view
 * runtime files are the unversioned operations.
 */
export const API_VERSION_PREFIX = "/api/v1";

export type OperationMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/**
 * Who may call an operation. `user` accepts a person's credential and refuses service
 * principals, `principal` accepts both, `serverCredential` accepts the instance's server
 * credential, and `public` authenticates nobody.
 */
export type OperationAuth = "public" | "user" | "principal" | "serverCredential";

/**
 * The limit an operation's calls are counted against. A call is counted per operation and per
 * caller: the signed-in person or service where the operation authenticates one, the client
 * address where it does not. `auth` marks an operation that takes a password, a key or a
 * token: it is counted per account being tried, with a high cap per address alone. The
 * numbers are the instance's, set in its release config under `rateLimits`. A caller over a
 * limit receives 429 `RATE_LIMITED` with `details.retryAfterSeconds` and the same number in
 * the `Retry-After` header.
 */
export type OperationRateClass = "read" | "write" | "auth";

export type OperationResponse =
  | {
      readonly kind: "json";
      readonly schema: z.ZodType;
      /** What the operation answers with status 503 in place of its result. */
      readonly unavailable?: z.ZodType;
    }
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

/**
 * The answer of a probe: `schema` with status 200 while the instance can serve, `unavailable`
 * with status 503 while it cannot. The handler returns either value and the route helper sets
 * the status, so a proxy reads the status alone.
 */
export function probe<Schema extends z.ZodType, Unavailable extends z.ZodType>(
  schema: Schema,
  unavailable: Unavailable
) {
  return { kind: "json", schema, unavailable } as const;
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

/**
 * The headers of the contract beyond the common ones, each with what it tells. The document
 * declares each once, and an operation names the ones it takes and sets.
 */
export const OPERATION_HEADERS = {
  request: {
    "Idempotency-Key": `A key the caller chooses for one changing call, up to ${IDEMPOTENCY_KEY_MAX_LENGTH} characters. The same key with the same input answers what the first call answered instead of acting twice. A key belongs to its caller: another caller's same key is another call.`
  },
  response: {
    "Operation-Run-Id":
      "The id of the Operation Run that records this call. Set on every answer of a call that got as far as a run, a refusal and a failure included.",
    Location: "Where the Operation Run of a call that waits for an approval is read.",
    "Idempotent-Replayed":
      "`true` when the answer is the recorded one of an earlier call with the same `Idempotency-Key`."
  }
} as const;

export type OperationRequestHeader = keyof typeof OPERATION_HEADERS.request;
export type OperationResponseHeader = keyof typeof OPERATION_HEADERS.response;

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
  /**
   * A second success answer, `202 Accepted`: the call waits for somebody else, and this is
   * what it answers meanwhile.
   */
  readonly accepted?: z.ZodType;
  /** The headers of `OPERATION_HEADERS` the operation takes and sets. */
  readonly headers?: {
    readonly request?: readonly OperationRequestHeader[];
    readonly response?: readonly OperationResponseHeader[];
  };
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

/** What an operation of the registry leaves to `defineRegisteredOperation`. */
type RegisteredOperationConfig = OperationConfig & {
  readonly auth: "user" | "principal";
  readonly response: { readonly kind: "json" | "page" };
  readonly accepted?: never;
  readonly headers?: never;
};

const REGISTERED_READING = {
  headers: { response: ["Operation-Run-Id"] }
} as const;

const REGISTERED_CHANGING = {
  accepted: operationRunSchema,
  headers: {
    request: ["Idempotency-Key"],
    response: ["Operation-Run-Id", "Location", "Idempotent-Replayed"]
  }
} as const;

/** The error codes the policy of an instance adds to every operation of the registry. */
const REGISTERED_ERRORS = ["POLICY_DENIED", "GUARDRAIL_BLOCKED"] as const;
/** The error codes a changing operation of the registry adds for approvals and repeated calls. */
const REGISTERED_CHANGING_ERRORS = [
  "DECLINED",
  "IDEMPOTENCY_KEY_REUSED",
  "OPERATION_IN_PROGRESS",
  "OPERATION_EXPIRED",
  "OUTPUT_NOT_RETAINED"
] as const;

/**
 * An operation of the registry: every call of it is an Operation Run, named by the header
 * `Operation-Run-Id`. A reading one answers its output or an error. A changing one takes an
 * `Idempotency-Key` and can also answer `202` with the run while it waits for an approval.
 */
export function defineRegisteredOperation<
  const Config extends RegisteredOperationConfig & { readonly effect: "reading" }
>(config: Config): Operation<Config & typeof REGISTERED_READING>;
export function defineRegisteredOperation<
  const Config extends RegisteredOperationConfig & { readonly effect: "changing" }
>(config: Config): Operation<Config & typeof REGISTERED_CHANGING>;
export function defineRegisteredOperation(config: RegisteredOperationConfig): Operation {
  return defineOperation({
    ...config,
    ...(config.effect === "changing" ? REGISTERED_CHANGING : REGISTERED_READING),
    errors: [
      ...config.errors,
      ...REGISTERED_ERRORS,
      ...(config.effect === "changing" ? REGISTERED_CHANGING_ERRORS : [])
    ]
  });
}

/** Whether every call of the operation is an Operation Run. */
export function isRegisteredOperation(operation: Operation): boolean {
  return operation.headers?.response?.includes("Operation-Run-Id") ?? false;
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
