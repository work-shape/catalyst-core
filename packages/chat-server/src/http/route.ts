import { paginate, pageScope, storePage } from "./paging";
import { timingSafeEqual } from "node:crypto";
import {
  operationPathParamNames,
  type Operation,
  type OperationPathParamName
} from "@vivd-catalyst/api-contract";
import { hasExplicitCredentials } from "@vivd-catalyst/auth";
import {
  AppError,
  authContextFromUser,
  createPlatformId,
  isAuthenticatedServicePrincipal,
  legacyPermissionFor,
  normalizeAuthenticatedUser,
  requireAuthScope,
  requirePermission,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ClientInstanceId,
  type StorePage,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChatServerOptions } from "../types";

type RouteServerOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "authAdapter" | "allowedOrigins" | "sessionToken" | "config" | "logger"
>;

/** What a handler knows about a call whose caller is not a signed-in user. */
interface RequestContext {
  clientInstanceId: ClientInstanceId;
  correlationId: string;
}

type Caller<Auth extends Operation["auth"]> = Auth extends "user"
  ? { user: AuthenticatedUser; context: RuntimeCallContext }
  : Auth extends "principal"
    ? { identity: AuthenticatedIdentity; context: RequestContext }
    : { context: RequestContext };

type Parsed<Schema> = Schema extends z.ZodType ? z.output<Schema> : undefined;

export type RouteCall<Op extends Operation> = Caller<Op["auth"]> & {
  params: Record<OperationPathParamName<Op["path"]>, string>;
  query: Parsed<Op["query"]>;
  body: Parsed<Op["body"]>;
  /** For what the descriptor does not carry: headers, the upload stream, the request log. */
  paging: StorePage | undefined;
  request: FastifyRequest;
  reply: FastifyReply;
};

/**
 * The shape a response schema accepts, with every set of literal values widened to its
 * primitive. The compiler checks structure and optionality against it. Value sets, where the
 * product's own types are wider than the contract's, are checked on every call at run time.
 */
type ResponseShape<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
      : Value extends readonly (infer Item)[]
        ? ResponseShape<Item>[]
        : Value extends object
          ? { [Key in keyof Value]: ResponseShape<Value[Key]> }
          : Value;

/** A JSON operation returns its payload; a stream or a file is sent by the handler itself. */
type RouteResult<Op extends Operation> = Op["response"] extends {
  kind: "json";
  schema: infer Schema extends z.ZodType;
}
  ? ResponseShape<z.input<Schema>>
  : Op["response"] extends { kind: "page"; schema: infer Schema extends z.ZodType }
    ? z.input<Schema> extends { items: infer Items }
      ? ResponseShape<Items>
      : never
    : FastifyReply;

type RouteHandler<Op extends Operation> = (
  call: RouteCall<Op>
) => RouteResult<Op> | Promise<RouteResult<Op>>;

export interface Route {
  <const Op extends Operation>(operation: Op, handler: RouteHandler<Op>): void;
  /** Every operation registered on this server so far, through whichever helper. */
  readonly registered: readonly Operation[];
}

const registeredOperations = new WeakMap<FastifyInstance, Operation[]>();

/** The call as the helper assembles it, before the registration's types narrow it. */
interface AssembledCall {
  user?: AuthenticatedUser;
  identity?: AuthenticatedIdentity;
  context: RequestContext | RuntimeCallContext;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  paging: StorePage | undefined;
  request: FastifyRequest;
  reply: FastifyReply;
}

/**
 * The one place a product route is registered. For every call it authenticates as the
 * operation's `auth` says, checks the credential's `scope`, parses query and body, checks the
 * holder's rights for every action in `requires`, runs the handler and validates what it returns.
 */
export function createRoute(app: FastifyInstance, options: RouteServerOptions): Route {
  const registered = registeredOperations.get(app) ?? [];
  registeredOperations.set(app, registered);
  // The overload is what a route module sees: its handler is typed from its operation. The
  // implementation serves every operation with one body, and what it hands the handler is
  // what the operation's schemas parsed at run time.
  function route<const Op extends Operation>(operation: Op, handler: RouteHandler<Op>): void;
  function route(operation: Operation, handler: (call: AssembledCall) => unknown): void {
    registered.push(operation);
    app.route({
      method: operation.method,
      url: operation.path,
      handler: async (request, reply) => {
        const correlationId = createCorrelationId(request);
        void reply.header("x-correlation-id", correlationId);
        const caller = await authenticate(options, operation, request, correlationId);
        if (caller.identity && operation.scope) {
          requireAuthScope(caller.identity, operation.scope);
        }
        const query = parseInput(operation.query, request.query, "Request query is invalid");
        const body = parseInput(operation.body, request.body ?? {}, "Request body is invalid");
        if (caller.identity) {
          for (const action of operation.requires ?? []) {
            // AP-1 replaces this line with `access.require(action)`.
            requirePermission(caller.identity, legacyPermissionFor(action));
          }
        }
        const params = readPathParams(operation, request.params);
        const paging =
          operation.response.kind === "page"
            ? storePage(query, operation.response.order, pageScope(operation.id, params, query))
            : undefined;
        const result = await handler({
          ...caller,
          params,
          paging,
          query,
          body,
          request,
          reply
        });
        if (operation.response.kind === "page") {
          const resultPage = paginate(
            z.array(z.unknown()).parse(result),
            query,
            operation.response.order,
            operation.response.descending,
            pageScope(operation.id, params, query)
          );
          checkResponse(options, operation, operation.response.schema, resultPage);
          return resultPage;
        }
        if (operation.response.kind === "json") {
          checkResponse(options, operation, operation.response.schema, result);
        }
        return result;
      }
    });
  }
  return Object.assign(route, { registered });
}

async function authenticate(
  options: RouteServerOptions,
  operation: Operation,
  request: FastifyRequest,
  correlationId: string
): Promise<Pick<AssembledCall, "user" | "identity" | "context">> {
  const context: RequestContext = { clientInstanceId: options.clientInstanceId, correlationId };
  switch (operation.auth) {
    case "public":
      return { context };
    case "serverCredential":
      requireServerCredential(options, request);
      return { context };
    case "principal": {
      const authenticated = await authenticateIdentity(options, request, correlationId);
      return {
        identity: isAuthenticatedServicePrincipal(authenticated)
          ? authenticated
          : normalizeAuthenticatedUser(authenticated),
        context
      };
    }
    case "user": {
      const authenticated = await authenticateIdentity(options, request, correlationId);
      if (isAuthenticatedServicePrincipal(authenticated)) {
        throw new AppError("FORBIDDEN", "Service principals cannot access user-scoped routes");
      }
      const user = normalizeAuthenticatedUser(authenticated);
      return {
        user,
        identity: user,
        context: { ...context, user, ...authContextFromUser(user) }
      };
    }
  }
}

async function authenticateIdentity(
  options: RouteServerOptions,
  request: FastifyRequest,
  correlationId: string
): Promise<AuthenticatedIdentity> {
  if (
    hasExplicitCredentials(request.headers) &&
    options.authAdapter.credentialMode !== "explicit"
  ) {
    throw new AppError("UNAUTHENTICATED", "Auth adapter does not accept explicit credentials");
  }
  const identity = await options.authAdapter.authenticate({
    headers: request.headers,
    clientInstanceId: options.clientInstanceId,
    correlationId
  });
  // Keyed on the HTTP method, not on the operation's effect: a reading operation served by
  // POST is guarded too.
  if (
    !isAuthenticatedServicePrincipal(identity) &&
    identity.authenticationMethod === "session-cookie" &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method)
  ) {
    const origin = request.headers.origin;
    const allowed =
      origin !== undefined
        ? origin === new URL(`${request.protocol}://${request.host}`).origin ||
          (options.allowedOrigins ?? []).includes(origin)
        : request.headers["sec-fetch-site"] === "same-origin";
    if (!allowed) {
      throw new AppError("FORBIDDEN", "Session request origin is not allowed");
    }
  }
  return identity;
}

/** The instance's one server credential is the one that issues session tokens. */
function requireServerCredential(options: RouteServerOptions, request: FastifyRequest): void {
  if (!options.sessionToken) {
    throw new AppError("NOT_FOUND", "Session token issuing is not configured");
  }
  const credential = request.headers["x-server-credential"];
  if (
    typeof credential !== "string" ||
    !safeEqual(credential, options.sessionToken.serverCredential)
  ) {
    throw new AppError("FORBIDDEN", "Invalid server credential");
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createCorrelationId(request: FastifyRequest): string {
  const existing = request.headers["x-correlation-id"];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  return createPlatformId("corr");
}

function parseInput(schema: z.ZodType | undefined, value: unknown, message: string): unknown {
  if (!schema) {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", message, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function readPathParams(operation: Operation, params: unknown): Record<string, string> {
  const values = new Map(
    typeof params === "object" && params !== null ? Object.entries(params) : []
  );
  return Object.fromEntries(
    operationPathParamNames(operation.path).map((name) => {
      const value: unknown = values.get(name);
      if (typeof value !== "string") {
        throw new AppError("INTERNAL", `Route '${operation.id}' matched without '${name}'`);
      }
      return [name, value];
    })
  );
}

/**
 * A response outside its contract is always logged. Only a development instance refuses it:
 * the handler has already committed its work by now, and one stored value outside an enum
 * would otherwise fail a whole list for the people using an operated instance.
 */
function checkResponse(
  options: RouteServerOptions,
  operation: Operation,
  schema: z.ZodType,
  result: unknown
): void {
  const validated = schema.safeParse(result);
  if (validated.success) {
    return;
  }
  // Paths and codes only: the values are the payload the schema refused.
  options.logger.error(
    {
      operationId: operation.id,
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code
      }))
    },
    "Operation response does not match its schema"
  );
  if (options.config.clientInstance.environment === "development") {
    throw new AppError("INTERNAL", `Operation '${operation.id}' returned an invalid response`);
  }
}
