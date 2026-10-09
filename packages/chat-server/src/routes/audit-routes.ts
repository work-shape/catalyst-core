import { apiOperations } from "@vivd-catalyst/api-contract";
import { projectAuditActivities } from "@vivd-catalyst/core";
import { recordGovernanceAccess } from "../governance-actions";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

// Raw events are fetched generously so an activity's evidence is rarely split at the edge of
// the read, then projected down to a bounded set of activities.
const AUDIT_EVENT_FETCH_LIMIT = 500;
const AUDIT_ACTIVITY_LIMIT = 100;

export function registerAuditRoutes(route: Route, options: ChatServerOptions): void {
  // Raw, machine-queryable evidence feed.
  route(apiOperations.listAuditEvents, async ({ user, context, paging }) => {
    await recordGovernanceAccess({
      options,
      user,
      context,
      auditType: "governance.audit_events_viewed"
    });
    return options.stores.audit.listAuditEvents({
      clientInstanceId: options.clientInstanceId,
      page: paging
    });
  });

  // Curated activity timeline for the admin UI: grouped, labelled, and filtered
  // to governance/workflow plus anything that failed or was denied. It shows the latest
  // activities only; paging activities needs a store query over correlation groups.
  route(apiOperations.listAuditActivities, async ({ user, context }) => {
    await recordGovernanceAccess({
      options,
      user,
      context,
      auditType: "governance.audit_events_viewed"
    });
    const events = await options.stores.audit.listAuditEvents({
      clientInstanceId: options.clientInstanceId,
      limit: AUDIT_EVENT_FETCH_LIMIT
    });
    return {
      items: projectAuditActivities(events, { view: "default", limit: AUDIT_ACTIVITY_LIMIT })
    };
  });
}
