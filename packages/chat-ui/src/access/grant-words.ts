import type { GrantableAction } from "@vivd-catalyst/core";
import type { TranslationKey } from "../i18n";
import type { GrantKind, GrantScopeKind, GrantVerb } from "./access-model";

/**
 * The words of this page for what core lets it grant. Each table is typed by the kinds or the
 * verbs of core's grantable actions, so a kind or a verb core adds does not compile until it has
 * its words here. Nothing else on the page lists kinds or verbs.
 */
export const verbLabelKeys: Record<GrantVerb, TranslationKey> = {
  read: "access.actionRead",
  use: "access.actionUse",
  write: "access.actionWrite",
  publish: "access.actionPublish",
  delete: "access.actionDelete"
};

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
  guardrail: "access.kindGuardrail"
} as const satisfies Record<GrantKind, TranslationKey> & Record<string, TranslationKey>;

/** The label of a registered asset kind; nothing for a kind this interface has no name for. */
export function assetKindLabelKey(kind: string): TranslationKey | undefined {
  return Object.entries(kindLabelKeys).find(([known]) => known === kind)?.[1];
}

/** What the page says of one kind: in a row of the list and at each place of the dialog. */
interface KindWords {
  /** "{action} workflows": a right in a row of the list and in the menu that removes it. */
  actionOnKind: TranslationKey;
  /** "Workflow {name}": one asset as the place of a row. */
  scopeAsset: TranslationKey;
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
    actionOnKind: "access.actionOnAgent",
    scopeAsset: "access.scopeAgent"
  },
  skill: {
    ...configAssetWords,
    actionOnKind: "access.actionOnSkill",
    scopeAsset: "access.scopeSkill"
  },
  connection: {
    actionOnKind: "access.actionOnConnection",
    scopeAsset: "access.scopeConnection",
    onAsset: "access.scopeOnConnection",
    onAssetDescription: "access.scopeOnConnectionDescription",
    assetField: "access.grantConnection",
    chooseAsset: "access.chooseConnection",
    noAssets: "access.noConnections",
    assetsLoadFailed: "access.connectionsLoadFailed"
  },
  workflow: {
    actionOnKind: "access.actionOnWorkflow",
    scopeAsset: "access.scopeWorkflow",
    onAsset: "access.scopeOnWorkflow",
    onAssetDescription: "access.scopeOnWorkflowDescription",
    assetField: "access.grantWorkflow",
    chooseAsset: "access.chooseWorkflow",
    noAssets: "access.noWorkflows",
    assetsLoadFailed: "access.workflowsLoadFailed"
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
  "workflow.publish": "access.actionPublishWorkflowDescription"
};

/**
 * What else a right needs before it does anything, said beside it where the page offers it
 * all the same: an allow of such a right alone changes nothing for the person. A deny of it
 * holds as any deny does, so the note shows for an allow only.
 */
export const rightAllowNoteKeys: Partial<Record<GrantableAction, TranslationKey>> = {
  "workflow.publish": "access.actionPublishWorkflowNote"
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
