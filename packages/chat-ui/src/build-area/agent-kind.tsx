import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useState } from "react";
import { Badge } from "@vivd-catalyst/ui";
import { useAgentPlacementMutations } from "../api/workspace-mutations";
import { useAdministeredCollaborationWorkspacesQuery } from "../api/workspace-queries";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { canManageAgentModels } from "../control-plane/governance";
import { useTranslation } from "../i18n";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorMessage } from "../workspace-utils";
import { AgentAvailabilityEditor, AgentEditor } from "./agent-editor";
import { agentConfigToForm, startedAgentForm } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";

/** How many skills the chooser of an agent asks the instance for with one search. */
const SKILL_CHOICE_PAGE_SIZE = 50;

export const agentKind: BuildAssetKind = {
  kind: "agent",
  path: "agents",
  label: "build.kindAgents",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  titleLabel: "configDisplayName",
  deleteTitle: "configDeleteAgentTitle",
  deleteDescription: "configDeleteAgentDescription",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: Bot,
  avatar: "agent",
  badges: (asset, t) => (asset.isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null),
  Editor: AgentAssetEditor
};

/** The agent form on the asset page, with what it reads beside the agent and the changes it can make. */
function AgentAssetEditor(frame: BuildAssetEditorProps) {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const { locale, t } = useTranslation();
  const { asset, start, instanceWrite } = frame;
  const management = config.features.configAssets;
  const api = { apiBaseUrl, authScope, client };
  const placement = useAgentPlacementMutations(api);
  // What an agent may refer to. A reader the instance does not tell sees the agent's own
  // tools and models and nothing to add.
  const referencesQuery = useQuery({
    queryKey: workspaceQueryKeys.platformReferences(apiBaseUrl, authScope),
    queryFn: ({ signal }) => client.platform.references.get({ signal }),
    retry: false
  });
  const [skillSearch, setSkillSearch] = useState("");
  const skillsQuery = useQuery({
    queryKey: [...workspaceQueryKeys.assets(apiBaseUrl, authScope), "choice", "skill", skillSearch],
    queryFn: ({ signal }) =>
      client.assets.list({
        params: { kind: "skill" },
        query: { limit: SKILL_CHOICE_PAGE_SIZE, ...(skillSearch ? { text: skillSearch } : {}) },
        signal
      }),
    placeholderData: (previous) => previous
  });
  const administeredWorkspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    ...api,
    enabled: instanceWrite && asset !== undefined
  });
  // The default and the availability are stored beside the agent. A change of either leaves
  // the form alone, so the page keeps what it was told and what it changed itself.
  const [isDefault, setIsDefault] = useState(asset?.isDefault === true);
  const [availability, setAvailability] = useState(asset?.availability);

  return (
    <AgentEditor
      frame={frame}
      initialForm={
        asset
          ? agentConfigToForm(asset.config)
          : startedAgentForm(start ?? { name: "", title: "" }, locale === "de" ? "de" : "en")
      }
      isDefault={isDefault}
      references={referencesQuery.data}
      editableAgentFields={management.editableAgentFields}
      canManageAgentModels={canManageAgentModels(user)}
      skillChoice={{
        options: (skillsQuery.data?.items ?? []).map((skill) => ({
          name: skill.name,
          title: skill.title
        })),
        onSearch: (text) => setSkillSearch(text.trim())
      }}
      onMakeDefault={
        asset && !isDefault && instanceWrite && management.allowDefaultAgentChange
          ? () =>
              placement.setDefaultAgent.mutateAsync({ agentName: asset.name }).then(
                () => {
                  setIsDefault(true);
                  return undefined;
                },
                (error: unknown) => apiErrorMessage(error, t("configChangeSaveFailed"))
              )
          : undefined
      }
      availability={
        asset && instanceWrite ? (
          <AgentAvailabilityEditor
            availability={availability}
            isDefault={isDefault}
            workspaces={administeredWorkspacesQuery.data ?? []}
            workspacesError={
              administeredWorkspacesQuery.error
                ? apiErrorMessage(administeredWorkspacesQuery.error, undefined)
                : undefined
            }
            mutating={placement.setAgentAvailability.isPending}
            onSave={(next) =>
              placement.setAgentAvailability.mutateAsync({ name: asset.name, ...next }).then(
                (saved) => {
                  setAvailability(saved);
                  return undefined;
                },
                (error: unknown) => apiErrorMessage(error, t("configChangeSaveFailed"))
              )
            }
          />
        ) : undefined
      }
    />
  );
}
