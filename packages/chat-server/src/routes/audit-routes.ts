import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { projectAuditActivities, requireAuthScope } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { authorizeGovernanceAction } from "../governance-actions";
import { authenticateRequest } from "../request-context";

// Raw events are fetched generously so an activity's evidence is not split at
// the page boundary, then projected down to a bounded set of activities.
const AUDIT_EVENT_FETCH_LIMIT = 500;
const AUDIT_ACTIVITY_LIMIT = 100;

export function registerAuditRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  // Raw, machine-queryable evidence feed.
  app.get(apiOperations.listAuditEvents.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "governance:read");
    await authorizeGovernanceAction({
      options,
      user,
      context,
      requiredPermission: "audit.view",
      auditType: "governance.audit_events_viewed",
      deniedMessage: "Audit events require 'audit.view' permission"
    });
    return options.auditEventStore.listAuditEvents({
      clientInstanceId: options.clientInstanceId,
      limit: 100
    });
  });

  // Curated activity timeline for the admin UI: grouped, labelled, and filtered
  // to governance/workflow plus anything that failed or was denied.
  app.get(apiOperations.listAuditActivities.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "governance:read");
    await authorizeGovernanceAction({
      options,
      user,
      context,
      requiredPermission: "audit.view",
      auditType: "governance.audit_events_viewed",
      deniedMessage: "Audit events require 'audit.view' permission"
    });
    const events = await options.auditEventStore.listAuditEvents({
      clientInstanceId: options.clientInstanceId,
      limit: AUDIT_EVENT_FETCH_LIMIT
    });
    return projectAuditActivities(events, { view: "default", limit: AUDIT_ACTIVITY_LIMIT });
  });
}
