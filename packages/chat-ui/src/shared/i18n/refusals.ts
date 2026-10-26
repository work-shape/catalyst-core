import type { AppWorkflowRefusal, DataStoreRefusal } from "@work-shape/catalyst-core";
import { knownActionLabel } from "../../admin/access/right-words";
import type { TranslationContextValue, TranslationKey } from "../i18n";
import type { WorkspaceRoute } from "../routes";
import { defineTranslations } from "./translation-area";

// REFUSE-1 (apps-and-pages.md, Going live without getting lost): the interface says its own
// sentence for a refusal it knows by `details.reason`. The instance keeps its English sentence
// for agents and the CLI; a reason that is not here is shown as the instance said it.

export const refusals = defineTranslations({
  en: {
    "refusals.dataStoreBelowMinSchema":
      "The app needs a newer version of the data store “{dataStore}”. Publish it together with the app.",
    "refusals.dataStoreNeedsApp":
      "This preview reaches no data stores. To test with real data, open the app.",
    "refusals.dataStoreUnavailable": "There is no data store “{dataStore}” here (any more).",
    "refusals.dataStoreNotListed":
      "The action “{action}” uses the data store “{dataStore}”, which the app does not list. Ask the agent to add it to the app.",
    "refusals.dataStoreNotReady": "The data store is not ready yet. Try again in a moment.",
    "refusals.dataStoreKeyReused":
      "The app sent this change twice with different content. Reload the app and try again.",
    "refusals.rowsTooLarge":
      "This change is too large for one call. Split it across several calls.",
    "refusals.rowsTooMany":
      "This change holds too many entries for one call. Split it across several calls.",
    "refusals.dataStoreIdHeld":
      "A deleted data store still uses this name, and its database still exists. The name is free once an instance admin removes that database.",
    "refusals.dataStoreScopeUnknown":
      "The data store names a data area this instance does not know. Ask the agent to change it.",
    "refusals.dataStoreScopeMismatch":
      "The data store is written for a different place than where it is. Ask the agent to change it.",
    "refusals.dataStoreChangeApplied":
      "The data store already applied a change to its structure that this version leaves out or alters. An applied change stays as it is: ask the agent to add a new one instead.",
    "refusals.dataStoreRecordKey":
      "The table “{table}” needs the column “{field}” with a unique key. Ask the agent to add it.",
    "refusals.dataStoreScopeColumn":
      "The table “{table}” is not built the way a data store separated by area needs it. Ask the agent to change it.",
    "refusals.dataStoreScopeUnchecked":
      "This change to the data store cannot be published, because its tables separated by area could not be checked. Ask the agent to check the change against the store as it is now.",
    "refusals.workflowUnavailable":
      "The Workflow “{workflow}” that this app starts is not published. Publish the Workflow first, then the app.",
    "refusals.workflowInputMissing":
      "The action “{action}” does not pass “{input}”, which the Workflow “{workflow}” needs.",
    "refusals.workflowInputUndeclared":
      "The action “{action}” passes “{input}”, which the Workflow “{workflow}” does not take.",
    "refusals.workflowNotReached":
      "The app no longer starts the Workflow “{workflow}”, so it is not published with it. Open the dialog again to see what goes live.",
    "refusals.workflowNamedTwice":
      "The Workflow “{workflow}” is named twice. Open the dialog again.",
    "refusals.workflowsWithoutApp": "Only publishing an app makes Workflows live with it.",
    "refusals.workflowDefinition":
      "The Workflow cannot run in this version. Ask the agent to check its steps.",
    "refusals.workflowNoManualStart": "This Workflow cannot be started by hand.",
    "refusals.workflowRightNotHeld":
      "The Workflow's account cannot hold the right “{right}”. Ask the agent to take it out.",
    "refusals.workflowRightOnNothing":
      "The Workflow needs the right “{right}” on something that does not exist. Ask the agent to check it.",
    "refusals.workflowNotVisible":
      "The Workflow needs something you may not see, so you cannot give it a right on it.",
    "refusals.workflowPackage":
      "The Workflow uses a software package that is not available here. Ask the agent to do without it.",
    "refusals.personContextUnmapped":
      "Your account is not linked to a connection this Workflow uses.",
    "refusals.revisionFilesRemoved":
      "The files of this version are not stored any more, so it cannot be published or shown.",
    "refusals.revisionUnknown":
      "This version is not there any more. Reload the page and try again.",
    "refusals.revisionChanged":
      "This changed after you opened it. Reload the page and check it again.",
    "refusals.liveMoved":
      "Who the app is live for changed in the meantime. Check it again, then publish.",
    "refusals.referenceOutOfScope":
      "This uses something from another workspace. It may only use what belongs to its own workspace or to the whole instance.",
    "refusals.publishSubjectUnreadable":
      "This request does not say what it publishes, so nobody can decide it.",
    "refusals.inputTooLargeToHold":
      "This change needs an approval, and it is too large to be held for one.",
    "refusals.appInstanceNeedsSharedWorkspace":
      "Only an app in a shared workspace can be for the whole instance. Move it to a shared workspace first.",
    "refusals.moduleOff": "A part of the platform this needs is switched off on this instance.",
    "refusals.rightMissing": "You need the right “{right}” for this.",
    "refusals.rightDenied": "The right “{right}” is denied to you here.",
    "refusals.openDataStore": "Open data store",
    "refusals.openWorkflow": "Open Workflow",
    "refusals.openApp": "Open app"
  },
  de: {
    "refusals.dataStoreBelowMinSchema":
      "Die App braucht den Datenspeicher „{dataStore}“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App.",
    "refusals.dataStoreNeedsApp":
      "Diese Vorschau erreicht keine Datenspeicher. Zum Testen mit echten Daten öffne die App.",
    "refusals.dataStoreUnavailable": "Den Datenspeicher „{dataStore}“ gibt es hier nicht (mehr).",
    "refusals.dataStoreNotListed":
      "Die Aktion „{action}“ nutzt den Datenspeicher „{dataStore}“, den die App nicht angibt. Bitte den Agenten, ihn in der App einzutragen.",
    "refusals.dataStoreNotReady":
      "Der Datenspeicher ist noch nicht bereit. Versuche es gleich noch einmal.",
    "refusals.dataStoreKeyReused":
      "Die App hat diese Änderung zweimal mit verschiedenem Inhalt geschickt. Lade die App neu und versuche es noch einmal.",
    "refusals.rowsTooLarge":
      "Diese Änderung ist für einen Aufruf zu groß. Teile sie auf mehrere Aufrufe auf.",
    "refusals.rowsTooMany":
      "Diese Änderung enthält zu viele Einträge für einen Aufruf. Teile sie auf mehrere Aufrufe auf.",
    "refusals.dataStoreIdHeld":
      "Ein gelöschter Datenspeicher belegt diesen Namen noch, und seine Datenbank gibt es noch. Der Name wird frei, sobald jemand, der die Instanz verwaltet, diese Datenbank entfernt.",
    "refusals.dataStoreScopeUnknown":
      "Der Datenspeicher nennt einen Datenbereich, den diese Instanz nicht kennt. Bitte den Agenten, ihn anzupassen.",
    "refusals.dataStoreScopeMismatch":
      "Der Datenspeicher ist für einen anderen Ort geschrieben, als er liegt. Bitte den Agenten, ihn anzupassen.",
    "refusals.dataStoreChangeApplied":
      "Der Datenspeicher hat eine Änderung seines Aufbaus schon angewendet, die diese Fassung weglässt oder ändert. Eine angewendete Änderung bleibt, wie sie ist: Bitte den Agenten, stattdessen eine neue hinzuzufügen.",
    "refusals.dataStoreRecordKey":
      "Die Tabelle „{table}“ braucht die Spalte „{field}“ mit einem eindeutigen Schlüssel. Bitte den Agenten, ihn anzulegen.",
    "refusals.dataStoreScopeColumn":
      "Die Tabelle „{table}“ ist nicht so aufgebaut, wie ein nach Bereichen getrennter Datenspeicher es braucht. Bitte den Agenten, sie anzupassen.",
    "refusals.dataStoreScopeUnchecked":
      "Diese Änderung am Datenspeicher lässt sich nicht veröffentlichen, weil seine nach Bereichen getrennten Tabellen nicht geprüft werden konnten. Bitte den Agenten, die Änderung am aktuellen Stand des Speichers zu prüfen.",
    "refusals.workflowUnavailable":
      "Der Workflow „{workflow}“, den diese App startet, ist nicht veröffentlicht. Veröffentliche zuerst den Workflow, dann die App.",
    "refusals.workflowInputMissing":
      "Die Aktion „{action}“ übergibt „{input}“ nicht, das der Workflow „{workflow}“ braucht.",
    "refusals.workflowInputUndeclared":
      "Die Aktion „{action}“ übergibt „{input}“, das der Workflow „{workflow}“ nicht annimmt.",
    "refusals.workflowNotReached":
      "Die App startet den Workflow „{workflow}“ nicht mehr, darum wird er nicht mit ihr veröffentlicht. Öffne den Dialog noch einmal, um zu sehen, was live geht.",
    "refusals.workflowNamedTwice":
      "Der Workflow „{workflow}“ ist doppelt genannt. Öffne den Dialog noch einmal.",
    "refusals.workflowsWithoutApp":
      "Nur das Veröffentlichen einer App macht Workflows mit ihr live.",
    "refusals.workflowDefinition":
      "Der Workflow kann in dieser Fassung nicht laufen. Bitte den Agenten, seine Schritte zu prüfen.",
    "refusals.workflowNoManualStart": "Dieser Workflow lässt sich nicht von Hand starten.",
    "refusals.workflowRightNotHeld":
      "Das Konto des Workflows kann das Recht „{right}“ nicht halten. Bitte den Agenten, es herauszunehmen.",
    "refusals.workflowRightOnNothing":
      "Der Workflow braucht das Recht „{right}“ auf etwas, das es nicht gibt. Bitte den Agenten, das zu prüfen.",
    "refusals.workflowNotVisible":
      "Der Workflow braucht etwas, das du nicht sehen darfst. Darum kannst du ihm darauf kein Recht geben.",
    "refusals.workflowPackage":
      "Der Workflow nutzt ein Softwarepaket, das es hier nicht gibt. Bitte den Agenten, ohne es auszukommen.",
    "refusals.personContextUnmapped":
      "Dein Konto ist mit einer Verbindung, die dieser Workflow nutzt, nicht verknüpft.",
    "refusals.revisionFilesRemoved":
      "Die Dateien dieser Version sind nicht mehr gespeichert. Sie lässt sich weder veröffentlichen noch anzeigen.",
    "refusals.revisionUnknown":
      "Diese Version gibt es nicht mehr. Lade die Seite neu und versuche es noch einmal.",
    "refusals.revisionChanged":
      "Das hat sich geändert, seit du es geöffnet hast. Lade die Seite neu und prüfe es noch einmal.",
    "refusals.liveMoved":
      "Für wen die App live ist, hat sich inzwischen geändert. Prüfe es noch einmal und veröffentliche dann.",
    "refusals.referenceOutOfScope":
      "Das nutzt etwas aus einem anderen Arbeitsbereich. Es darf nur nutzen, was zum eigenen Arbeitsbereich oder zur ganzen Instanz gehört.",
    "refusals.publishSubjectUnreadable":
      "Diese Anfrage sagt nicht, was sie veröffentlicht. Darum kann niemand sie entscheiden.",
    "refusals.inputTooLargeToHold":
      "Diese Änderung braucht eine Freigabe und ist zu groß, um dafür zurückgehalten zu werden.",
    "refusals.appInstanceNeedsSharedWorkspace":
      "Nur eine App in einem geteilten Arbeitsbereich kann für die ganze Instanz sein. Verschiebe sie zuerst in einen geteilten Arbeitsbereich.",
    "refusals.moduleOff":
      "Ein Teil der Plattform, den das braucht, ist auf dieser Instanz ausgeschaltet.",
    "refusals.rightMissing": "Dafür brauchst du das Recht „{right}“.",
    "refusals.rightDenied": "Das Recht „{right}“ ist dir hier verwehrt.",
    "refusals.openDataStore": "Datenspeicher öffnen",
    "refusals.openWorkflow": "Workflow öffnen",
    "refusals.openApp": "App öffnen"
  }
});

type Translate = TranslationContextValue["t"];

/** The details of a refusal, read from an answer nobody vouches for. */
export type RefusalDetails = Readonly<Record<string, unknown>>;

/** The way to what a refusal names, where the reader can act on it there. */
export interface RefusalAction {
  label: string;
  route: WorkspaceRoute;
}

/** A refusal as the interface tells it: its sentence, and the way to what it names. */
export interface ToldRefusal {
  message: string;
  action?: RefusalAction;
}

/**
 * Where a refusal is shown. An App and a Workflow open inside a workspace: without one, a
 * refusal that names them offers no way there. A way is offered only where the host says the
 * reader can open it: nothing links to a page its reader is not shown.
 */
export interface RefusalPlace {
  workspaceId?: string;
  canOpen?(route: WorkspaceRoute): boolean;
}

/** A sentence before it is told: its key and what it names. */
interface RowSentence {
  key: TranslationKey;
  values?: Record<string, string>;
}

/** An action's label and where it leads, before it is told. */
interface RowAction {
  key: TranslationKey;
  route: WorkspaceRoute;
}

interface RefusalRow {
  /**
   * The sentence, or nothing where the details lack what it names: the instance's sentence,
   * which names it, then stays.
   */
  sentence(details: RefusalDetails, t: Translate): RowSentence | undefined;
  action?(details: RefusalDetails, place: RefusalPlace): RowAction | undefined;
}

function text(details: RefusalDetails, name: string): string {
  const value = details[name];
  return typeof value === "string" ? value : "";
}

/** A sentence that names nothing. */
const plain =
  (key: TranslationKey): RefusalRow["sentence"] =>
  () => ({ key });

/** A sentence that names each of `names` from the details, told only where all are there. */
const naming =
  (key: TranslationKey, ...names: string[]): RefusalRow["sentence"] =>
  (details) => {
    const values = Object.fromEntries(names.map((name) => [name, text(details, name)]));
    return Object.values(values).every((value) => value !== "") ? { key, values } : undefined;
  };

/**
 * A sentence that names a right, by the words every rights screen uses for it. Nothing for a
 * right this interface does not know: the instance's sentence, which names it, then stays.
 */
const namingRight =
  (key: TranslationKey): RefusalRow["sentence"] =>
  (details, t) => {
    const label = knownActionLabel(text(details, "action") || text(details, "right"), t);
    return label === undefined ? undefined : { key, values: { right: label } };
  };

/** The store a refusal names, at its page in Build. */
function toDataStore(details: RefusalDetails): RowAction | undefined {
  const name = text(details, "dataStore");
  return name === ""
    ? undefined
    : {
        key: "refusals.openDataStore",
        route: { kind: "build-asset", assetKind: "data-stores", name }
      };
}

/** The Workflow a refusal names, at its page in the workspace it is shown in. */
function toWorkflow(details: RefusalDetails, { workspaceId }: RefusalPlace): RowAction | undefined {
  const workflow = text(details, "workflow");
  return workflow === "" || workspaceId === undefined
    ? undefined
    : {
        key: "refusals.openWorkflow",
        route: { kind: "workflow", collaborationWorkspaceId: workspaceId, workflow }
      };
}

/** The App a refusal names, at its draft page in the workspace it is shown in. */
function toApp(details: RefusalDetails, { workspaceId }: RefusalPlace): RowAction | undefined {
  const app = text(details, "app");
  return app === "" || workspaceId === undefined
    ? undefined
    : {
        key: "refusals.openApp",
        route: { kind: "app-edit", collaborationWorkspaceId: workspaceId, app }
      };
}

/**
 * Every refusal of a Data Store an App reaches, by the reason `core` names it with: a reason
 * added there does not compile until it has its sentence here.
 */
const DATA_STORE_ROWS = {
  data_store_below_min_schema: {
    sentence: naming("refusals.dataStoreBelowMinSchema", "dataStore"),
    action: toDataStore
  },
  // A Page of a conversation is no App. A refusal that names the App of a checkout opens it.
  data_store_needs_app: { sentence: plain("refusals.dataStoreNeedsApp"), action: toApp },
  data_store_unavailable: {
    sentence: naming("refusals.dataStoreUnavailable", "dataStore"),
    action: toDataStore
  },
  data_store_not_listed: {
    sentence: naming("refusals.dataStoreNotListed", "action", "dataStore"),
    action: toDataStore
  }
} satisfies Record<DataStoreRefusal, RefusalRow>;

/** A Workflow's definition that cannot run, by the code of the check that found it. */
const WORKFLOW_DEFINITION_REASONS = [
  "definition_invalid",
  "process_workflow_write_operation",
  "limit_above_ceiling",
  "block_depth",
  "reference_out_of_scope",
  "duplicate_step_id",
  "child_input_invalid",
  "child_schema_invalid",
  "child_output_invalid",
  "dataset_schema_invalid",
  "dataset_reference_invalid",
  "paging_invalid",
  "batch_requires_dataset",
  "text_part_invalid",
  "workspace_not_allowed",
  "recipient_not_allowed",
  "continuation_invalid",
  "code_file_missing",
  "code_file_too_large",
  "code_file_invalid",
  "code_file_unused",
  "code_files_too_large",
  "inputs_unreadable",
  "operation_secret"
] as const;

/**
 * Reasons other places give too: told as a Workflow's definition only where the refusal is one,
 * which lists its issues, or names the step of a Workflow it is about.
 */
const WORKFLOW_DEFINITION_SHARED_REASONS = [
  "not_supported_yet",
  "operation_not_callable",
  "operation_not_found",
  "operation_unknown"
] as const;

const workflowSentence = (key: TranslationKey) => naming(key, "workflow", "action", "input");

/**
 * Every refusal of a Workflow an App's action starts, by the reason `core` names it with: a
 * reason added there does not compile until it has its sentence here.
 */
const APP_WORKFLOW_ROWS = {
  workflow_unavailable: {
    sentence: naming("refusals.workflowUnavailable", "workflow"),
    action: toWorkflow
  },
  workflow_input_invalid: {
    sentence: (details, t) =>
      workflowSentence(
        text(details, "fault") === "missing"
          ? "refusals.workflowInputMissing"
          : "refusals.workflowInputUndeclared"
      )(details, t),
    action: toWorkflow
  }
} satisfies Record<AppWorkflowRefusal, RefusalRow>;

/**
 * The one table: each reason of the App, Data Store and Workflow publish paths, and of an App's
 * calls, with its sentence and, where it names one, the way to it.
 */
const REFUSALS: Readonly<Record<string, RefusalRow>> = {
  ...DATA_STORE_ROWS,
  data_store_not_ready: { sentence: plain("refusals.dataStoreNotReady") },
  data_store_key_reused: { sentence: plain("refusals.dataStoreKeyReused") },
  rows_too_large: { sentence: plain("refusals.rowsTooLarge") },
  rows_too_many: { sentence: plain("refusals.rowsTooMany") },
  data_store_id_held: { sentence: plain("refusals.dataStoreIdHeld") },
  scope_dimension_unknown: { sentence: plain("refusals.dataStoreScopeUnknown") },
  scope_mismatch: { sentence: plain("refusals.dataStoreScopeMismatch") },
  applied_migration_changed: { sentence: plain("refusals.dataStoreChangeApplied") },
  record_key_invalid: { sentence: naming("refusals.dataStoreRecordKey", "table", "field") },
  scope_column_invalid: { sentence: naming("refusals.dataStoreScopeColumn", "table") },
  scope_migration_invalid: { sentence: plain("refusals.dataStoreScopeUnchecked") },
  ...APP_WORKFLOW_ROWS,
  workflow_not_reached: { sentence: naming("refusals.workflowNotReached", "workflow") },
  workflow_named_twice: { sentence: naming("refusals.workflowNamedTwice", "workflow") },
  workflows_without_app: { sentence: plain("refusals.workflowsWithoutApp") },
  ...Object.fromEntries(
    WORKFLOW_DEFINITION_REASONS.map((reason) => [
      reason,
      { sentence: plain("refusals.workflowDefinition") }
    ])
  ),
  ...Object.fromEntries(
    WORKFLOW_DEFINITION_SHARED_REASONS.map((reason) => [
      reason,
      {
        sentence: (details: RefusalDetails) =>
          Array.isArray(details.issues) || text(details, "step") !== ""
            ? { key: "refusals.workflowDefinition" }
            : undefined
      }
    ])
  ),
  no_manual_trigger: { sentence: plain("refusals.workflowNoManualStart") },
  action_not_grantable_to_principal: { sentence: namingRight("refusals.workflowRightNotHeld") },
  not_visible: { sentence: plain("refusals.workflowNotVisible") },
  package_not_available: { sentence: plain("refusals.workflowPackage") },
  person_context_unmapped: { sentence: plain("refusals.personContextUnmapped") },
  // The reason is given for more than one fault: only the two whose details say which are told.
  invalid_scope: {
    sentence: (details, t) =>
      details.reference !== undefined
        ? { key: "refusals.referenceOutOfScope" }
        : namingRight("refusals.workflowRightOnNothing")(details, t)
  },
  revision_files_removed: { sentence: plain("refusals.revisionFilesRemoved") },
  revision_unknown: { sentence: plain("refusals.revisionUnknown") },
  revision_changed: { sentence: plain("refusals.revisionChanged") },
  live_moved: { sentence: plain("refusals.liveMoved") },
  publish_subject_unreadable: { sentence: plain("refusals.publishSubjectUnreadable") },
  input_too_large_to_hold: { sentence: plain("refusals.inputTooLargeToHold") },
  app_instance_needs_shared_workspace: {
    sentence: plain("refusals.appInstanceNeedsSharedWorkspace")
  },
  module_off: { sentence: plain("refusals.moduleOff") },
  no_grant: { sentence: namingRight("refusals.rightMissing") },
  // Also where the reader holds the right and a deny inside its reach blocks lending it.
  denied: { sentence: namingRight("refusals.rightDenied") }
};

/** The details of a refusal of the instance, or nothing where the error carries none. */
export function refusalDetailsOf(error: unknown): RefusalDetails | undefined {
  let value: unknown = error;
  for (const member of ["payload", "error", "details"]) {
    value = isRecord(value) ? Object.getOwnPropertyDescriptor(value, member)?.value : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A refusal in the reader's language, with the way to what it names where `place` lets the
 * reader go there. Nothing for a reason the table does not know, or whose details lack what
 * its sentence names: the instance's sentence then stays.
 */
export function tellRefusal(
  details: RefusalDetails | undefined,
  t: Translate,
  place: RefusalPlace = {}
): ToldRefusal | undefined {
  const reason = details?.reason;
  const row =
    typeof reason === "string" && Object.hasOwn(REFUSALS, reason) ? REFUSALS[reason] : undefined;
  const sentence = details && row?.sentence(details, t);
  if (details === undefined || row === undefined || sentence === undefined) return undefined;
  const way = row.action?.(details, place);
  const action = way && place.canOpen?.(way.route) === true ? way : undefined;
  return {
    message: t(sentence.key, sentence.values),
    ...(action ? { action: { label: t(action.key), route: action.route } } : {})
  };
}
