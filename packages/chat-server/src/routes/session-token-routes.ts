import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, CHAT_SESSION_AUTH_SCOPES } from "@vivd-catalyst/core";
import type { Route, RouteCall } from "../http/route";
import type { ChatServerOptions } from "../types";

export function registerSessionTokenRoutes(route: Route, options: ChatServerOptions): void {
  const issueSessionToken = async ({
    body,
    context
  }: Pick<RouteCall<typeof apiOperations.issueSessionToken>, "body" | "context">) => {
    if (!options.sessionToken) {
      throw new AppError("NOT_FOUND", "Session token issuing is not configured");
    }
    const issued = options.sessionToken.issuer.issue(body);
    await options.auditRecorder.record({
      type: "auth.session_token_issued",
      status: "success",
      subject: body.externalUserId,
      correlationId: body.correlationId ?? context.correlationId,
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

  route(apiOperations.issueSessionToken, issueSessionToken);
  // CB-4b removes the alias together with the path cutover.
  route(apiOperations.issueSessionTokenLegacyAlias, issueSessionToken);
}
