import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Page, SkeletonPage } from "@work-shape/catalyst-ui";
import { useAgentPlacementMutations } from "../../shared/api/agent-placement-mutations";
import {
  useAdministeredCollaborationWorkspacesQuery,
  usePlatformContextQuery
} from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { canManageAgentModels } from "../../shared/governance";
import { useTranslation } from "../../shared/i18n";
import { useAppToolsRead } from "../apps/app-tools-group";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorMessage } from "../../shared/workspace-utils";
import { AgentEditor } from "./agent-editor";
import { useAgentDraft } from "./agent-draft-source";
import { agentConfigToForm, startedAgentForm } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { AGENTS_BUILD_PATH } from "../../shared/build-route";
import { useConnectionToolChoice } from "./connection-tools";
import { useKnowledgeBaseSource } from "./knowledge-base-source";
import { useOwnedChoices } from "./owned-choices";
import { skillFacts } from "./skill-facts";

/** How many skills of each owner one page of an agent's chooser asks the instance for. */
const SKILL_CHOICE_PAGE_SIZE = 50;

export const agentKind: BuildAssetKind = {
  kind: AGENT_ASSET_KIND,
  path: AGENTS_BUILD_PATH,
  label: "build.kindAgents",
  searchLabel: "build.agentsSearch",
  newLabel: "configNewAgent",
  titleLabel: "configDisplayName",
  purposeLabel: "build.createPurpose",
  deleteTitle: "configDeleteAgentTitle",
  deleteDescription: "configDeleteAgentDescription",
  emptyText: "build.agentsEmpty",
  emptyReadOnlyText: "build.agentsEmptyReadOnly",
  missingText: "build.agentMissing",
  icon: "agent",
  avatar: "agent",
  // A row says what the agent does, as its card on the Agents page does, and never its id.
  row: (asset) => ({ description: asset.description?.trim() || undefined }),
  // The draft badge shows to whom the list names the draft: the holders of the agent's write
  // right (AD-4).
  badges: (asset, t) =>
    asset.agentDraft || asset.isDefault ? (
      <>
        {asset.agentDraft ? (
          <Badge tone="warning" data-build-draft-state="">
            {t("build.draftAhead")}
          </Badge>
        ) : null}
        {asset.isDefault ? <Badge>{t("configDefaultAgent")}</Badge> : null}
      </>
    ) : null,
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
  const appTools = useAppToolsRead(owner);
  const [skillSearch, setSkillSearch] = useState("");
  // An agent names skills of its own owner and of the instance: a workspace's agent is offered
  // that workspace's skills first, then the instance's own.
  const skills = useOwnedChoices(
    client,
    [
      ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
      "choice",
      "skill",
      owner ?? "",
      skillSearch
    ],
    { kind: "skill", owner, search: skillSearch, limit: SKILL_CHOICE_PAGE_SIZE },
    (skill) => ({ name: skill.name, title: skill.title, ...skillFacts(skill) })
  ).choices;
  // The Knowledge Bases are offered where the instance has the kind: its module is on.
  const context = usePlatformContextQuery({ ...api, enabled: true }).data;
  const knowledgeOn = context?.kinds.some((kind) => kind.kind === "knowledge_base") ?? false;
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  // Of its own owner and of the instance, as its skills.
  const knowledgeRead = useKnowledgeBaseSource().useKnowledgeBases(
    knowledgeSearch,
    knowledgeOn,
    owner
  );
  const administeredWorkspacesQuery = useAdministeredCollaborationWorkspacesQuery({
    ...api,
    enabled: instanceWrite && asset !== undefined
  });
  // The default and the availability are stored beside the agent. A change of either leaves
  // the form alone, so the page keeps what it was told and what it changed itself.
  const [isDefault, setIsDefault] = useState(asset?.isDefault === true);
  const [availability, setAvailability] = useState(asset?.availability);
  // The page edits the agent's one draft where it has one: the form waits for its read.
  const draftSource = useAgentDraft({
    agent: asset?.name,
    ...(owner === undefined ? {} : { workspaceId: owner }),
    enabled: frame.canWrite,
    reload: frame.reload ?? (async () => undefined)
  });
  const draft = asset !== undefined && frame.canWrite ? draftSource : undefined;
  if (draft !== undefined && draft.latest === undefined) {
    return (
      <Page ref={frame.page.ref}>
        {frame.page.above}
        <SkeletonPage />
      </Page>
    );
  }

  return (
    <AgentEditor
      frame={frame}
      initialForm={
        draft?.latest
          ? agentConfigToForm(draft.latest.config)
          : asset
            ? agentConfigToForm(asset.config)
            : startedAgentForm(start ?? { name: "", title: "" }, locale === "de" ? "de" : "en")
      }
      isDefault={isDefault}
      {...(draft === undefined ? {} : { draft })}
      references={referencesQuery.data}
      referencesLoading={referencesQuery.isPending}
      editableAgentFields={management.editableAgentFields}
      canManageAgentModels={canManageAgentModels(user)}
      skillChoice={{
        options: skills?.items ?? [],
        ...(skills?.more === undefined ? {} : { more: skills.more }),
        onSearch: (text) => setSkillSearch(text.trim())
      }}
      knowledgeChoice={
        knowledgeOn
          ? {
              options: knowledgeRead.status === "ready" ? knowledgeRead.data.items : [],
              ...(knowledgeRead.status === "ready" && knowledgeRead.data.more !== undefined
                ? { more: knowledgeRead.data.more }
                : {}),
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
        asset && instanceWrite
          ? {
              saved: availability,
              workspaces: administeredWorkspacesQuery.data ?? [],
              workspacesError: administeredWorkspacesQuery.error
                ? apiErrorMessage(administeredWorkspacesQuery.error, undefined)
                : undefined,
              save: (next) =>
                placement.setAgentAvailability
                  .mutateAsync({
                    name: asset.name,
                    assetId: asset.id,
                    loaded: availability,
                    ...next
                  })
                  .then(
                    (saved) => {
                      setAvailability(saved);
                      return undefined;
                    },
                    (error: unknown) => apiErrorMessage(error, t("configChangeSaveFailed"))
                  )
            }
          : undefined
      }
    />
  );
}
