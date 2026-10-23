import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type OperationSetting,
  type PersonPolicySettingValue
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";
import { retryUnlessRefused } from "./workspace-queries";

interface OperationSettingsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

/** The signed-in person's own confirmation settings, with the actions their agents called. */
export function useOwnOperationSettingsQuery(input: OperationSettingsInput) {
  return useQuery({
    queryKey: workspaceQueryKeys.ownOperationSettings(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.me.operation_settings.list(),
    retry: retryUnlessRefused
  });
}

/** Sets the person's own value for one action, or `null` for the administrator's setting. */
export function useSetOwnOperationSettingMutation(
  input: OperationSettingsInput & { heldMessage: string }
) {
  const queryClient = useQueryClient();
  const queryKey = workspaceQueryKeys.ownOperationSettings(input.apiBaseUrl, input.authScope);
  return useMutation({
    mutationFn: async (body: {
      operation: string;
      value: PersonPolicySettingValue | null;
    }): Promise<OperationSetting> =>
      completedOutput(await input.client.me.operation_settings.set({ body }), input.heldMessage),
    onSuccess: () => queryClient.invalidateQueries({ queryKey })
  });
}
