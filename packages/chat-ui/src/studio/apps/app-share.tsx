import { useContext, useMemo } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { APP_ASSET_KIND, type Asset } from "@work-shape/catalyst-api-client";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { useAssetShare, type AssetShare } from "../build-area/asset-share";
import { createAssetShareSource } from "../build-area/asset-share-model";
import { appRightsOn } from "./app-model";
import { useAppsHost } from "./apps-host";

/**
 * "Teilen…" of an App (SHARE-1), for whoever may change it: from the reader's own workspace to
 * a team they belong to. Only a workspace owns an App, so it never goes to Alle. Once it moved,
 * the App opens in the team.
 */
export function useAppShare(app: string, record: Asset | undefined, title: string): AssetShare {
  const host = useAppsHost();
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
      record === undefined
        ? undefined
        : { kind: APP_ASSET_KIND, name: app, title, id: record.id, owner: record.scope },
    canShare: host !== undefined && appRightsOn(host.rights, record).write,
    toEveryone: false,
    workspaces: host?.places ?? [],
    onMoved: (owner) => {
      if (owner.kind === "workspace") {
        host?.showRoute({ kind: "app", collaborationWorkspaceId: owner.workspaceId, app });
      }
    }
  });
}
