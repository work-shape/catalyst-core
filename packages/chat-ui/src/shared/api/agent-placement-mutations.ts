import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { AgentAvailability, AgentUse, ApiClient } from "@work-shape/catalyst-api-client";
import { completedOutput } from "@work-shape/catalyst-api-client";
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

/** The kinds whose assets are made available per workspace. */
export const AVAILABILITY_KINDS = ["agent", "knowledge_base", "connection"] as const;
export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number];

interface AgentPlacementMutationInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  /** Shown when a change waits for somebody else's approval and has changed nothing yet. */
  heldMessage: string;
}

/**
 * The two changes of an asset that belong to the instance and are not part of its definition:
 * which agent is the default, and where an agent, a Knowledge Base or a Connection is
 * available. Each is an asset operation and an Operation Run. The definition itself is written
 * by `createAssetWrites`.
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
  const setAvailability = useMutation({
    mutationFn: async (mutationInput: {
      kind: AvailabilityKind;
      name: string;
      mode: AgentAvailability["mode"];
      personalWorkspaces: boolean;
      collaborationWorkspaceIds: string[];
      assetId: string;
      /** The availability the page shows as stored. A change beside it is a conflict. */
      loaded: AgentAvailability | undefined;
      /** An agent's: also make what it uses available where it now is. */
      makeDependenciesAvailable?: boolean;
      /**
       * An agent's: the live revision the page read. A publish beside it may have added what
       * the agent uses, so the instance refuses the change as a conflict.
       */
      expectedRevision?: number;
    }) => {
      const { kind, name, assetId, loaded, ...availability } = mutationInput;
      return completedOutput(
        await input.client.assets.set_availability({
          params: { kind, name },
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

  // Who uses an agent where it is available (AGENT-USE-1). The pickers follow it at once.
  const setUse = useMutation({
    mutationFn: async ({ name, assetId, use }: { name: string; assetId: string; use: AgentUse }) =>
      completedOutput(
        await input.client.agents.use.set({
          params: { name },
          body: { use, expectedAssetId: assetId }
        }),
        input.heldMessage
      ),
    onSuccess: () =>
      Promise.all([
        invalidateAssets(),
        invalidateOfferedAgents(queryClient, input.apiBaseUrl, input.authScope)
      ])
  });

  return {
    setDefaultAgent,
    setAvailability,
    setUse,
    isPending: setDefaultAgent.isPending || setAvailability.isPending || setUse.isPending
  };
}
