import type { RouteResultOr, OperationResponseResult } from "./route-response";
import { operationScope } from "./operation-scope";
import { checkResponse } from "./check-response";
import { answerRedirect } from "./redirect-answer";
import { paginate, pageScope, storePage } from "./paging";
import { timingSafeEqual } from "node:crypto";
import {
  isRegisteredOperation,
  operationPathParamNames,
  type Operation,
  type OperationPathParamName
} from "@work-shape/catalyst-api-contract";
import { hasExplicitCredentials } from "@work-shape/catalyst-auth";
import {
  AppError,
  authContextFromUser,
  createPlatformId,
  hasAuthScope,
  isAppError,
  type OperationDefinition,
  isAuthenticatedServicePrincipal,
  normalizeAuthenticatedUser,
  requireAuthScope,
  requireOperationModuleOn,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type ClientInstanceId,
  type OperationApproval,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationBeforeEvent,
  type OperationOrigin,
  type OperationResource,
  type OperationRegistry,
  type OperationScope,
  type PolicyTarget,
  type StorePage,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createOperationFace,
  createOperationRegistration,
  type AssembledOperationBinding,
  type OperationBindingContext
} from "../operations/operation-face";
import type { ResolvedChatServerOptions } from "../types";
import { resolveRequestLocale } from "../routes/request-context";
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
  | "operationCalls"
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

type RouteResult<Op extends Operation> = RouteResultOr<Op, FastifyReply>;

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
type OperationBindingOf<Op extends Operation, Sent> = Omit<
  AssembledOperationBinding,
  | "resource"
  | "policyTargets"
  | "beforeEvents"
  | "approval"
  | "execute"
  | "authorize"
  | "inputWithoutSecrets"
> &
  RightsCheck<Op> & {
    resource?(input: OperationInput<Op>): OperationResource | undefined;
    beforeEvents?(
      input: OperationInput<Op>,
      origin: OperationOrigin
    ): readonly OperationBeforeEvent[] | Promise<readonly OperationBeforeEvent[]>;
    inputWithoutSecrets?(input: OperationInput<Op>): OperationInput<Op> | undefined;
    policyTargets?(
      input: OperationInput<Op>
    ): readonly PolicyTarget[] | Promise<readonly PolicyTarget[]>;
    approval?(
      input: OperationInput<Op>
    ): OperationApproval | undefined | Promise<OperationApproval | undefined>;
    execute(
      input: OperationInput<Op>,
      context: OperationBindingContext
    ): OperationResponseResult<Op, Sent> | Promise<OperationResponseResult<Op, Sent>>;
  };

type OperationBinding<Op extends Operation> = OperationBindingOf<Op, FastifyReply>;

/** The operation of the registry a request stands for, and the input of that operation. */
export interface ResourceOperationTarget {
  /** The name the registry resolves, such as `data_store.<id>.query`. */
  operation: string;
  input: unknown;
}

/**
 * The route of a family of operations that exist once per resource: a Data Store, a
 * Connection, a Knowledge Base, an App, a Workflow. The descriptor describes the route and
 * nothing else. `target` names the resource's own operation, and the call runs as that one:
 * its right, its policy, its run and its audit events carry that name, the same as a call of
 * an agent or of a Workflow step. The descriptor's id is in no policy and in no audit event.
 */
export interface ResourceOperationBinding<Op extends Operation> {
  target(input: OperationInput<Op>): ResourceOperationTarget;
  /**
   * The right of the kind that the verb asks for, such as `data_store.read`. It is asked on
   * the instance where the resource has no such operation, and for nothing else: a caller
   * without it is refused as for a resource that exists, so the answer tells nobody which
   * ids exist. The call of a resource that exists is judged by the resource's operation.
   */
  right: string;
  /** What a caller who holds the right reads when the resource has no such operation. */
  notFound: string;
  bodyLimitBytes?: number;
}

/**
 * What a module of the assembly registers its operations on. It is the `operation` of a route
 * of the server without the web framework: an operation of a module answers JSON or a page.
 */
export interface ModuleRoutes {
  operation<const Op extends Operation>(
    operation: Op,
    binding: OperationBindingOf<Op, never>
  ): void;
  /** Registers the route of a family of per-resource operations. See the binding. */
  resourceOperation<const Op extends Operation>(
    operation: Op,
    binding: ResourceOperationBinding<Op>
  ): void;
}

export interface Route {
  <const Op extends Operation>(operation: Op, handler: RouteHandler<Op>): void;
  /**
   * Registers an operation of the registry, defined with `defineRegisteredOperation`. Every
   * call of it runs through `runOperation`: the right in `requires`, the policy and the
   * guardrails are checked there, and the answer's status says how the call went. A changing
   * call is an Operation Run. A read is one when it is refused, when it fails, or when the
   * binding sets `recordsEveryCall`.
   */
  operation<const Op extends Operation>(operation: Op, binding: OperationBinding<Op>): void;
  /**
   * Registers the route of a family of operations that exist per resource. The call runs
   * through `runOperation` as the operation `target` names, never as the descriptor.
   */
  resourceOperation<const Op extends Operation>(
    operation: Op,
    binding: ResourceOperationBinding<Op>
  ): void;
  /** Every operation registered on this server so far, through whichever helper. */
  readonly registered: readonly Operation[];
}

/** Registers the operations of one module through `routes.operation`. */
export type RouteRegistration = (routes: ModuleRoutes) => void;

/**
 * Registers a module's operations in a process that serves no HTTP, such as an Agent Run
 * worker. The same bindings build the same definitions as the API. Per-resource routes add
 * no definition: their operations already come from the module's OperationSources.
 */
export function registerModuleOperations(
  registry: OperationRegistry,
  registrations: readonly RouteRegistration[]
): void {
  const registerDefinition = createOperationRegistration(registry);
  function register<const Op extends Operation>(
    operation: Op,
    binding: OperationBindingOf<Op, never>
  ): void;
  function register(operation: Operation, binding: AssembledOperationBinding): void {
    registerDefinition(operation, binding);
  }
  const routes: ModuleRoutes = {
    operation: register,
    resourceOperation() {
      // The module's OperationSources already supply these definitions.
    }
  };
  for (const registration of registrations) registration(routes);
}

/** What an assembly adds to a server beside its options. */
export interface ChatServerExtensions {
  /** Routes of the modules the assembly builds, registered after the server's own. */
  routes?: readonly RouteRegistration[];
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
   * operation's `auth` says, the module that owns the operation is on, the call is counted
   * against the rate class, its credential's scope is checked, and its query and body are
   * parsed.
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
    // An operation of a module that is off does not exist here. The caller is known first, so
    // a call without a credential is answered as on any route and learns nothing of modules.
    requireOperationModuleOn(options.modules, operation.id);
    if (caller.identity) {
      await requireWithinLimit(options, operation, { identity: caller.identity }, reply);
    }
    if (caller.identity && operation.scope) {
      await requireOperationScope(options, caller.identity, operation);
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
      ...(binding.bodyLimitBytes === undefined ? {} : { bodyLimit: binding.bodyLimitBytes }),
      handler: async (request, reply) =>
        operation.response.kind === "redirect"
          ? answerRedirect(reply, binding.redirectOnError, () => call(request, reply))
          : call(request, reply)
    });
    async function call(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
      const { correlationId, caller, params } = await admit(operation, request, reply);
      if (!caller.identity) {
        throw new AppError("INTERNAL", `Operation '${operation.id}' was reached by nobody`);
      }
      // The fields the descriptor declares are handed on as they arrived: the registry's one
      // schema parses them, and what it parsed is what the run hashes and the operation
      // receives. A field of the query or the body that the descriptor does not declare there
      // is left out, so a query string never stands in for a field of the body.
      return face.answer(
        operation,
        {
          identity: caller.identity,
          origin: originOf(caller.identity, request),
          correlationId,
          input: {
            ...declaredFields(operation.body, request.body),
            ...declaredFields(operation.query, request.query),
            ...params
          },
          idempotencyKey: readIdempotencyKey(request),
          locale: resolveRequestLocale(options, request)
        },
        reply
      );
    }
  }
  function registerResourceOperation<const Op extends Operation>(
    operation: Op,
    binding: ResourceOperationBinding<Op>
  ): void;
  function registerResourceOperation(
    operation: Operation,
    binding: {
      target(input: Record<string, unknown>): ResourceOperationTarget;
      right: string;
      notFound: string;
      bodyLimitBytes?: number;
    }
  ): void {
    // The descriptor declares what a call of the registry answers, and is not in the registry.
    if (!isRegisteredOperation(operation)) {
      throw new Error(`Operation '${operation.id}' is not defined as a registered operation`);
    }
    if (operation.auth !== "user" && operation.auth !== "principal") {
      throw new Error(`Operation '${operation.id}' must authenticate its caller`);
    }
    if (operation.response.kind !== "json") {
      throw new Error(`Operation '${operation.id}' must answer JSON`);
    }
    if ((operation.requires ?? []).length > 0) {
      throw new Error(
        `Operation '${operation.id}' is the route of per-resource operations and names no right: the right is the resource operation's`
      );
    }
    registered.push(operation);
    app.route({
      method: operation.method,
      url: operation.path,
      ...(binding.bodyLimitBytes === undefined ? {} : { bodyLimit: binding.bodyLimitBytes }),
      handler: async (request, reply) => {
        const { correlationId, caller, params, query, body } = await admit(
          operation,
          request,
          reply
        );
        if (!caller.identity) {
          throw new AppError("INTERNAL", `Operation '${operation.id}' was reached by nobody`);
        }
        const target = binding.target({
          ...inputFieldsSchema.parse(body ?? {}),
          ...inputFieldsSchema.parse(query ?? {}),
          ...params
        });
        const resolved = await face.registry.resolve(target.operation);
        if (resolved) requireAdmittedAsTheRoute(operation, resolved);
        // An id that has no such operation takes the same path as one that has: the call
        // runs under the same name and the right is asked there, so a caller without it
        // gets the same refusal, with the same recorded run, whichever id it names.
        return face.answer(
          operation,
          {
            identity: caller.identity,
            origin: originOf(caller.identity, request),
            correlationId,
            input: target.input,
            idempotencyKey: readIdempotencyKey(request),
            locale: resolveRequestLocale(options, request),
            effect: resolved?.effect,
            runs: target.operation,
            ...(resolved ? {} : { absent: { right: binding.right, notFound: binding.notFound } })
          },
          reply
        );
      }
    });
  }
  return Object.assign(route, {
    registered,
    operation: registerOperation,
    resourceOperation: registerResourceOperation
  });
}

/**
 * The route of a family admits the caller and the key for every operation of the family, so
 * an operation it resolves may ask no other scope and no narrower caller than the route does.
 * One that did would be refused where an unknown id is not, and that difference would tell
 * which ids exist. It is a fault of the registration and fails as one.
 */
function requireAdmittedAsTheRoute(route: Operation, target: OperationDefinition): void {
  const scope = target.scope === null || target.scope === (route.scope ?? null);
  const caller = target.auth === "principal" || route.auth === "user";
  if (!scope || !caller) {
    throw new AppError(
      "INTERNAL",
      `Operation '${target.name}' asks another scope or caller than its route '${route.id}'`
    );
  }
}

/**
 * The scope that passes an operation's check beside its own, for a holder of one right on the
 * instance. A release is written through `assets.sync` and checked through
 * `assets.sync_check`, which ask for the scope of writing assets: a key issued for release
 * sync passes there when its principal holds the release right, and on no other operation and
 * for no other principal. The reverse holds in the sync: without this scope on the key the
 * release right opens nothing there (`accessOfSyncCredential`).
 */
const FURTHER_SCOPE_OF_OPERATION: Partial<
  Record<string, { scope: OperationScope; heldWith: string }>
> = {
  "assets.sync": { scope: "config_assets:release", heldWith: "assets.release" },
  "assets.sync_check": { scope: "config_assets:release", heldWith: "assets.release" }
};

async function requireOperationScope(
  options: Pick<ResolvedChatServerOptions, "authorizer">,
  identity: AuthenticatedIdentity,
  operation: Operation
): Promise<void> {
  const scope = operationScope(identity, operation);
  if (!scope) return;
  const further = FURTHER_SCOPE_OF_OPERATION[operation.id];
  if (hasAuthScope(identity, scope) || !further || !hasAuthScope(identity, further.scope)) {
    requireAuthScope(identity, scope);
    return;
  }
  // Asked without a resource, so only a right on the instance answers.
  const access = await options.authorizer.forActor(identity);
  if (!access.authorize(further.heldWith).allowed) {
    requireAuthScope(identity, scope);
  }
}

/**
 * Where a call over HTTP comes from, read from how it was authenticated and from nothing else
 * the caller sends. Only an API credential is the CLI: a service principal's credential, a
 * personal API key, or an access token exchanged for either. Everything else is the person,
 * a browser session as much as a session token an embedding host issued for them.
 */
function originOf(identity: AuthenticatedIdentity, request: FastifyRequest): OperationOrigin {
  const cli =
    isAuthenticatedServicePrincipal(identity) || identity.delegatedActor?.kind === "api_key";
  if (!cli) return { kind: "user" };
  return readUnattended(request) ? { kind: "cli", unattended: true } : { kind: "cli" };
}

/**
 * Whether a CLI call says nobody watches its terminal (`Catalyst-Unattended: 1`). It only ever
 * moves a confirmation to the person's Inbox, so a caller gains nothing by sending it; a
 * browser session's call ignores it.
 */
function readUnattended(request: FastifyRequest): boolean {
  const value = request.headers["catalyst-unattended"];
  if (Array.isArray(value)) {
    throw new AppError("VALIDATION_FAILED", "A call takes one Catalyst-Unattended");
  }
  if (value === undefined) return false;
  if (value === "1") return true;
  throw new AppError("VALIDATION_FAILED", "Catalyst-Unattended takes the value 1");
}

const inputFieldsSchema = z.record(z.string(), z.unknown()).catch({});

/**
 * The fields of one part of a request that the descriptor declares for that part. A part the
 * descriptor declares nothing for gives none, whatever the caller sent in it.
 */
function declaredFields(schema: z.ZodType | undefined, part: unknown): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return {};
  const sent = inputFieldsSchema.parse(part ?? {});
  return Object.fromEntries(
    Object.keys(schema.shape)
      .filter((name) => Object.hasOwn(sent, name))
      .map((name) => [name, sent[name]])
  );
}

/** The caller's key for the call. */
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
