import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@vivd-catalyst/ui";
import { useAgentPlacementMutations } from "../api/agent-placement-mutations";
import {
  useAdministeredCollaborationWorkspacesQuery,
  usePlatformContextQuery
} from "../api/workspace-queries";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import { canManageAgentModels } from "../control-plane/governance";
import { useTranslation } from "../i18n";
import { useAppToolsRead } from "../apps/app-tools-group";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorMessage } from "../workspace-utils";
import { AgentAvailabilityEditor, AgentEditor } from "./agent-editor";
import { agentConfigToForm, startedAgentForm } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { AGENT_ASSET_KIND } from "./build-rights";
import { AGENTS_BUILD_PATH } from "./build-route";
import { useConnectionToolChoice } from "./connection-tools";
import { useKnowledgeBaseSource } from "./knowledge-base-source";
import { skillFacts } from "./skill-facts";

/** How many skills the chooser of an agent asks the instance for with one search. */
const SKILL_CHOICE_PAGE_SIZE = 50;

export const agentKind: BuildAssetKind = {
  kind: AGENT_ASSET_KIND,
  path: AGENTS_BUILD_PATH,
  label: "build.kindAgents",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  titleLabel: "configDisplayName",
  deleteTitle: "configDeleteAgentTitle",
  deleteDescription: "configDeleteAgentDescription",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: "agent",
  avatar: "agent",
  // A row says what the agent does, as its card on the Agents page does, and never its id.
  row: (asset) => ({ description: asset.description?.trim() || undefined }),
  badges: (asset, t) => (asset.isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null),
  Editor: AgentAssetEditor,
  startsInWorkspace: true
};

/** The agent form on the asset page, with what it reads beside the agent and the changes it can make. */
function AgentAssetEditor(frame: BuildAssetEditorProps) {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const { locale, t } = useTranslation();
  const { asset, start, instanceWrite, owner } = frame;
  const management = config.features.configAssets;
  const api = { apiBaseUrl, authScope, client };
  const placement = useAgentPlacementMutations({
    ...api,
    heldMessage: t("configChangeWaitsForApproval")
  });
  // What an agent may refer to. A reader the instance does not tell sees the agent's own
  // tools and models and nothing to add.
  const referencesQuery = useQuery({
    queryKey: workspaceQueryKeys.platformReferences(apiBaseUrl, authScope),
    queryFn: ({ signal }) => client.platform.references.get({ signal }),
    retry: false
  });
  const connectionTools = useConnectionToolChoice();
  const appTools = useAppToolsRead();
  const [skillSearch, setSkillSearch] = useState("");
  // An agent names skills of its own owner and of the instance: a workspace's agent is offered
  // that workspace's skills first, then the instance's own.
  const skillsQuery = useQuery({
    queryKey: [
      ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
      "choice",
      "skill",
      owner ?? "",
      skillSearch
    ],
    queryFn: async ({ signal }) => {
      const query = {
        limit: SKILL_CHOICE_PAGE_SIZE,
        ...(skillSearch ? { text: skillSearch } : {})
      };
      const [own, instance] = await Promise.all([
        owner === undefined
          ? undefined
          : client.assets.list({
              params: { kind: "skill" },
              query: { ...query, workspaceId: owner },
              signal
            }),
        client.assets.list({ params: { kind: "skill" }, query, signal })
      ]);
      return { items: [...(own?.items ?? []), ...instance.items] };
    },
    placeholderData: (previous) => previous
  });
  // The Knowledge Bases are offered where the instance has the kind: its module is on.
  const context = usePlatformContextQuery({ ...api, enabled: true }).data;
  const knowledgeOn = context?.kinds.some((kind) => kind.kind === "knowledge_base") ?? false;
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const knowledgeRead = useKnowledgeBaseSource().useKnowledgeBases(knowledgeSearch, knowledgeOn);
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
      referencesLoading={referencesQuery.isPending}
      editableAgentFields={management.editableAgentFields}
      canManageAgentModels={canManageAgentModels(user)}
      skillChoice={{
        options: (skillsQuery.data?.items ?? []).map((skill) => ({
          name: skill.name,
          title: skill.title,
          ...skillFacts(skill)
        })),
        onSearch: (text) => setSkillSearch(text.trim())
      }}
      knowledgeChoice={
        knowledgeOn
          ? {
              options: knowledgeRead.status === "ready" ? knowledgeRead.data : [],
              onSearch: (text) => setKnowledgeSearch(text.trim())
            }
          : undefined
      }
      connectionTools={connectionTools}
      appTools={appTools}
      onMakeDefault={
        asset && !isDefault && instanceWrite && management.allowDefaultAgentChange
          ? () =>
              placement.setDefaultAgent
                .mutateAsync({ agentName: asset.name, assetId: asset.id })
                .then(
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
              placement.setAgentAvailability
                .mutateAsync({ name: asset.name, assetId: asset.id, loaded: availability, ...next })
                .then(
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
