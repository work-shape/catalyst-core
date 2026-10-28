import type { AppWorkflowRefusal, DataStoreRefusal } from "@work-shape/catalyst-core";
import { knownActionLabel } from "../../admin/access/right-words";
import type { TranslationContextValue, TranslationKey } from "../i18n";
import type { WorkspaceRoute } from "../routes";

// REFUSE-1 (apps-and-pages.md, Going live without getting lost): the interface says its own
// sentence for a refusal it knows by `details.reason`. The instance keeps its English sentence
// for agents and the CLI; a reason that is not here is shown as the instance said it.

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
  /**
   * A workspace a refusal names, as the reader knows it: their own, or by its name. Nothing for
   * a workspace the reader is not shown, which the sentence then names by no name.
   */
  placeOf?(workspaceId: string): { mine: true } | { name: string } | undefined;
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
  sentence(details: RefusalDetails, t: Translate, place?: RefusalPlace): RowSentence | undefined;
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

/**
 * A sentence that names a store a publish carries, by the title people see where the details
 * give one and else by its name, and each of `names` beside it.
 */
const namingStore =
  (key: TranslationKey, ...names: string[]): RefusalRow["sentence"] =>
  (details, t) => {
    const dataStore = text(details, "title") || text(details, "dataStore");
    return dataStore === ""
      ? undefined
      : naming(key, "dataStore", ...names)({ ...details, dataStore }, t);
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
  },
  // A publish with an App names the store by its title. The instance's own failure text and
  // the levels are never shown.
  data_store_not_reached: {
    sentence: namingStore("refusals.dataStoreNotReached"),
    action: toDataStore
  },
  data_store_draft_below_min_schema: {
    sentence: namingStore("refusals.dataStoreDraftBelowMinSchema"),
    action: toDataStore
  },
  data_store_migration_failed: {
    // A migration without a name of its own is named by its level: then it is not named.
    sentence: (details, t) =>
      /^\d*$/u.test(text(details, "migration"))
        ? namingStore("refusals.dataStoreMigrationFailedUnnamed")(details, t)
        : namingStore("refusals.dataStoreMigrationFailed", "migration")(details, t),
    action: toDataStore
  },
  data_store_job_exhausted: {
    sentence: namingStore("refusals.dataStoreJobExhausted"),
    action: toDataStore
  },
  data_store_migrating: {
    sentence: namingStore("refusals.dataStoreMigrating"),
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

/** An owner a refusal names: the instance, or one workspace by its id. */
function ownerIn(value: unknown): { workspaceId?: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "instance") return {};
  return value.kind === "workspace" && typeof value.workspaceId === "string"
    ? { workspaceId: value.workspaceId }
    : undefined;
}

/**
 * Why an asset may not use what it names, in the words of the place ladder (SCOPE-WORDS): where
 * the asset sits, where what it uses sits, and what the reader can do next. Until something can
 * be shared to a wider place, the way is to make it where it is used or to ask an admin.
 */
function referenceSentence(
  details: RefusalDetails,
  t: Translate,
  { placeOf }: RefusalPlace = {}
): RowSentence {
  const source = ownerIn(details.owner);
  const reference = isRecord(details.reference) ? details.reference : {};
  const used = ownerIn(reference.owner);
  // What sits in a Personal Workspace is "Only me" whoever's it is: a reader can name only theirs.
  const usedPlace =
    reference.reach === "personal"
      ? { mine: true as const }
      : used?.workspaceId === undefined
        ? undefined
        : placeOf?.(used.workspaceId);
  const target =
    usedPlace === undefined
      ? t("refusals.referenceTargetOther")
      : "mine" in usedPlace
        ? t("refusals.referenceTargetMine")
        : t("refusals.referenceTargetWorkspace", { workspace: usedPlace.name });
  if (source !== undefined && source.workspaceId === undefined) {
    return { key: "refusals.referenceForAll", values: { target } };
  }
  const sourcePlace = source?.workspaceId === undefined ? undefined : placeOf?.(source.workspaceId);
  if (sourcePlace === undefined) {
    return reference.reach === "personal"
      ? { key: "refusals.referenceOnlyMine" }
      : { key: "refusals.referenceOutOfScope" };
  }
  return "mine" in sourcePlace
    ? { key: "refusals.referenceForMine", values: { target } }
    : { key: "refusals.referenceForWorkspace", values: { source: sourcePlace.name, target } };
}

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
  data_store_named_twice: {
    sentence: naming("refusals.dataStoreNamedTwice", "dataStore"),
    action: toDataStore
  },
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
    sentence: (details, t, place) =>
      details.reference !== undefined
        ? referenceSentence(details, t, place)
        : namingRight("refusals.workflowRightOnNothing")(details, t, place)
  },
  owner_reach: { sentence: plain("refusals.offerOnlyMine") },
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
  const sentence = details && row?.sentence(details, t, place);
  if (details === undefined || row === undefined || sentence === undefined) return undefined;
  const way = row.action?.(details, place);
  const action = way && place.canOpen?.(way.route) === true ? way : undefined;
  return {
    message: t(sentence.key, sentence.values),
    ...(action ? { action: { label: t(action.key), route: action.route } } : {})
  };
}
