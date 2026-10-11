import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentAvailability, ApiClient } from "@vivd-catalyst/api-client";
import { completedOutput } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

interface AgentPlacementMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  /** Shown when a change waits for somebody else's approval and has changed nothing yet. */
  heldMessage: string;
}

/**
 * The two changes of an agent that belong to the instance and are not part of its definition:
 * which agent is the default, and where an agent can be chosen. Each is an asset operation and
 * an Operation Run. The definition itself is written by `createAssetWrites`.
 */
export function useAgentPlacementMutations(input: AgentPlacementMutationInput) {
  const queryClient = useQueryClient();

  const invalidateAssets = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.assets(input.apiBaseUrl, input.authScope)
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.configAssetsOverview(input.apiBaseUrl, input.authScope)
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.auditEvents(input.apiBaseUrl, input.authScope)
      })
    ]);

  const setDefaultAgent = useMutation({
    mutationFn: async ({ agentName }: { agentName: string }) =>
      completedOutput(
        await input.client.assets.set_default({
          params: { kind: "agent" },
          body: { name: agentName }
        }),
        input.heldMessage
      ),
    onSuccess: invalidateAssets
  });
  const setAgentAvailability = useMutation({
    mutationFn: async (mutationInput: {
      name: string;
      mode: AgentAvailability["mode"];
      personalWorkspaces: boolean;
      collaborationWorkspaceIds: string[];
    }) => {
      const { name, ...availability } = mutationInput;
      return completedOutput(
        await input.client.assets.set_availability({
          params: { kind: "agent", name },
          body: availability
        }),
        input.heldMessage
      );
    },
    // The admin's own picker reads the same lists, so it follows the change at once.
    onSuccess: () =>
      Promise.all([
        invalidateAssets(),
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.collaborationWorkspaceAgentsScope(
            input.apiBaseUrl,
            input.authScope
          )
        }),
        queryClient.invalidateQueries({ queryKey: ["config", input.apiBaseUrl, input.authScope] })
      ])
  });

  return {
    setDefaultAgent,
    setAgentAvailability,
    isPending: setDefaultAgent.isPending || setAgentAvailability.isPending
  };
}
