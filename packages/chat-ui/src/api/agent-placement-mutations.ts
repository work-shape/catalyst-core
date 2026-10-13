import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AgentAvailability, ApiClient } from "@vivd-catalyst/api-client";
import { completedOutput } from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

/**
 * Asks again for the agents people are offered: the workspaces' lists, which the Agents page
 * and the agent picker read, and the instance's configuration. They hold each agent's name,
 * description and default mark, so every change of an agent made in this session ends here.
 */
export function invalidateOfferedAgents(
  queryClient: QueryClient,
  apiBaseUrl: string,
  authScope: string
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.collaborationWorkspaceAgentsScope(apiBaseUrl, authScope)
    }),
    queryClient.invalidateQueries({ queryKey: ["config", apiBaseUrl, authScope] })
  ]);
}

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
    // The id says which agent the reader looked at, should another one hold the name later.
    mutationFn: async ({ agentName, assetId }: { agentName: string; assetId: string }) =>
      completedOutput(
        await input.client.assets.set_default({
          params: { kind: "agent" },
          body: { name: agentName, expectedAssetId: assetId }
        }),
        input.heldMessage
      ),
    onSuccess: () =>
      Promise.all([
        invalidateAssets(),
        invalidateOfferedAgents(queryClient, input.apiBaseUrl, input.authScope)
      ])
  });
  const setAgentAvailability = useMutation({
    mutationFn: async (mutationInput: {
      name: string;
      mode: AgentAvailability["mode"];
      personalWorkspaces: boolean;
      collaborationWorkspaceIds: string[];
      assetId: string;
      /** The availability the page shows as stored. A change beside it is a conflict. */
      loaded: AgentAvailability | undefined;
    }) => {
      const { name, assetId, loaded, ...availability } = mutationInput;
      return completedOutput(
        await input.client.assets.set_availability({
          params: { kind: "agent", name },
          body: { ...availability, expectedAssetId: assetId, expectedAvailability: loaded ?? null }
        }),
        input.heldMessage
      );
    },
    // The admin's own picker reads the same lists, so it follows the change at once.
    onSuccess: () =>
      Promise.all([
        invalidateAssets(),
        invalidateOfferedAgents(queryClient, input.apiBaseUrl, input.authScope)
      ])
  });

  return {
    setDefaultAgent,
    setAgentAvailability,
    isPending: setDefaultAgent.isPending || setAgentAvailability.isPending
  };
}
