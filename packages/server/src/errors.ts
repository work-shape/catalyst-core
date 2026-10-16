import type { FastifyInstance } from "fastify";
import {
  apiOperations,
  BODY_TOO_LARGE_REASON,
  INVALID_JSON_BODY_REASON,
  UNKNOWN_OPERATION_REASON
} from "@work-shape/catalyst-api-contract";
import { AppError, isAppError, toErrorEnvelope } from "@work-shape/catalyst-core";

const catalogRoutes = Object.values(apiOperations).map((operation) => ({
  method: operation.method,
  // A parameter is one segment. A path that ends in `/*` takes the rest, slashes included.
  path: new RegExp(
    `^${operation.path.replaceAll(/:[A-Za-z][A-Za-z0-9_]*/gu, "[^/]+").replace(/\/\*$/u, "/.*")}$`,
    "u"
  )
}));

function isCatalogOperation(method: string, url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return catalogRoutes.some((route) => route.method === method && route.path.test(path));
}

/**
 * Addresses of an earlier release that a caller in use still asks for: the release sync of the
 * CLI before it moved to the asset operations. Nothing is served there. The answer is the 404
 * of any unknown address, with a sentence the old CLI prints as it is.
 */
const RETIRED_ROUTES = new Set([
  "GET /api/v1/instance/config/export",
  "POST /api/v1/instance/config/import",
  "POST /api/v1/instance/config/validate"
]);
const RETIRED_ROUTE_MESSAGE =
  "This address is gone: config assets are read and written through /api/v1/assets. " +
  "Upgrade the Catalyst CLI to the release of this server.";

function isRetiredRoute(method: string, url: string): boolean {
  return RETIRED_ROUTES.has(`${method} ${url.split("?", 1)[0] ?? url}`);
}

/**
 * The refusals of a request body that the framework raises before any route reads it, each the
 * caller's to hear in a sentence. Its JSON reader refuses an empty body, one that does not
 * parse, and one that names `__proto__` or `constructor.prototype` as a key.
 */
const BODY_REFUSALS = new Map([
  [
    "FST_ERR_CTP_BODY_TOO_LARGE",
    {
      message: "The request body is larger than this instance accepts",
      reason: BODY_TOO_LARGE_REASON
    }
  ],
  [
    "FST_ERR_CTP_EMPTY_JSON_BODY",
    {
      message: "The request body is empty, and its content type needs JSON",
      reason: INVALID_JSON_BODY_REASON
    }
  ],
  [
    "FST_ERR_CTP_INVALID_JSON_BODY",
    {
      message:
        "The request body is no JSON this instance reads: it does not parse, or it names __proto__ or constructor.prototype as a key",
      reason: INVALID_JSON_BODY_REASON
    }
  ]
]);

function bodyRefusalOf(error: unknown): AppError | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const refusal = typeof code === "string" ? BODY_REFUSALS.get(code) : undefined;
  return refusal
    ? new AppError("BAD_REQUEST", refusal.message, { reason: refusal.reason })
    : undefined;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, _reply) => {
    if (isRetiredRoute(request.method, request.url)) {
      throw new AppError("NOT_FOUND", RETIRED_ROUTE_MESSAGE, {
        reason: UNKNOWN_OPERATION_REASON
      });
    }
    // An operation this instance runs without is still an operation. Anything else tells the
    // caller that it was built for another release, which an open interface shows as a notice.
    throw new AppError(
      "NOT_FOUND",
      "Operation is not available",
      isCatalogOperation(request.method, request.url)
        ? undefined
        : { reason: UNKNOWN_OPERATION_REASON }
    );
  });
  app.setErrorHandler((raised, request, reply) => {
    const error = bodyRefusalOf(raised) ?? raised;
    if (!isAppError(error)) {
      app.log.error(error);
    }
    const supplied = request.headers["x-correlation-id"];
    const correlationId = String(
      reply.getHeader("x-correlation-id") ??
        (typeof supplied === "string" && supplied ? supplied : request.id)
    );
    const envelope = toErrorEnvelope(error, correlationId);
    void reply
      .header("x-correlation-id", correlationId)
      .status(envelope.statusCode)
      .type("application/json; charset=utf-8")
      .send({ error: envelope.error });
  });
}
