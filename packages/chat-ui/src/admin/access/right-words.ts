import type { PlatformAction } from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

type Translate = TranslationContextValue["t"];

/**
 * The one verb of each action on every rights screen, the same in every dialog, row and
 * refusal (access-and-permissions.md, Words): use verwenden, read ansehen, write bearbeiten,
 * publish veröffentlichen, delete löschen, approve freigeben. Each is the bare infinitive, so a
 * sentence puts it where its language wants it.
 */
export const verbKeys = {
  read: "rights.verbRead",
  use: "rights.verbUse",
  write: "rights.verbWrite",
  publish: "rights.verbPublish",
  delete: "rights.verbDelete",
  approve: "rights.verbApprove"
} as const satisfies Record<string, TranslationKey>;

export type RightVerb = keyof typeof verbKeys;

/** "{verb} agents" for every kind an action names, in the reader's word order. */
const verbOnKindKeys = {
  agent: "rights.verbOnAgents",
  skill: "rights.verbOnSkills",
  connection: "rights.verbOnConnections",
  app: "rights.verbOnApps",
  workflow: "rights.verbOnWorkflows",
  data_store: "rights.verbOnDataStores",
  knowledge_base: "rights.verbOnKnowledgeBases",
  guardrail: "rights.verbOnGuardrails"
} as const satisfies Record<string, TranslationKey>;

type RightKind = keyof typeof verbOnKindKeys;
type VerbAction = Extract<PlatformAction, `${RightKind}.${RightVerb}`>;

/**
 * The actions that are no verb of the table on a kind, each with words of its own. An action
 * core adds does not compile until it has its words here or is a verb on a kind above.
 */
const ownActionKeys: Record<Exclude<PlatformAction, VerbAction>, TranslationKey> = {
  "workflow.read_run_data": "rights.actionWorkflowReadRunData",
  "data_store.insert": "rights.actionDataStoreInsert",
  "data_store.execute": "rights.actionDataStoreExecute",
  "data_store.records": "rights.actionDataStoreRecords",
  "mail_sender.use": "rights.actionMailSenderUse",
  "operations.approve": "rights.actionOperationsApprove",
  "feedback.review": "rights.actionFeedbackReview",
  "users.manage": "rights.actionUsersManage",
  "usage.view": "rights.actionUsageView",
  "audit.view": "rights.actionAuditView",
  "api_access.manage": "rights.actionApiAccessManage",
  "service_principals.manage": "rights.actionServicePrincipalsManage",
  "agent_models.manage": "rights.actionAgentModelsManage",
  "roles.edit_built_in": "rights.actionRolesEditBuiltIn",
  "assets.release": "rights.actionAssetsRelease",
  builder: "rights.actionBuilder",
  publisher: "rights.actionPublisher"
};

/** A label starts with a capital, wherever its sentence put the verb. */
function sentenceStart(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function isVerb(verb: string): verb is RightVerb {
  return Object.hasOwn(verbKeys, verb);
}

function isRightKind(kind: string): kind is RightKind {
  return Object.hasOwn(verbOnKindKeys, kind);
}

function isOwnWordAction(action: string): action is Exclude<PlatformAction, VerbAction> {
  return Object.hasOwn(ownActionKeys, action);
}

/** The verb of the table an action is made of, where it is one: `use` for `connection.use`. */
export function rightVerb(action: string): RightVerb | undefined {
  const verb = action.slice(action.indexOf(".") + 1);
  return !isOwnWordAction(action) && isVerb(verb) ? verb : undefined;
}

/** The verb alone, as a label: "Bearbeiten". */
export function verbLabel(verb: RightVerb, t: Translate): string {
  return sentenceStart(t(verbKeys[verb]));
}

/**
 * What an action allows, as every rights screen names it: "Agenten bearbeiten". An action this
 * interface does not know, such as one a newer server wrote, is named as such and never by
 * its id.
 */
export function actionLabel(action: string, t: Translate): string {
  if (isOwnWordAction(action)) {
    return t(ownActionKeys[action]);
  }
  const dot = action.indexOf(".");
  const kind = action.slice(0, dot);
  const verb = action.slice(dot + 1);
  const label = isVerb(verb) ? verbOnKind(kind, t(verbKeys[verb]), t) : undefined;
  return dot > 0 && label !== undefined ? sentenceStart(label) : t("rights.actionUnknown");
}

/**
 * Any verbs on a kind, in the reader's word order: "view and edit agents", "Agenten ansehen und
 * bearbeiten". Nothing for a kind no right names.
 */
export function verbOnKind(kind: string, verbs: string, t: Translate): string | undefined {
  return isRightKind(kind) ? t(verbOnKindKeys[kind], { verb: verbs }) : undefined;
}
