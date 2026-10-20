import type { GrantableAction } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";
import type { GrantKind, GrantScopeKind } from "./access-model";

// The words of this page for what core lets it grant. Each table is typed by the kinds of core's
// grantable actions, so a kind core adds does not compile until it has its words here. The verbs
// are the rights screens' one table, in `right-words.ts`.

/**
 * The name of every asset kind an instance can register, in the plural. A kind added to the
 * platform gets its entry here: a test holds the registry of an instance against this list.
 */
export const kindLabelKeys = {
  agent: "access.kindAgent",
  skill: "access.kindSkill",
  connection: "access.kindConnection",
  app: "access.kindApp",
  workflow: "access.kindWorkflow",
  knowledge_base: "access.kindKnowledgeBase",
  data_store: "access.kindDataStore",
  guardrail: "access.kindGuardrail",
  mail_sender: "access.kindMailSender",
  feedback: "access.kindFeedback",
  workspace: "access.kindWorkspace"
} as const satisfies Record<GrantKind, TranslationKey> & Record<string, TranslationKey>;

/** The label of a registered asset kind; nothing for a kind this interface has no name for. */
export function assetKindLabelKey(kind: string): TranslationKey | undefined {
  return Object.entries(kindLabelKeys).find(([known]) => known === kind)?.[1];
}

/** What the page says of one kind: in a row of the list and at each place of the dialog. */
interface KindWords {
  /** "Workflow {name}": one asset as the place of a row. */
  scopeAsset: TranslationKey;
  /** "the Workflow {name}": one asset as what a row's sentence allows or refuses. */
  object: TranslationKey;
  /** The choice of one asset as the place, and what it means. */
  onAsset: TranslationKey;
  onAssetDescription: TranslationKey;
  /** The field that picks the asset: its label and what it says while nothing is chosen. */
  assetField: TranslationKey;
  chooseAsset: TranslationKey;
  /** What the field says where the instance has none of the kind and where they did not load. */
  noAssets: TranslationKey;
  assetsLoadFailed: TranslationKey;
}

const configAssetWords = {
  onAsset: "access.scopeOnAsset",
  onAssetDescription: "access.scopeOnAssetDescription",
  assetField: "access.grantAsset",
  chooseAsset: "access.chooseAsset",
  noAssets: "access.noAssets",
  assetsLoadFailed: "access.referencesLoadFailed"
} as const satisfies Partial<KindWords>;

export const kindWords: Record<GrantKind, KindWords> = {
  agent: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  skill: {
    ...configAssetWords,
    scopeAsset: "access.scopeSkill",
    object: "access.objectSkill"
  },
  connection: {
    scopeAsset: "access.scopeConnection",
    object: "access.objectConnection",
    onAsset: "access.scopeOnConnection",
    onAssetDescription: "access.scopeOnConnectionDescription",
    assetField: "access.grantConnection",
    chooseAsset: "access.chooseConnection",
    noAssets: "access.noConnections",
    assetsLoadFailed: "access.connectionsLoadFailed"
  },
  app: {
    scopeAsset: "access.scopeApp",
    object: "access.objectApp",
    onAsset: "access.scopeOnApp",
    onAssetDescription: "access.scopeOnAppDescription",
    assetField: "access.grantApp",
    chooseAsset: "access.chooseApp",
    noAssets: "access.noApps",
    assetsLoadFailed: "access.appsLoadFailed"
  },
  data_store: {
    scopeAsset: "access.scopeDataStore",
    object: "access.objectDataStore",
    onAsset: "access.scopeOnDataStore",
    onAssetDescription: "access.scopeOnDataStoreDescription",
    assetField: "access.grantDataStore",
    chooseAsset: "access.chooseDataStore",
    noAssets: "access.noDataStores",
    assetsLoadFailed: "access.dataStoresLoadFailed"
  },
  workflow: {
    scopeAsset: "access.scopeWorkflow",
    object: "access.objectWorkflow",
    onAsset: "access.scopeOnWorkflow",
    onAssetDescription: "access.scopeOnWorkflowDescription",
    assetField: "access.grantWorkflow",
    chooseAsset: "access.chooseWorkflow",
    noAssets: "access.noWorkflows",
    assetsLoadFailed: "access.workflowsLoadFailed"
  },
  knowledge_base: {
    scopeAsset: "access.scopeKnowledgeBase",
    object: "access.objectKnowledgeBase",
    onAsset: "access.scopeOnKnowledgeBase",
    onAssetDescription: "access.scopeOnKnowledgeBaseDescription",
    assetField: "access.grantKnowledgeBase",
    chooseAsset: "access.chooseKnowledgeBase",
    noAssets: "access.noKnowledgeBases",
    assetsLoadFailed: "access.knowledgeBasesLoadFailed"
  },
  // `guardrail.publish` is granted for one workspace only: the asset words name no choice
  // the dialog offers.
  guardrail: {
    scopeAsset: "access.scopeGuardrail",
    object: "access.objectGuardrail",
    onAsset: "access.scopeOnGuardrail",
    onAssetDescription: "access.scopeOnGuardrailDescription",
    assetField: "access.grantGuardrail",
    chooseAsset: "access.chooseGuardrail",
    noAssets: "access.noGuardrails",
    assetsLoadFailed: "access.guardrailsLoadFailed"
  },
  // `mail_sender.use` is granted on one sender, `system`, while outbound mail is on. It is no
  // asset kind the dialog lists; a row given through the API is shown and revoked here.
  mail_sender: {
    scopeAsset: "access.scopeMailSender",
    object: "access.objectMailSender",
    onAsset: "access.scopeOnMailSender",
    onAssetDescription: "access.scopeOnMailSenderDescription",
    assetField: "access.grantMailSender",
    chooseAsset: "access.chooseMailSender",
    noAssets: "access.noMailSenders",
    assetsLoadFailed: "access.mailSendersLoadFailed"
  },
  // `feedback.review` is granted on a workspace or the instance: the asset words name no
  // choice the dialog offers.
  feedback: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  // Builder and Publisher are granted in one workspace only: the asset words name no choice
  // the dialog offers.
  workspace: {
    ...configAssetWords,
    scopeAsset: "access.scopeWorkspace",
    object: "access.objectWorkspace"
  }
};

/** The words of a kind a row names; nothing for a kind this page writes no right on. */
export function wordsOfKind(kind: string): KindWords | undefined {
  return Object.entries(kindWords).find(([known]) => known === kind)?.[1];
}

/**
 * What a right allows, as the dialog says it under the action, for the rights whose verb alone
 * does not say it. A right without a sentence shows its verb.
 */
export const rightSentenceKeys: Partial<Record<GrantableAction, TranslationKey>> = {
  "connection.read": "access.actionReadConnectionDescription",
  "connection.use": "access.actionUseConnectionDescription",
  "workflow.read": "access.actionReadWorkflowDescription",
  "workflow.use": "access.actionUseWorkflowDescription",
  "workflow.write": "access.actionWriteWorkflowDescription",
  "workflow.publish": "access.actionPublishWorkflowDescription",
  "workflow.delete": "access.actionDeleteWorkflowDescription",
  "workflow.read_run_data": "access.actionReadRunDataWorkflowDescription",
  "knowledge_base.read": "access.actionReadKnowledgeBaseDescription",
  "knowledge_base.use": "access.actionUseKnowledgeBaseDescription",
  "knowledge_base.write": "access.actionWriteKnowledgeBaseDescription",
  "knowledge_base.publish": "access.actionPublishKnowledgeBaseDescription",
  "knowledge_base.delete": "access.actionDeleteKnowledgeBaseDescription",
  "data_store.execute": "access.actionExecuteDataStoreDescription",
  "guardrail.publish": "access.actionPublishGuardrailDescription",
  "feedback.review": "access.actionReviewFeedbackDescription",
  builder: "access.actionBuilderDescription",
  publisher: "access.actionPublisherDescription"
};

/**
 * Extra requirements for giving an allow, shown beside the action. Publishing checks the
 * principal's rights; reserved run-data access already checks the draft and published
 * principals when granted, although no operation uses it yet. The note shows for an allow only.
 */
export const rightAllowNoteKeys: Partial<Record<GrantableAction, TranslationKey>> = {
  "workflow.publish": "access.actionPublishWorkflowNote",
  "workflow.read_run_data": "access.actionReadRunDataWorkflowNote"
};

/** Where a grant applies, as the dialog offers the places for one kind. */
export function scopeChoice(
  scopeKind: GrantScopeKind,
  kind: GrantKind
): { label: TranslationKey; description: TranslationKey } {
  const words = kindWords[kind];
  switch (scopeKind) {
    case "workspace":
      return {
        label: "access.scopeInWorkspace",
        description: "access.scopeInWorkspaceDescription"
      };
    case "asset":
      return { label: words.onAsset, description: words.onAssetDescription };
    case "instance":
      return {
        label: "access.scopeWholeInstance",
        description: "access.scopeWholeInstanceDescription"
      };
  }
}
