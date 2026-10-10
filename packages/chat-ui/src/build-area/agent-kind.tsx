import { Bot } from "lucide-react";
import { listAll } from "@vivd-catalyst/api-client";
import { Badge } from "@vivd-catalyst/ui";
import { useConfigAssetMutations } from "../api/workspace-mutations";
import { useAdministeredCollaborationWorkspacesQuery } from "../api/workspace-queries";
import {
  AgentAvailabilityEditor,
  AgentEditor,
  RevisionHistory
} from "../control-plane/config-asset-editors";
import {
  agentAvailabilitySummary,
  agentConfigToForm,
  editedAgentConfig,
  emptyAgentForm,
  localizedToPair
} from "../control-plane/config-assets-model";
import { canManageAgentModels } from "../control-plane/governance";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorMessage } from "../workspace-utils";
import type {
  BuildAsset,
  BuildAssetEditorProps,
  BuildAssetKind,
  BuildKindTexts
} from "./build-asset-kind";
import { useConfigAssetsData } from "./build-data";

export const agentKind: BuildAssetKind = {
  kind: "agent",
  path: "agents",
  label: "build.kindAgents",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: Bot,
  avatar: "agent",
  title(asset, locale) {
    const name = localizedToPair(asset.config.displayName);
    const other = locale === "de" ? "en" : "de";
    return name[locale].trim() || name[other].trim() || undefined;
  },
  status: availabilityLabel,
  badges: (asset, { t }) => (asset.isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null),
  Editor: AgentAssetEditor
};

/** Where the agent can be chosen, in one line. An agent without availability is hidden. */
function availabilityLabel(asset: BuildAsset, { t, locale }: BuildKindTexts): string {
  const summary = agentAvailabilitySummary(asset.summary?.availability);
  if (summary.kind === "all") return t("configAvailabilityAll");
  if (summary.kind === "hidden") return t("configAvailabilityHidden");
  if (summary.kind === "personal") return t("configAvailabilityPersonal");
  const count = summary.count.toLocaleString(locale);
  return summary.personalWorkspaces
    ? t("configAvailabilityPersonalPlus", { count })
    : t(
        summary.count === 1
          ? "configAvailabilityWorkspaceCount"
          : "configAvailabilityWorkspaceCountPlural",
        { count }
      );
}

/** Today's agent form on the asset page, with the changes it can make. */
function AgentAssetEditor({
  asset,
  back,
  onUnsavedChange,
  run,
  onCreated,
  onDeleted,
  onReloaded
}: BuildAssetEditorProps) {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const management = config.features.configAssets;
  const data = useConfigAssetsData();
  const mutations = useConfigAssetMutations({ apiBaseUrl, authScope, client });
  const administeredWorkspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: true
  });
  const version = data.overview?.version;
  const skillNames =
    data.kinds.find((kind) => kind.kind === "skill")?.assets.map((skill) => skill.name) ?? [];
  const manageModels = canManageAgentModels(user);

  return (
    <AgentEditor
      back={back}
      onUnsavedChange={onUnsavedChange}
      initialForm={asset ? agentConfigToForm(asset.config) : emptyAgentForm()}
      isNew={asset === undefined}
      isDefault={asset?.isDefault ?? false}
      references={data.overview?.references}
      editableAgentFields={management.editableAgentFields}
      canManageAgentModels={manageModels}
      skillNames={skillNames}
      mutating={mutations.isPending}
      onSave={(form) =>
        run(() =>
          mutations.putAsset
            .mutateAsync({
              kind: "agent",
              name: form.name.trim(),
              config: editedAgentConfig(form, asset?.config),
              baseVersion: version
            })
            .then(() => {
              if (!asset) {
                onCreated(form.name.trim());
              }
            })
        )
      }
      onDelete={
        asset && management.allowAgentDeletion
          ? () =>
              run(() =>
                mutations.deleteAsset
                  .mutateAsync({ kind: "agent", name: asset.name, baseVersion: version })
                  .then(onDeleted)
              )
          : undefined
      }
      onMakeDefault={
        asset && !asset.isDefault && management.allowDefaultAgentChange
          ? () =>
              run(() =>
                mutations.setDefaultAgent.mutateAsync({
                  agentName: asset.name,
                  baseVersion: version
                })
              )
          : undefined
      }
      availability={
        asset ? (
          <AgentAvailabilityEditor
            availability={asset.summary?.availability}
            isDefault={asset.isDefault}
            workspaces={administeredWorkspacesQuery.data ?? []}
            workspacesError={
              administeredWorkspacesQuery.error
                ? apiErrorMessage(administeredWorkspacesQuery.error, undefined)
                : undefined
            }
            mutating={mutations.isPending}
            onSave={(availability) =>
              run(() =>
                mutations.setAgentAvailability.mutateAsync({ name: asset.name, ...availability })
              )
            }
          />
        ) : null
      }
      revisions={
        asset ? (
          <RevisionHistory
            kind="agent"
            name={asset.name}
            mutating={mutations.isPending}
            onLoadRevisions={(kind, name) =>
              listAll((paging) =>
                client.assets.revisions.list({ params: { kind, name }, query: paging })
              )
            }
            onRevert={
              management.editableAgentFields.length > 0 || manageModels
                ? (revision) =>
                    run(() =>
                      mutations.revertAsset
                        .mutateAsync({
                          kind: "agent",
                          name: asset.name,
                          revision,
                          baseVersion: version
                        })
                        .then(onReloaded)
                    )
                : undefined
            }
          />
        ) : null
      }
    />
  );
}
