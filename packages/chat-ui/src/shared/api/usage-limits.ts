import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type SetUsageSpendLimitRequest
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";
import { retryUnlessRefused } from "./workspace-queries";

interface UsageLimitsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/** How often a blocked composer asks again, so a raised limit opens it without a reload. */
const BLOCKED_REFETCH_MS = 30_000;

/** Settings > Instance > Limits: every level's limit and who is near one (`limits.manage`). */
export function useUsageLimitsQuery(input: UsageLimitsInput) {
  return useQuery({
    queryKey: workspaceQueryKeys.usageLimits(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.usage.limits.get(),
    retry: retryUnlessRefused
  });
}

/** Sets or removes one level's limit. Every view of the limits reads again afterwards. */
export function useSetUsageLimitMutation(input: UsageLimitsInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SetUsageSpendLimitRequest) =>
      completedOutput(await input.client.usage.limits.set({ body }), input.heldMessage),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.usageLimits(input.apiBaseUrl, input.authScope)
        }),
        queryClient.invalidateQueries({ queryKey: ["own-usage"] })
      ])
  });
}

/**
 * The signed-in person's own consumption and whether a limit stops them, in the workspace they
 * are in. While a limit stops them it asks again now and then, so a limit an admin raised
 * opens the composer without a reload.
 */
export function useOwnUsageQuery(
  input: UsageLimitsInput & { workspaceId?: string; enabled?: boolean }
) {
  return useQuery({
    queryKey: workspaceQueryKeys.ownUsage(input.apiBaseUrl, input.authScope, input.workspaceId),
    queryFn: () =>
      input.client.me.usage.get(
        input.workspaceId === undefined ? {} : { query: { workspaceId: input.workspaceId } }
      ),
    enabled: input.enabled ?? true,
    retry: retryUnlessRefused,
    refetchInterval: (query) => (ownUsageBlocked(query.state.data) ? BLOCKED_REFETCH_MS : false)
  });
}

type OwnUsageData = Awaited<ReturnType<ApiClient["me"]["usage"]["get"]>>;

/** Whether any level stops the person. */
function ownUsageBlocked(usage: OwnUsageData | undefined): boolean {
  if (!usage) return false;
  return [usage.own, usage.workspace, usage.instance].some(
    (level) => level?.day.reached === true || level?.month.reached === true
  );
}
