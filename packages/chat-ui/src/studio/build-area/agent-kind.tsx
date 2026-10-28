import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DATA_STORE_ASSET_KIND } from "@work-shape/catalyst-core";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Page, SkeletonPage } from "@work-shape/catalyst-ui";
import { useAgentPlacementMutations } from "../../shared/api/agent-placement-mutations";
import { usePlatformContextQuery } from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { canManageAgentModels } from "../../shared/governance";
import { useTranslation } from "../../shared/i18n";
import { useAppToolsRead } from "../apps/app-tools-group";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorMessage } from "../../shared/workspace-utils";
import { AgentEditor } from "./agent-editor";
import { startAvailability, type AgentCreateCheck } from "./agent-create-review";
import { useAgentUseChoice, useAvailabilityChoice } from "./asset-availability";
import { useAgentDraft } from "./agent-draft-source";
import { agentConfigToForm, startedAgentForm } from "./asset-form-model";
import type { BuildAssetEditorProps, BuildAssetKind } from "./build-asset-kind";
import { AGENT_ASSET_KIND } from "../../shared/build-rights";
import { AGENTS_BUILD_PATH } from "../../shared/build-route";
import { useConnectionToolChoice } from "./connection-tools";
import { useKnowledgeBaseSource } from "./knowledge-base-source";
import { useOwnedChoices, type ListedAsset } from "./owned-choices";
import {
  shareUpTo,
  unreachableReason,
  useUnreachableChoices,
  type UnreachableAsset,
  type UnreachableWords
} from "./unreachable-choices";
import { assetPlace, useKnownWorkspaces, type AssetOwner } from "./asset-place";
import { skillFacts } from "./skill-facts";
import { useAssetShare } from "./asset-share";
import {
  createAssetShareSource,
  type AssetShareSubject,
  type AssetShareTarget
} from "./asset-share-model";
import type { DataStoreChoice } from "./agent-data-stores";
import { unusableDataStoreReason } from "./agent-data-stores-model";

/** How many skills of each owner one page of an agent's chooser asks the instance for. */
const SKILL_CHOICE_PAGE_SIZE = 50;
/** How many Data Stores of each owner one page of an agent's chooser asks the instance for. */
const DATA_STORE_CHOICE_PAGE_SIZE = 50;
/** How many Knowledge Bases of each other place one page of an agent's chooser asks for. */
const KNOWLEDGE_BASE_CHOICE_PAGE_SIZE = 50;
/** Why an agent cannot use a skill of another place: "ihn" in German. */
const SKILL_WORDS: UnreachableWords = {
  cannotAll: "build.skillCannotAll",
  cannotMine: "build.skillCannotMine",
  cannotIn: "build.skillCannotIn"
};
/** Why an agent cannot use a Knowledge Base of another place: "sie" in German. */
const KNOWLEDGE_WORDS: UnreachableWords = {
  cannotAll: "knowledge.agentCannotAll",
  cannotMine: "knowledge.agentCannotMine",
  cannotIn: "knowledge.agentCannotIn"
};

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
  // The skills of the reader's other places, which this agent cannot use: the chooser shows
  // them greyed with the reason, so nobody wonders where they went (SCOPE-WORDS). Each offers
  // "Für alle teilen…" or "Mit {team} teilen…" (SHARE-1) where the ladder goes up to the
  // agent's place: the dialog opens there, and once the skill moved the chooser offers it.
  const choiceShare = useAgentChoiceShare();
  const greyed = useGreyedChoices(owner, choiceShare.start);
  const unusable = greyed(
    useUnreachableChoices({
      kind: "skill",
      owner,
      search: skillSearch,
      limit: SKILL_CHOICE_PAGE_SIZE,
      enabled: true
    }),
    SKILL_WORDS
  ).map(({ asset, ...rest }) => ({
    name: asset.name,
    title: asset.title,
    ...skillFacts(asset),
    ...rest
  }));
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
  // Those of the reader's other places, greyed with the reason, as its skills.
  const unusableKnowledge = greyed(
    useUnreachableChoices({
      kind: "knowledge_base",
      owner,
      search: knowledgeSearch,
      limit: KNOWLEDGE_BASE_CHOICE_PAGE_SIZE,
      enabled: knowledgeOn
    }),
    KNOWLEDGE_WORDS
  ).map(({ asset, ...rest }) => ({
    name: asset.name,
    title: asset.title,
    ...(asset.description ? { description: asset.description } : {}),
    ...rest
  }));
  // The Data Stores, where the instance has the kind: of the agent's own place and of everyone,
  // as its skills (AGENT-DATA-1).
  const dataStoreChoice = useDataStoreChoice(
    owner,
    context?.kinds.some((kind) => kind.kind === DATA_STORE_ASSET_KIND) ?? false
  );
  // The default and the availability are stored beside the agent. A change of either leaves
  // the form alone, so the page keeps what it was told and what it changed itself.
  const [isDefault, setIsDefault] = useState(asset?.isDefault === true);
  const availability = useAvailabilityChoice(frame, "agent");
  const agentUse = useAgentUseChoice(frame);
  // A new agent is checked before its create for what it would use that members where it
  // starts could not use. One that starts hidden is checked too: the instance's first agent
  // becomes its default, available everywhere.
  const availableIn = start?.availableIn;
  const createCheck: AgentCreateCheck | undefined =
    asset !== undefined
      ? undefined
      : {
          availability: startAvailability(availableIn),
          workspaceName: (id) =>
            availableIn !== undefined && availableIn !== "all" && id === availableIn.workspaceId
              ? start?.availableInName
              : undefined,
          read: (config) =>
            client.assets
              .validate({
                params: { kind: AGENT_ASSET_KIND },
                body: {
                  config,
                  availability: startAvailability(availableIn),
                  ...(owner === undefined ? {} : { workspaceId: owner })
                }
              })
              .then((answer) => {
                // A definition that does not validate goes on to the create's own refusal.
                if (!answer.valid) return null;
                // A valid answer without the list says nothing of what is missing: no create.
                if (answer.dependencyAvailability === undefined) {
                  throw new Error("The instance answered the check without its dependencies");
                }
                return answer.dependencyAvailability;
              })
        };
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
    <>
      {choiceShare.dialog}
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
          onSearch: (text) => setSkillSearch(text.trim()),
          unusable
        }}
        knowledgeChoice={
          knowledgeOn
            ? {
                options: knowledgeRead.status === "ready" ? knowledgeRead.data.items : [],
                ...(knowledgeRead.status === "ready" && knowledgeRead.data.more !== undefined
                  ? { more: knowledgeRead.data.more }
                  : {}),
                onSearch: (text) => setKnowledgeSearch(text.trim()),
                workspaceOwned: owner !== undefined,
                unusable: unusableKnowledge
              }
            : undefined
        }
        {...(dataStoreChoice === undefined ? {} : { dataStoreChoice })}
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
        {...(availability === undefined ? {} : { availability })}
        {...(agentUse === undefined ? {} : { agentUse })}
        {...(createCheck === undefined ? {} : { createCheck })}
      />
    </>
  );
}

/**
 * "Teilen…" from an agent's chooser (SHARE-1): a greyed asset of the reader's own is shared up
 * to the agent's place in the same dialog as on its page. A move reads the choosers again.
 */
function useAgentChoiceShare(): {
  start(subject: AssetShareSubject, to: AssetShareTarget): void;
  dialog: ReactNode;
} {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const queryClient = useQueryClient();
  const source = useMemo(
    () =>
      createAssetShareSource(client, () => {
        queryClient
          .invalidateQueries({ queryKey: workspaceQueryKeys.assets(apiBaseUrl, authScope) })
          .catch(() => undefined);
      }),
    [apiBaseUrl, authScope, client, queryClient]
  );
  const [subject, setSubject] = useState<AssetShareSubject>();
  const share = useAssetShare({
    source,
    subject,
    canShare: true,
    onMoved: () => setSubject(undefined)
  });
  return {
    start: (next, to) => {
      setSubject(next);
      share.open(to);
    },
    dialog: share.dialog
  };
}

/** A greyed row of an agent's chooser: the asset, why the agent cannot use it, and the share. */
interface GreyedChoice {
  asset: ListedAsset;
  reason: string;
  share?: { label: string; onSelect(): void };
}

/**
 * Turns the assets of the reader's other places into greyed rows for an agent of `owner`: the
 * reason in the words of the kind, and "Teilen…" where the asset can go up to the agent's place.
 */
function useGreyedChoices(
  owner: string | undefined,
  share: (subject: AssetShareSubject, to: AssetShareTarget) => void
): (assets: readonly UnreachableAsset[], words: UnreachableWords) => GreyedChoice[] {
  const { t } = useTranslation();
  const workspaces = useKnownWorkspaces();
  const agent: AssetOwner =
    owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner };
  const agentPlace = assetPlace(agent, workspaces, t);
  return (assets, words) =>
    assets.map(({ asset, owner: assetOwner }) => {
      const up = shareUpTo(assetOwner, agent, workspaces, t);
      return {
        asset,
        reason: unreachableReason(assetPlace(assetOwner, workspaces, t), agentPlace, t, words),
        ...(up === undefined
          ? {}
          : {
              share: {
                label: up.label,
                onSelect: () =>
                  share(
                    {
                      kind: asset.kind,
                      name: asset.name,
                      title: asset.title || asset.name,
                      id: asset.id,
                      owner: assetOwner
                    },
                    up.to
                  )
              }
            })
      };
    });
}

/**
 * The Data Stores an agent's Data section offers: those of its own place and of everyone, and,
 * greyed with the reason, those of the reader's other places, which the agent cannot use (the
 * one owner check refuses them). Nothing where the instance has no Data Stores.
 */
function useDataStoreChoice(
  owner: string | undefined,
  enabled: boolean
): DataStoreChoice | undefined {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const usable = useOwnedChoices(
    client,
    [
      ...workspaceQueryKeys.assets(apiBaseUrl, authScope),
      "choice",
      DATA_STORE_ASSET_KIND,
      owner ?? "",
      search
    ],
    { kind: DATA_STORE_ASSET_KIND, owner, search, limit: DATA_STORE_CHOICE_PAGE_SIZE },
    (store) => ({
      name: store.name,
      title: store.title,
      ...(store.description ? { description: store.description } : {})
    }),
    enabled
  ).choices;
  // The reader's other places, whose stores the one owner check refuses for this agent.
  const workspaces = useKnownWorkspaces();
  const others = useUnreachableChoices({
    kind: DATA_STORE_ASSET_KIND,
    owner,
    search,
    limit: DATA_STORE_CHOICE_PAGE_SIZE,
    enabled
  });
  if (!enabled) return undefined;
  const agentPlace = assetPlace(
    owner === undefined ? { kind: "instance" } : { kind: "workspace", workspaceId: owner },
    workspaces,
    t
  );
  const unusable = others.map(({ asset: store, owner: storeOwner }) => ({
    name: store.name,
    title: store.title,
    reason: unusableDataStoreReason(assetPlace(storeOwner, workspaces, t), agentPlace, t)
  }));
  return {
    options: usable?.items ?? [],
    ...(usable?.more === undefined ? {} : { more: usable.more }),
    onSearch: (text) => setSearch(text.trim()),
    unusable
  };
}
