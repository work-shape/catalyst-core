import type { FastifyInstance } from "fastify";
import { AppError, isAppError, toErrorEnvelope } from "@vivd-catalyst/core";

export function installErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, _reply) => {
    throw new AppError("NOT_FOUND", "Operation is not available");
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
