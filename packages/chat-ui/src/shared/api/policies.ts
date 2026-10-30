import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type SetPolicySettingRequest
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";
import { retryUnlessRefused } from "./workspace-queries";

interface PoliciesInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/** Settings > Instance > Policies: every operation's policy and the admin's settings (OP-2). */
export function usePoliciesQuery(input: PoliciesInput) {
  return useQuery({
    queryKey: workspaceQueryKeys.policies(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.policies.get(),
    retry: retryUnlessRefused
  });
}

/**
 * Sets or removes one central setting. The policy is read again afterwards, and so are the
 * person's own confirmations, which show what the admin permits.
 */
export function useSetPolicySettingMutation(input: PoliciesInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SetPolicySettingRequest) =>
      completedOutput(await input.client.policies.set({ body }), input.heldMessage),
    onSuccess: () => invalidate(queryClient, input)
  });
}

/** Locks or unlocks "Always allow" for one operation or pattern. */
export function useSetAlwaysAllowLockMutation(input: PoliciesInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { operation: string; locked: boolean }) =>
      completedOutput(
        await input.client.policies.set_always_allow_lock({ body }),
        input.heldMessage
      ),
    onSuccess: () => invalidate(queryClient, input)
  });
}

function invalidate(
  queryClient: ReturnType<typeof useQueryClient>,
  input: PoliciesInput
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.policies(input.apiBaseUrl, input.authScope)
    }),
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.ownOperationSettings(input.apiBaseUrl, input.authScope)
    })
  ]);
}
