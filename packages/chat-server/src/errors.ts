import type { FastifyInstance } from "fastify";
import { apiOperations, UNKNOWN_OPERATION_REASON } from "@vivd-catalyst/api-contract";
import { AppError, isAppError, toErrorEnvelope } from "@vivd-catalyst/core";

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

export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, _reply) => {
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
  app.setErrorHandler((error, request, reply) => {
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
