import { apiOperations } from "@vivd-catalyst/api-contract";
import { extractApiKey } from "@vivd-catalyst/auth";
import { AppError, auditActorFromServicePrincipal } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

export function registerServiceAccessTokenRoutes(route: Route, options: ChatServerOptions): void {
  // Public to the route helper: the API key in the request is the credential, and the
  // exchange below is what authenticates it.
  route(apiOperations.exchangeApiKey, async ({ request, context }) => {
    if (!options.serviceAccessToken) {
      throw new AppError("NOT_FOUND", "API access is not configured");
    }
    const apiKey = extractApiKey(request.headers);
    if (!apiKey) {
      throw new AppError("UNAUTHENTICATED", "Missing API key");
    }
    const { correlationId } = context;
    let issued: Awaited<ReturnType<typeof options.serviceAccessToken.exchange.exchange>>;
    try {
      issued = await options.serviceAccessToken.exchange.exchange(apiKey);
    } catch (error) {
      await options.auditRecorder.record({
        type: "auth.service_access_token_issued",
        status: "denied",
        reason: error instanceof AppError ? error.code : "INTERNAL",
        correlationId
      });
      throw error;
    }
    await options.auditRecorder.record({
      type: "auth.service_access_token_issued",
      status: "success",
      actor: auditActorFromServicePrincipal(issued.principal),
      subject: issued.principal.credentialId,
      correlationId,
      metadata: {
        servicePrincipalId: issued.principal.id,
        credentialId: issued.principal.credentialId,
        scopes: issued.principal.scopes
      }
    });
    return {
      accessToken: issued.accessToken,
      expiresAt: issued.expiresAt
    };
  });
}
