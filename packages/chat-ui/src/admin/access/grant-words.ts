import type { GrantableAction } from "@work-shape/catalyst-core";
import type { TranslationKey } from "../../shared/i18n";
import type { GrantKind, GrantScopeKind } from "./access-model";
import { agentKind } from "./kinds/agent";
import { appKind } from "./kinds/app";
import { connectionKind } from "./kinds/connection";
import { dataStoreKind } from "./kinds/data-store";
import type { GrantKindEntry, KindWords } from "./kinds/entry";
import { feedbackKind } from "./kinds/feedback";
import { guardrailKind } from "./kinds/guardrail";
import { knowledgeBaseKind } from "./kinds/knowledge-base";
import { jobsKind } from "./kinds/jobs";
import { systemKind } from "./kinds/system";
import { mailSenderKind } from "./kinds/mail-sender";
import { rolesKind } from "./kinds/roles";
import { servicePrincipalsKind } from "./kinds/service-principals";
import { skillKind } from "./kinds/skill";
import { usageKind } from "./kinds/usage";
import { usersKind } from "./kinds/users";
import { workflowKind } from "./kinds/workflow";
import { workspaceKind } from "./kinds/workspace";

// The words of this page for what core lets it grant, one file per kind under `kinds/`. The
// table is typed by the kinds of core's grantable actions, so a kind core adds does not compile
// until it has its words here. The verbs are the rights screens' one table, in `right-words.ts`.

/**
 * Every asset kind an instance can register, with its words. A kind added to the platform gets
 * its entry here: a test holds the registry of an instance against this list.
 */
export const grantKinds: { [Kind in GrantKind]: GrantKindEntry<Kind> } = {
  agent: agentKind,
  skill: skillKind,
  connection: connectionKind,
  app: appKind,
  workflow: workflowKind,
  knowledge_base: knowledgeBaseKind,
  data_store: dataStoreKind,
  guardrail: guardrailKind,
  mail_sender: mailSenderKind,
  feedback: feedbackKind,
  usage: usageKind,
  workspace: workspaceKind,
  roles: rolesKind,
  users: usersKind,
  jobs: jobsKind,
  system: systemKind,
  service_principals: servicePrincipalsKind
};

function entryOf(kind: string): GrantKindEntry<GrantKind> | undefined {
  return Object.entries(grantKinds).find(([known]) => known === kind)?.[1];
}

/** The label of a registered asset kind; nothing for a kind this interface has no name for. */
export function assetKindLabelKey(kind: string): TranslationKey | undefined {
  return entryOf(kind)?.label;
}

/** The words of a kind a row names; nothing for a kind this page writes no right on. */
export function wordsOfKind(kind: string): KindWords | undefined {
  return entryOf(kind)?.words;
}

type ActionKeys = Partial<Record<GrantableAction, TranslationKey>>;

/**
 * What a right allows, as the dialog says it under the action, for the rights whose verb alone
 * does not say it. A right without a sentence shows its verb.
 */
export const rightSentenceKeys: ActionKeys = Object.values(grantKinds).reduce<ActionKeys>(
  (keys, entry) => ({ ...keys, ...entry.sentences }),
  {}
);

/** The sentence of one right, by any action's name; nothing for a right without one. */
export function rightSentenceKey(action: string): TranslationKey | undefined {
  return Object.entries(rightSentenceKeys).find(([known]) => known === action)?.[1];
}

/**
 * Extra requirements for giving an allow, shown beside the action. Publishing checks the
 * principal's rights; reserved run-data access already checks the draft and published
 * principals when granted, although no operation uses it yet. The note shows for an allow only.
 */
export const rightAllowNoteKeys: ActionKeys = Object.values(grantKinds).reduce<ActionKeys>(
  (keys, entry) => ({ ...keys, ...entry.allowNotes }),
  {}
);

/** Where a grant applies, as the dialog offers the places for one kind. */
export function scopeChoice(
  scopeKind: GrantScopeKind,
  kind: GrantKind
): { label: TranslationKey; description: TranslationKey } {
  const words = grantKinds[kind].words;
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
