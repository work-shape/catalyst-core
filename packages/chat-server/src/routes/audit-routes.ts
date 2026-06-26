import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import type { ChatServerOptions } from "../types";
import { authorizeGovernanceAction } from "../governance-actions";
import { authenticateRequest } from "../request-context";

export function registerAuditRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  app.get(apiOperations.listAuditEvents.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    await authorizeGovernanceAction({
      options,
      user,
      context,
      requiredRole: "admin",
      auditType: "governance.audit_events_viewed",
      deniedMessage: "Audit events require a governance role"
    });
    return options.auditEventStore.listAuditEvents({
      clientInstanceId: options.clientInstanceId,
      limit: 100
    });
  });
}
