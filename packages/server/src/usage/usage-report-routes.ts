import { apiOperations } from "@work-shape/catalyst-api-contract";
import { asCollaborationWorkspaceId } from "@work-shape/catalyst-core";
import type { Route } from "../http/route";
import { requirePathParam } from "../routes/request-context";
import type { ChatServerOptions } from "../types";
import {
  readUsageBreakdown,
  readUsageUsers,
  readWorkspaceMembersUsage,
  readWorkspaceUsage,
  usageReportDeps
} from "./usage-report-service";

/**
 * The Usage page (LU-3). The Breakdown requires `usage.view`, the Users view
 * `usage.view_users`; a shared workspace's Usage tab is its Owners' and Admins', and its figures
 * per member need `usage.view_users` for it. Plain reads, so no Operation Run: the reads of
 * named people's usage are audit events of their own.
 */
export function registerUsageReportRoutes(route: Route, options: ChatServerOptions): void {
  const deps = usageReportDeps(options);

  route(apiOperations["usage.breakdown.get"], ({ query }) => readUsageBreakdown(deps, query));

  route(apiOperations["usage.users.list"], ({ user, context, query }) =>
    readUsageUsers(deps, {
      actor: user,
      correlationId: context.correlationId,
      ...(query.month === undefined ? {} : { month: query.month })
    })
  );

  route(apiOperations["workspaces.usage.get"], ({ user, access, params, query }) =>
    readWorkspaceUsage(deps, options, {
      actor: user,
      access,
      workspaceId: workspaceIdOf(params),
      query
    })
  );

  route(apiOperations["workspaces.member_usage.list"], ({ user, access, context, params, query }) =>
    readWorkspaceMembersUsage(deps, options, {
      actor: user,
      access,
      correlationId: context.correlationId,
      workspaceId: workspaceIdOf(params),
      ...(query.month === undefined ? {} : { month: query.month })
    })
  );
}

function workspaceIdOf(params: { collaborationWorkspaceId: string }) {
  return asCollaborationWorkspaceId(
    requirePathParam(params.collaborationWorkspaceId, "Missing Collaboration Workspace id")
  );
}
