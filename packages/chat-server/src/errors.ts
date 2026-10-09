import type { FastifyInstance } from "fastify";
import { isAppError, toErrorEnvelope } from "@vivd-catalyst/core";

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (!isAppError(error)) {
      app.log.error(error);
    }
    const envelope = toErrorEnvelope(error);
    void reply
      .status(envelope.statusCode)
      .type("application/json; charset=utf-8")
      .send({ error: envelope.error });
  });
}
