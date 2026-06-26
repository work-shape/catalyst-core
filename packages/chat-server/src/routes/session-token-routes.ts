import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { createCorrelationId, parseBody } from "../request-context";

export function registerSessionTokenRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  app.post(apiOperations.issueSessionToken.path, async (request) => {
    if (!options.sessionToken) {
      throw new AppError("NOT_FOUND", "Session token issuing is not configured");
    }
    const credential = request.headers["x-server-credential"];
    if (typeof credential !== "string" || !safeEqual(credential, options.sessionToken.serverCredential)) {
      throw new AppError("FORBIDDEN", "Invalid server credential");
    }
    const body = parseBody(apiOperations.issueSessionToken.requestSchema, request.body);
    const issued = options.sessionToken.issuer.issue(body);
    await options.auditRecorder.record({
      type: "auth.session_token_issued",
      status: "success",
      subject: body.externalUserId,
      correlationId: body.correlationId ?? createCorrelationId(request),
      metadata: {
        roles: body.roles ?? [],
        permissionRefs: body.permissionRefs ?? []
      }
    });
    return issued;
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
