import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, CHAT_SESSION_AUTH_SCOPES } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { createCorrelationId, parseBody } from "../request-context";

export function registerSessionTokenRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const issueSessionToken = async (request: FastifyRequest) => {
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
        permissionRefs: body.permissionRefs ?? [],
        permissions: body.permissions ?? [],
        scopes: body.scopes ?? [...CHAT_SESSION_AUTH_SCOPES],
        ...(body.delegatedActor
          ? {
              delegatedActor: {
                kind: body.delegatedActor.kind,
                id: body.delegatedActor.id,
                displayLabel: body.delegatedActor.displayLabel ?? null,
                authSource: body.delegatedActor.authSource
              }
            }
          : {})
      }
    });
    return issued;
  };

  app.post(apiOperations.issueSessionToken.path, issueSessionToken);
  // Legacy alias for deployed integrations.
  app.post("/auth/session-token", issueSessionToken);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
