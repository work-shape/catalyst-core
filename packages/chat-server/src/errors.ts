import type { FastifyInstance } from "fastify";
import { isAppError } from "@vivd-stage/core";

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      error: {
        code: "INTERNAL",
        message: "Internal server error"
      }
    });
  });
}
