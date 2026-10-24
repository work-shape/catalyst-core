import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  ApiClient,
  UsageBreakdownQuery,
  WorkspaceUsageQuery
} from "@work-shape/catalyst-api-client";
import { retryUnlessRefused } from "./workspace-queries";

// The reads of the Usage page (LU-3). The Users view and a workspace's members are asked only
// while their tab is open: each answer is an audit event of who looked.

interface UsageReportsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

const usageReportKey = (input: UsageReportsInput, ...parts: unknown[]) =>
  ["usage-reports", input.apiBaseUrl, input.authScope, ...parts] as const;

/** Settings > Instance > Usage, Breakdown. A new period or group keeps the old rows until it answers. */
export function useUsageBreakdownQuery(input: UsageReportsInput & { query: UsageBreakdownQuery }) {
  return useQuery({
    queryKey: usageReportKey(input, "breakdown", input.query),
    queryFn: () => input.client.usage.breakdown.get({ query: input.query }),
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused
  });
}

/** Settings > Instance > Usage, Users: each person's own month (`usage.view_users`). */
export function useUsageUsersQuery(input: UsageReportsInput & { month: string }) {
  return useQuery({
    queryKey: usageReportKey(input, "users", input.month),
    queryFn: () => input.client.usage.users.list({ query: { month: input.month } }),
    retry: retryUnlessRefused
  });
}

/** Settings > Workspace > Usage: the shared workspace's month and its Breakdown. */
export function useSharedWorkspaceUsageQuery(
  input: UsageReportsInput & {
    collaborationWorkspaceId: string;
    query: WorkspaceUsageQuery;
    enabled?: boolean;
  }
) {
  return useQuery({
    enabled: input.enabled ?? true,
    queryKey: usageReportKey(input, "workspace", input.collaborationWorkspaceId, input.query),
    queryFn: () =>
      input.client.workspaces.usage.get({
        params: { collaborationWorkspaceId: input.collaborationWorkspaceId },
        query: input.query
      }),
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused
  });
}

/** Settings > Workspace > Usage, Members: what each member used there in one month. */
export function useWorkspaceMemberUsageQuery(
  input: UsageReportsInput & { collaborationWorkspaceId: string; month: string }
) {
  return useQuery({
    queryKey: usageReportKey(input, "members", input.collaborationWorkspaceId, input.month),
    queryFn: () =>
      input.client.workspaces.member_usage.list({
        params: { collaborationWorkspaceId: input.collaborationWorkspaceId },
        query: { month: input.month }
      }),
    retry: retryUnlessRefused
  });
}
