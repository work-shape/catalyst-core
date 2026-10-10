import { checkResponse } from "./check-response";
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
  isAppError,
  isAuthenticatedServicePrincipal,
  normalizeAuthenticatedUser,
  requireAuthScope,
  requireOperationModuleOn,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ClientInstanceId,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationOrigin,
  type OperationResource,
  type StorePage,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createOperationFace,
  type AssembledOperationBinding,
  type OperationBindingContext
} from "../operations/operation-face";
import type { ResolvedChatServerOptions } from "../types";
import { accountTried, requireWithinLimit } from "./rate-limit";

type RouteServerOptions = Pick<
  ResolvedChatServerOptions,
  | "clientInstanceId"
  | "authAdapter"
  | "allowedOrigins"
  | "sessionToken"
  | "config"
  | "modules"
  | "logger"
  | "rateLimiter"
  | "stores"
  | "auditRecorder"
  | "authorizer"
  | "operations"
>;

/** What a handler knows about a call whose caller is not a signed-in user. */
interface RequestContext {
  clientInstanceId: ClientInstanceId;
  correlationId: string;
}

/**
 * `access` answers every rights check of this request for its caller. It is loaded once, when
 * the caller is known, and belongs to the request, never to the actor.
 */
type Caller<Auth extends Operation["auth"]> = Auth extends "user"
  ? { user: AuthenticatedUser; access: ActorAccess; context: RuntimeCallContext }
  : Auth extends "principal"
    ? { identity: AuthenticatedIdentity; access: ActorAccess; context: RequestContext }
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

/** What a probe returns while the instance cannot serve. */
type UnavailableResult<Response> = Response extends {
  unavailable: infer Unavailable extends z.ZodType;
}
  ? ResponseShape<z.input<Unavailable>>
  : never;

/** A JSON operation returns its payload; a stream or a file is sent by the handler itself. */
type RouteResult<Op extends Operation> = Op["response"] extends {
  kind: "json";
  schema: infer Schema extends z.ZodType;
}
  ? ResponseShape<z.input<Schema>> | UnavailableResult<Op["response"]>
  : Op["response"] extends { kind: "page"; schema: infer Schema extends z.ZodType }
    ? z.input<Schema> extends { items: infer Items }
      ? ResponseShape<Items>
      : never
    : FastifyReply;

/**
 * What the handler of an operation that declares `deferred` returns when the call was accepted
 * and its work finishes by itself: the helper answers `202` with no body.
 */
export const DEFERRED = Symbol("deferred");

type RouteAnswer<Op extends Operation> =
  RouteResult<Op> | (Op extends { deferred: true } ? typeof DEFERRED : never);

type RouteHandler<Op extends Operation> = (
  call: RouteCall<Op>
) => RouteAnswer<Op> | Promise<RouteAnswer<Op>>;

type InputPart<Schema> = Schema extends z.ZodType ? z.output<Schema> : unknown;

/** The one flat input of a registered operation: the fields of its body, query and path. */
type OperationInput<Op extends Operation> = InputPart<Op["body"]> &
  InputPart<Op["query"]> &
  Record<OperationPathParamName<Op["path"]>, string>;

/**
 * Who checks the caller's right. Where the descriptor requires one, the registry checks it.
 * Where it requires none, the registration must bring the check.
 */
type RightsCheck<Op extends Operation> = Op["requires"] extends readonly [unknown, ...unknown[]]
  ? { authorize?: never }
  : {
      authorize(
        input: OperationInput<Op>,
        context: OperationAuthorizeContext
      ): OperationAuthorization | Promise<OperationAuthorization>;
    };

/** What a registration adds to the descriptor: what the call touches and what it does. */
type OperationBinding<Op extends Operation> = Omit<
  AssembledOperationBinding,
  "resource" | "execute" | "authorize"
> &
  RightsCheck<Op> & {
    resource?(input: OperationInput<Op>): OperationResource | undefined;
    execute(
      input: OperationInput<Op>,
      context: OperationBindingContext
    ): RouteResult<Op> | Promise<RouteResult<Op>>;
  };

export interface Route {
  <const Op extends Operation>(operation: Op, handler: RouteHandler<Op>): void;
  /**
   * Registers an operation of the registry, defined with `defineRegisteredOperation`. Every
   * call of it runs through `runOperation` and is an Operation Run: the right in `requires`,
   * the policy and the guardrails are checked there, and the answer's status says how the run
   * went.
   */
  operation<const Op extends Operation>(operation: Op, binding: OperationBinding<Op>): void;
  /** Every operation registered on this server so far, through whichever helper. */
  readonly registered: readonly Operation[];
}

/** The status of a probe's `unavailable` answer: a proxy keeps the process out of rotation. */
const UNAVAILABLE_STATUS = 503;

const registeredOperations = new WeakMap<FastifyInstance, Operation[]>();

/** The call as the helper assembles it, before the registration's types narrow it. */
interface AssembledCall {
  user?: AuthenticatedUser;
  identity?: AuthenticatedIdentity;
  access?: ActorAccess;
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
 * operation's `auth` says, counts the call against the operation's rate class, checks the
 * credential's `scope`, parses query and body, checks the holder's rights for every action in
 * `requires`, runs the handler and validates what it returns.
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
        // An operation of a module that is off does not exist here, for any caller.
        requireOperationModuleOn(options.modules, operation.id);
        const { caller, query, body, params, takesCredential } = await admit(
          operation,
          request,
          reply
        );
        // One load per request: a grant revoked now refuses the next call.
        const access = caller.identity
          ? await options.authorizer.forActor(caller.identity)
          : undefined;
        for (const action of operation.requires ?? []) {
          requireAccess(access).require(action);
        }
        const paging =
          operation.response.kind === "page"
            ? storePage(query, operation.response.order, pageScope(operation.id, params, query))
            : undefined;
        const result = await runHandler();
        async function runHandler(): Promise<unknown> {
          try {
            return await handler({
              ...caller,
              access,
              params,
              paging,
              query,
              body,
              request,
              reply
            });
          } catch (error) {
            if (takesCredential && isAppError(error) && error.code === "UNAUTHENTICATED") {
              // A key or token this operation refused, counted under the address that sent it.
              await requireWithinLimit(options, operation, { refusedAddress: request.ip }, reply);
            }
            throw error;
          }
        }
        if (result === DEFERRED) {
          return reply.code(202).send();
        }
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
          const { schema, unavailable } = operation.response;
          if (unavailable && !schema.safeParse(result).success) {
            void reply.status(UNAVAILABLE_STATUS);
            checkResponse(options, operation, unavailable, result);
          } else {
            checkResponse(options, operation, schema, result);
          }
        }
        return result;
      }
    });
  }

  /**
   * What every call passes before its operation is reached: it is authenticated as the
   * operation's `auth` says and counted against the rate class, its credential's scope is
   * checked, and its query and body are parsed.
   */
  async function admit(operation: Operation, request: FastifyRequest, reply: FastifyReply) {
    const correlationId = createCorrelationId(request);
    void reply.header("x-correlation-id", correlationId);
    // A public call is counted by its address before anything else runs, a call with a
    // principal by that principal as soon as it is known.
    if (operation.auth === "public") {
      await requireWithinLimit(options, operation, { address: request.ip }, reply);
    }
    const caller = await authenticate(options, operation, request, reply, correlationId);
    if (caller.identity) {
      await requireWithinLimit(options, operation, { identity: caller.identity }, reply);
    }
    if (caller.identity && operation.scope) {
      requireAuthScope(caller.identity, operation.scope);
    }
    const query = parseInput(operation.query, request.query, "Request query is invalid");
    const body = parseInput(operation.body, request.body ?? {}, "Request body is invalid");
    const takesCredential = operation.auth === "public" && operation.rateClass === "auth";
    const account = takesCredential ? accountTried(body) : undefined;
    if (account !== undefined) {
      // The tight limit: tries on one account from one address.
      await requireWithinLimit(options, operation, { address: request.ip, account }, reply);
    }
    const params = readPathParams(operation, request.params);
    return { correlationId, caller, query, body, params, takesCredential };
  }

  const face = createOperationFace(options);
  function registerOperation<const Op extends Operation>(
    operation: Op,
    binding: OperationBinding<Op>
  ): void;
  function registerOperation(operation: Operation, binding: AssembledOperationBinding): void {
    face.register(operation, binding);
    registered.push(operation);
    app.route({
      method: operation.method,
      url: operation.path,
      handler: async (request, reply) => {
        requireOperationModuleOn(options.modules, operation.id);
        const { correlationId, caller, params } = await admit(operation, request, reply);
        if (!caller.identity) {
          throw new AppError("INTERNAL", `Operation '${operation.id}' was reached by nobody`);
        }
        // The parts are handed on as they arrived: the registry's one schema parses them, and
        // what it parsed is what the run hashes and the operation receives.
        return face.answer(
          operation,
          {
            identity: caller.identity,
            origin: originOf(caller.identity, request),
            correlationId,
            input: { ...inputFields(request.body), ...inputFields(request.query), ...params },
            idempotencyKey: readIdempotencyKey(request)
          },
          reply
        );
      }
    });
  }
  return Object.assign(route, { registered, operation: registerOperation });
}

/**
 * Where a call over HTTP comes from, read from how it was authenticated and from nothing else
 * the caller sends. A browser session is the person. A key or token in the request is
 * automation, which the CLI is, whether it belongs to a service principal or to a person.
 */
function originOf(identity: AuthenticatedIdentity, request: FastifyRequest): OperationOrigin {
  if (isAuthenticatedServicePrincipal(identity)) return { kind: "cli" };
  if (identity.authenticationMethod === "session-cookie") return { kind: "user" };
  return hasExplicitCredentials(request.headers) ? { kind: "cli" } : { kind: "user" };
}

const inputFieldsSchema = z.record(z.string(), z.unknown()).catch({});

function inputFields(part: unknown): Record<string, unknown> {
  return inputFieldsSchema.parse(part ?? {});
}

/** The caller's key for the call. It is the one header a call's outcome depends on. */
function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const key = request.headers["idempotency-key"];
  if (Array.isArray(key)) {
    throw new AppError("VALIDATION_FAILED", "A call takes one Idempotency-Key");
  }
  return key;
}

/** An operation that names rights authenticates a caller, so a missing answer is a wiring fault. */
function requireAccess(access: ActorAccess | undefined): ActorAccess {
  if (!access) {
    throw new AppError("INTERNAL", "A rights check ran without an authenticated caller");
  }
  return access;
}

async function authenticate(
  options: RouteServerOptions,
  operation: Operation,
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: string
): Promise<Pick<AssembledCall, "user" | "identity" | "context">> {
  const context: RequestContext = { clientInstanceId: options.clientInstanceId, correlationId };
  switch (operation.auth) {
    case "public":
      return { context };
    case "serverCredential":
      // Every user of an embedding host arrives through the host's one backend, so its calls
      // are counted under the credential, not the address. A refused credential is counted
      // under the address that sent it, on a counter the accepted one never touches.
      if (!acceptsServerCredential(options, request)) {
        await requireWithinLimit(options, operation, { refusedAddress: request.ip }, reply);
        throw new AppError("FORBIDDEN", "Invalid server credential");
      }
      await requireWithinLimit(options, operation, { serverCredential: true }, reply);
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
function acceptsServerCredential(options: RouteServerOptions, request: FastifyRequest): boolean {
  if (!options.sessionToken) {
    throw new AppError("NOT_FOUND", "Session token issuing is not configured");
  }
  const credential = request.headers["x-server-credential"];
  return (
    typeof credential === "string" && safeEqual(credential, options.sessionToken.serverCredential)
  );
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
