import { useQueryClient } from "@tanstack/react-query";
import { listAll } from "@vivd-catalyst/api-client";
import { useConfigAssetMutations } from "../../api/workspace-mutations";
import {
  useAdministeredCollaborationWorkspacesQuery,
  useConfigAssetsExportQuery,
  useConfigAssetsOverviewQuery
} from "../../api/workspace-queries";
import { workspaceQueryKeys } from "../../api/workspace-query-keys";
import { ConfigAssetsPanel } from "../../control-plane/config-assets-panel";
import { canManageAgentModels } from "../../control-plane/governance";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** Build: the agents and skills of this instance, with its own data. */
export function BuildPage() {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const management = config.features.configAssets;
  const overviewQuery = useConfigAssetsOverviewQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const exportQuery = useConfigAssetsExportQuery({ apiBaseUrl, authScope, client, enabled: true });
  const administeredWorkspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const mutations = useConfigAssetMutations({ apiBaseUrl, authScope, client });
  const queryClient = useQueryClient();
  const loadError = overviewQuery.error ?? exportQuery.error;

  return (
    <ConfigAssetsPanel
      editableAgentFields={management.editableAgentFields}
      canManageAgentModels={canManageAgentModels(user)}
      allowAgentCreation={management.allowAgentCreation}
      allowAgentDeletion={management.allowAgentDeletion}
      allowDefaultAgentChange={management.allowDefaultAgentChange}
      allowSkillEditing={management.allowSkillEditing}
      overview={overviewQuery.data}
      agents={namedBundleEntries(exportQuery.data?.agents)}
      skills={namedBundleEntries(exportQuery.data?.skills)}
      administeredWorkspaces={administeredWorkspacesQuery.data ?? []}
      administeredWorkspacesError={
        administeredWorkspacesQuery.error
          ? apiErrorMessage(administeredWorkspacesQuery.error, undefined)
          : undefined
      }
      loading={overviewQuery.isLoading || exportQuery.isLoading}
      error={loadError ? apiErrorMessage(loadError, undefined) : undefined}
      mutating={mutations.isPending}
      onSaveAsset={(input) => mutations.putAsset.mutateAsync(input)}
      onDeleteAsset={(input) => mutations.deleteAsset.mutateAsync(input)}
      onSetDefaultAgent={(input) => mutations.setDefaultAgent.mutateAsync(input)}
      onSetAgentAvailability={(input) => mutations.setAgentAvailability.mutateAsync(input)}
      onRevertAsset={(input) => mutations.revertAsset.mutateAsync(input)}
      onLoadRevisions={(kind, name) =>
        listAll((paging) =>
          client.config_assets.revisions.list({ params: { kind, name }, query: paging })
        )
      }
      onReload={() =>
        queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.configAssetsOverview(apiBaseUrl, authScope)
        })
      }
    />
  );
}

function namedBundleEntries(
  configs: Array<Record<string, unknown>> | undefined
): Array<{ name: string; config: Record<string, unknown> }> {
  return (configs ?? []).flatMap((config) => {
    const name = config.name;
    return typeof name === "string" ? [{ name, config }] : [];
  });
}
