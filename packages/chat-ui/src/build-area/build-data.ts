import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ConfigAssetsOverview, ConfigAssetSummary } from "@vivd-catalyst/api-client";
import { useConfigAssetsExportQuery, useConfigAssetsOverviewQuery } from "../api/workspace-queries";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { useTranslation } from "../i18n";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorMessage } from "../workspace-utils";
import type { BuildAsset } from "./build-asset-kind";

/** What the instance says about one kind: its assets and whether the reader may add one. */
export interface BuildKindState {
  /** The asset kind, as the server stores it. */
  kind: string;
  assets: readonly BuildAsset[];
  canCreate: boolean;
}

/** Everything the Build frame shows, as the instance answered it. */
export interface BuildData {
  /** The kinds that are on and readable for this reader. A kind that is missing here has no rail item. */
  kinds: readonly BuildKindState[];
  /** True until the first answer: the kinds are known, their assets are not. */
  loading: boolean;
  error: string | undefined;
  reload(): Promise<unknown>;
}

/** What the agent and skill editors read beside the frame's data. */
export interface ConfigAssetsData extends BuildData {
  overview: ConfigAssetsOverview | undefined;
}

/**
 * The agents and skills of the instance, read once for the whole area: the overview names every
 * asset and the export carries the configurations. Both answers hold every asset, so the cost
 * of this read grows with the number of assets and the size of their texts.
 */
export function useConfigAssetsData(): ConfigAssetsData {
  const { apiBaseUrl, authScope, client, config } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const overviewQuery = useConfigAssetsOverviewQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const exportQuery = useConfigAssetsExportQuery({ apiBaseUrl, authScope, client, enabled: true });
  const overview = overviewQuery.data;
  const exported = exportQuery.data;
  const management = config.features.configAssets;

  const kinds = useMemo<BuildKindState[]>(() => {
    const summaries = new Map(
      (overview?.assets ?? []).map((summary) => [assetKey(summary.kind, summary.name), summary])
    );
    return [
      {
        kind: "agent",
        assets: buildAssets("agent", exported?.agents, summaries, overview?.defaultAgentName),
        canCreate: management.allowAgentCreation
      },
      {
        kind: "skill",
        assets: buildAssets("skill", exported?.skills, summaries, undefined),
        canCreate: management.allowSkillEditing
      }
    ];
  }, [exported, management.allowAgentCreation, management.allowSkillEditing, overview]);

  const loadError = overviewQuery.error ?? exportQuery.error;
  return {
    kinds,
    overview,
    loading: overviewQuery.isLoading || exportQuery.isLoading,
    error: loadError ? apiErrorMessage(loadError, t("build.loadFailed")) : undefined,
    reload: () =>
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.configAssetsOverview(apiBaseUrl, authScope)
      })
  };
}

function assetKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function buildAssets(
  kind: string,
  configs: readonly Record<string, unknown>[] | undefined,
  summaries: ReadonlyMap<string, ConfigAssetSummary>,
  defaultName: string | undefined
): BuildAsset[] {
  return (configs ?? []).flatMap((config) => {
    const name = config.name;
    return typeof name === "string"
      ? [
          {
            kind,
            name,
            config,
            isDefault: name === defaultName,
            summary: summaries.get(assetKey(kind, name))
          }
        ]
      : [];
  });
}
