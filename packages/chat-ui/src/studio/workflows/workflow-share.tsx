import { useContext, useMemo } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useAssetShare, type AssetShare } from "../build-area/asset-share";
import { createAssetShareSource } from "../build-area/asset-share-model";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import type { WorkflowView } from "./workflow-views";
import { workflowRightsOn } from "./workflow-model";
import { useWorkflowsHost } from "./workflows-host";
import type { OpenRoute } from "./workflows-frame";

/**
 * "Teilen…" of a Workflow (SHARE-1), for whoever may change it: to a team the reader belongs to
 * from their own, or to Alle. Once it moved to a team, the page opens it there.
 */
export function useWorkflowShare({
  workspaceId,
  workflowId,
  workflow,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  workflow: Pick<WorkflowView, "name" | "allowed" | "ownerWorkspaceId"> | undefined;
  onOpenRoute: OpenRoute;
}): AssetShare {
  const host = useWorkflowsHost();
  // Outside a signed-in shell, as over samples, nothing moves: there is no "Teilen…".
  const api = useOptionalWorkspaceApiClient();
  const queryClient = useContext(QueryClientContext);
  const source = useMemo(
    () =>
      api &&
      queryClient &&
      createAssetShareSource(api.client, () => {
        queryClient
          .invalidateQueries({ queryKey: workspaceQueryKeys.assets(api.apiBaseUrl, "standalone") })
          .catch(() => undefined);
      }),
    [api, queryClient]
  );
  return useAssetShare({
    source,
    subject:
      workflow === undefined
        ? undefined
        : {
            kind: WORKFLOW_ASSET_KIND,
            name: workflowId,
            title: workflow.name,
            owner:
              workflow.ownerWorkspaceId === undefined
                ? { kind: "instance" }
                : { kind: "workspace", workspaceId: workflow.ownerWorkspaceId }
          },
    canShare: host !== undefined && workflowRightsOn(host.rights, workflow).write,
    workspaces: host?.places ?? [],
    onMoved: (owner) => {
      if (owner.kind === "workspace" && owner.workspaceId !== workspaceId) {
        onOpenRoute({
          kind: "workflow",
          collaborationWorkspaceId: owner.workspaceId,
          workflow: workflowId
        });
      }
    }
  });
}
