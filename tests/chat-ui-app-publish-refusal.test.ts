import { readFileSync } from "node:fs";
import { ApiError } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ERROR_CODES, type DataStoreRefusal } from "@work-shape/catalyst-core";
import { WORKFLOW_CODE_ERRORS } from "@work-shape/catalyst-workflows";
import { describe, expect, it } from "vitest";
import { appPublishRefusal } from "@work-shape/catalyst-chat-ui/apps";
import { readBuildRefusal } from "@work-shape/catalyst-chat-ui/build-area";
import { createTranslationContext, instanceSentence, tellRefusal } from "./support/chat-ui";

// REFUSE-1 (apps-and-pages.md, check 67): every refusal of the App, Data Store and Workflow
// publish paths reads as a sentence of the interface in the reader's language, and one that
// names a store offers the way to it. The instance keeps its English sentence for agents and
// the CLI; a reason the interface does not know is shown as the instance said it.

const SERVER = "As the instance says it";

const refused = (status: number, code: string, details: Record<string, unknown>) =>
  new ApiError(status, SERVER, { error: { code, message: SERVER, details } });

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;

/** A host that shows the reader every page a refusal may link to. */
const opensAll = { workspaceId: "ws-1", canOpen: () => true };

/**
 * The files that raise the refusals of the publish paths, under `packages/`: each `reason:` and
 * `code:` literal in them is a reason a publish may refuse with, unless it is listed below as
 * one no publish gives.
 */
const PUBLISH_PATH_FILES = [
  "data-stores/src/store-publishing.ts",
  "data-stores/src/migrating.ts",
  "data-stores/src/records/publish.ts",
  "data-stores/src/scoped-tables.ts",
  "server/src/apps/app-closure.ts",
  "server/src/apps/app-publish-together.ts",
  "workflows/src/child-contracts.ts",
  "workflows/src/dataset-contracts.ts",
  "workflows/src/runner-packages.ts",
  "workflows/src/continue-as-new.ts",
  "workflows/src/start-checks.ts",
  "client-assembly/src/workflow-owned-account.ts"
];

/** Literals of those files and codes that are no refusal of a publish, and why. */
const NOT_PUBLISH_REFUSALS: Record<string, string> = {
  scope_value_denied: "an App's call of a scoped table, after the publish",
  scope_value_required: "an App's call of a scoped table, after the publish",
  scoped_sql_refused: "an App's call of a scoped table, after the publish",
  continuation_no_progress: "a run that continues as new without progress",
  dataset_limit: "a run's dataset",
  dataset_expired: "a run's dataset",
  depth_limit: "a run's child below the deepest level",
  rate_limited: "a call that found no room in its limits"
};

/** Every reason the publish-path files and the Workflow checks raise, read from the source. */
function publishPathReasons(): string[] {
  const found = new Set<string>();
  for (const file of PUBLISH_PATH_FILES) {
    const source = readFileSync(new URL(`../packages/${file}`, import.meta.url), "utf8");
    for (const [, reason] of source.matchAll(/\b(?:reason|code): "([a-z][a-z_]*)"/gu)) {
      if (reason !== undefined) found.add(reason);
    }
  }
  for (const code of Object.values(WORKFLOW_ERROR_CODES)) found.add(code);
  // A code step's script is checked at a publish; its other codes are a run's.
  for (const [name, code] of Object.entries(WORKFLOW_CODE_ERRORS)) {
    if (/^files?[A-Z]/u.test(name)) found.add(code);
  }
  return [...found].filter((reason) => !Object.hasOwn(NOT_PUBLISH_REFUSALS, reason)).sort();
}

/** Details that name everything a sentence of the table may name. */
const NAMED = {
  dataStore: "belege",
  workflow: "monatsabschluss",
  action: "data_store.read",
  input: "month",
  fault: "missing",
  table: "receipts",
  field: "number",
  column: "tenant",
  step: "send",
  runAs: "buchhaltung",
  issues: [{ path: ["steps"], message: "No steps" }]
};

/**
 * Every reason the publish of an App, a Data Store or a Workflow refuses with, as the server
 * raises it (inventory of 2026-10-26), with the details it carries. An App's Publish makes
 * its Workflows live with it (DP-3), so the App's dialog meets each Workflow's reasons too.
 */
const DATA_STORE_REFUSALS: Record<DataStoreRefusal, Record<string, unknown>> = {
  data_store_below_min_schema: { dataStore: "belege", minSchema: 3, level: 2 },
  data_store_needs_app: { dataStore: "belege" },
  data_store_unavailable: { dataStore: "belege" },
  data_store_not_listed: { dataStore: "belege", action: "list-receipts" },
  data_store_not_reached: { dataStore: "belege" },
  data_store_draft_below_min_schema: {
    dataStore: "belege",
    title: "Belege",
    minSchema: 3,
    level: 2
  },
  data_store_migration_failed: {
    dataStore: "belege",
    title: "Belege",
    migration: "add_status",
    level: 2,
    failure: "column exists"
  },
  data_store_migrating: { dataStore: "belege", title: "Belege", level: 2, minSchema: 3 }
};

const PUBLISH_REFUSALS: [reason: string, details: Record<string, unknown>][] = [
  ...Object.entries(DATA_STORE_REFUSALS),
  // The App's Publish.
  ["workflow_unavailable", { workflow: "monatsabschluss" }],
  [
    "workflow_input_invalid",
    { workflow: "monatsabschluss", action: "close", input: "month", fault: "missing" }
  ],
  [
    "workflow_input_invalid",
    { workflow: "monatsabschluss", action: "close", input: "origin", fault: "undeclared" }
  ],
  ["workflows_without_app", {}],
  ["workflow_named_twice", { workflow: "monatsabschluss" }],
  ["workflow_not_reached", { workflow: "monatsabschluss" }],
  ["revision_unknown", { revision: 4 }],
  ["revision_changed", { revision: 4 }],
  ["live_moved", {}],
  ["revision_files_removed", { revision: 4 }],
  [
    "invalid_scope",
    {
      reference: { kind: "data_store", name: "belege", owner: { kind: "instance" } },
      owner: { kind: "workspace", workspaceId: "ws-1" }
    }
  ],
  ["publish_subject_unreadable", {}],
  ["input_too_large_to_hold", {}],
  ["app_instance_needs_shared_workspace", {}],
  ["no_grant", { action: "data_store.read" }],
  ["denied", { action: "workflow.use" }],
  // A store's Publish.
  ["scope_dimension_unknown", {}],
  ["scope_mismatch", {}],
  ["data_store_id_held", {}],
  ["applied_migration_changed", {}],
  ["record_key_invalid", { table: "receipts", field: "number" }],
  ["scope_column_invalid", { table: "receipts", column: "tenant" }],
  ["scope_migration_invalid", {}],
  // A Workflow's Publish, on its own page or with an App.
  ["definition_invalid", { issues: [{ path: ["steps"], message: "No steps" }] }],
  ["not_supported_yet", { issues: [{ path: ["steps", 0], message: "Not yet", code: "x" }] }],
  ["operation_not_callable", { issues: [{ path: ["steps", 0], message: "Not callable" }] }],
  ["operation_not_found", { step: "send" }],
  ["process_workflow_write_operation", { issues: [] }],
  ["limit_above_ceiling", { issues: [] }],
  ["block_depth", { issues: [] }],
  ["reference_out_of_scope", { issues: [] }],
  ["duplicate_step_id", { issues: [] }],
  ["child_input_invalid", {}],
  ["child_schema_invalid", {}],
  ["child_output_invalid", {}],
  ["dataset_schema_invalid", {}],
  ["dataset_reference_invalid", {}],
  ["paging_invalid", {}],
  ["batch_requires_dataset", {}],
  ["text_part_invalid", { step: "join", field: "text" }],
  ["workspace_not_allowed", { step: "send" }],
  ["recipient_not_allowed", { step: "send", domain: "example.com" }],
  ["user_only", {}],
  ["action_not_grantable_to_principal", { action: "app.publish" }],
  ["module_off", { module: "knowledge" }],
  ["invalid_scope", { action: "connection.use" }],
  ["not_visible", { action: "connection.read" }],
  ["run_as_missing", {}],
  ["run_as_unknown", { runAs: "buchhaltung" }],
  ["run_as_owned", {}],
  ["run_as_disabled", { runAs: "buchhaltung", principalDisplayLabel: "Buchhaltung" }],
  ["package_not_available", { package: "pandas" }],
  ["no_parent_trigger", { workflow: "belege-lesen" }],
  ["child_use_forbidden", { action: "workflow.use", workflow: "belege-lesen" }],
  ["child_unpublished", {}],
  ["workflow_cycle", {}],
  ["person_context_unmapped", {}],
  // An App's calls of its store.
  ["data_store_not_ready", {}],
  ["data_store_key_reused", {}],
  ["rows_too_large", { cap: "DATA_STORE_INSERT_MAX_BYTES", actual: 2_000_000 }],
  ["rows_too_many", {}],
  ["no_manual_trigger", {}]
];

describe("the refusals of the publish paths, in the reader's language", () => {
  it("tells each in German, never as the instance's English sentence", () => {
    const untold = PUBLISH_REFUSALS.filter(([reason, details]) => {
      const code = /^(?:no_grant|denied|user_only|not_visible|child_use_forbidden)$/u.test(reason)
        ? "FORBIDDEN"
        : "VALIDATION_FAILED";
      const told = appPublishRefusal(refused(422, code, { reason, ...details }), de);
      return told === undefined || told.message === SERVER;
    }).map(([reason]) => reason);
    expect(untold).toEqual([]);
  });

  it("tells each reason the publish-path sources raise in German, read from the source", () => {
    const reasons = publishPathReasons();
    // The scan reads what it should: a known reason of each kind of file is among them.
    expect(reasons).toEqual(
      expect.arrayContaining([
        "scope_mismatch",
        "workflow_not_reached",
        "child_unpublished",
        "continuation_invalid",
        "code_file_missing",
        "operation_unknown",
        "action_not_grantable_to_principal"
      ])
    );
    const untold = reasons.filter((reason) => {
      const told = appPublishRefusal(refused(422, "VALIDATION_FAILED", { reason, ...NAMED }), de);
      return told === undefined || told.message === SERVER;
    });
    expect(untold).toEqual([]);
  });

  it("tells a store below the level the App needs with the way to the store", () => {
    const error = refused(409, "CONFLICT", {
      reason: "data_store_below_min_schema",
      dataStore: "belege",
      minSchema: 3,
      level: 2
    });
    expect(appPublishRefusal(error, de, opensAll)).toEqual({
      message:
        "Die App braucht den Datenspeicher „belege“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App.",
      action: {
        label: "Datenspeicher öffnen",
        route: { kind: "build-asset", assetKind: "data-stores", name: "belege" }
      }
    });
    expect(appPublishRefusal(error, en, opensAll)).toEqual({
      message:
        "The app needs a newer version of the data store “belege”. Publish it together with the app.",
      action: {
        label: "Open data store",
        route: { kind: "build-asset", assetKind: "data-stores", name: "belege" }
      }
    });
    // A reader not shown the store's page in Build is offered no way there.
    expect(appPublishRefusal(error, de, { workspaceId: "ws-1", canOpen: () => false })).toEqual({
      message:
        "Die App braucht den Datenspeicher „belege“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App."
    });
    expect(appPublishRefusal(error, de, { workspaceId: "ws-1" })?.action).toBeUndefined();
    // No level or migration is named to a person.
    expect(appPublishRefusal(error, de)?.message).not.toMatch(/\d|minSchema|Level/u);
  });

  it("words the store refusals of an App as written", () => {
    const say = (details: Record<string, unknown>) => tellRefusal(details, de)?.message;
    expect(say({ reason: "data_store_needs_app", dataStore: "belege" })).toBe(
      "Diese Vorschau erreicht keine Datenspeicher. Zum Testen mit echten Daten öffne die App."
    );
    expect(say({ reason: "data_store_unavailable", dataStore: "belege" })).toBe(
      "Den Datenspeicher „belege“ gibt es hier nicht (mehr)."
    );
    expect(
      say({ reason: "data_store_not_listed", dataStore: "belege", action: "list-receipts" })
    ).toBe(
      "Die Aktion „list-receipts“ nutzt den Datenspeicher „belege“, den die App nicht angibt. Bitte den Agenten, ihn in der App einzutragen."
    );
  });

  it("offers the way to a Workflow or an App only where a workspace is there to open it in", () => {
    const unavailable = { reason: "workflow_unavailable", workflow: "monatsabschluss" };
    expect(tellRefusal(unavailable, de, { canOpen: () => true })?.action).toBeUndefined();
    expect(tellRefusal(unavailable, de, opensAll)?.action).toEqual({
      label: "Workflow öffnen",
      route: { kind: "workflow", collaborationWorkspaceId: "ws-1", workflow: "monatsabschluss" }
    });
    // A refusal from a Page of a conversation names no App; one that does opens its draft.
    const needsApp = { reason: "data_store_needs_app", dataStore: "belege" };
    expect(tellRefusal(needsApp, de, opensAll)?.action).toBeUndefined();
    expect(tellRefusal({ ...needsApp, app: "buchhaltung" }, de, opensAll)).toEqual({
      message:
        "Diese Vorschau erreicht keine Datenspeicher. Zum Testen mit echten Daten öffne die App.",
      action: {
        label: "App öffnen",
        route: { kind: "app-edit", collaborationWorkspaceId: "ws-1", app: "buchhaltung" }
      }
    });
  });

  it("names the Workflow, the action and the input a publish refused for, in German and English", () => {
    const missing = refused(422, "VALIDATION_FAILED", {
      reason: "workflow_input_invalid",
      workflow: "brain-briefing",
      action: "brief",
      input: "topic",
      fault: "missing"
    });
    const undeclared = refused(422, "VALIDATION_FAILED", {
      reason: "workflow_input_invalid",
      workflow: "brain-briefing",
      action: "brief",
      input: "origin",
      fault: "undeclared"
    });
    expect(
      appPublishRefusal(
        refused(404, "NOT_FOUND", { reason: "workflow_unavailable", workflow: "brain-briefing" }),
        de
      )?.message
    ).toBe(
      "Der Workflow „brain-briefing“, den diese App startet, ist nicht veröffentlicht. Veröffentliche zuerst den Workflow, dann die App."
    );
    expect(appPublishRefusal(missing, en)?.message).toBe(
      "The action “brief” does not pass “topic”, which the Workflow “brain-briefing” needs."
    );
    expect(appPublishRefusal(undeclared, de)?.message).toBe(
      "Die Aktion „brief“ übergibt „origin“, das der Workflow „brain-briefing“ nicht annimmt."
    );
  });

  it("words a refused right by what happened, and a store's row limits by what was too much", () => {
    const say = (details: Record<string, unknown>) => tellRefusal(details, de)?.message;
    expect(say({ reason: "no_grant", action: "data_store.read" })).toBe(
      "Dafür brauchst du das Recht „Datenspeicher ansehen“."
    );
    // `denied` is also given to who holds the right, where a deny blocks lending it.
    expect(say({ reason: "denied", action: "data_store.read" })).toBe(
      "Das Recht „Datenspeicher ansehen“ ist dir hier verwehrt."
    );
    // A right this interface does not know keeps the instance's sentence, which names it.
    expect(say({ reason: "no_grant", action: "connection_exposure.outside" })).toBeUndefined();
    expect(say({ reason: "rows_too_large", cap: "DATA_STORE_INSERT_MAX_BYTES" })).toBe(
      "Diese Änderung ist für einen Aufruf zu groß. Teile sie auf mehrere Aufrufe auf."
    );
    expect(say({ reason: "rows_too_many" })).toBe(
      "Diese Änderung enthält zu viele Einträge für einen Aufruf. Teile sie auf mehrere Aufrufe auf."
    );
  });

  it("keeps the instance's sentence for a reason it does not know, or details that lack a name", () => {
    expect(appPublishRefusal(refused(422, "VALIDATION_FAILED", { reason: "other" }), de)).toBe(
      undefined
    );
    // The review names no input: the sentence that names one is not told without it.
    expect(
      tellRefusal({ reason: "workflow_input_invalid", workflow: "brain-briefing" }, de)
    ).toBeUndefined();
    // The same reason a frame gives for an App's input is no Workflow's definition.
    expect(tellRefusal({ reason: "not_supported_yet" }, de)).toBeUndefined();
    expect(appPublishRefusal(new Error("offline"), de)).toBeUndefined();
  });

  it("is read by every place that showed the instance's sentence, in the reader's language", () => {
    const below = refused(409, "CONFLICT", {
      reason: "data_store_below_min_schema",
      dataStore: "belege"
    });
    expect(instanceSentence(below, de)).toBe(
      "Die App braucht den Datenspeicher „belege“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App."
    );
    expect(instanceSentence(refused(422, "VALIDATION_FAILED", { reason: "other" }), de)).toBe(
      SERVER
    );
    // A store's own Publish on its Build page.
    expect(
      readBuildRefusal(
        refused(422, "VALIDATION_FAILED", { reason: "scope_migration_invalid" }),
        de,
        "de"
      )
    ).toEqual({
      ok: false,
      conflict: false,
      refusals: [
        {
          message:
            "Diese Änderung am Datenspeicher lässt sich nicht veröffentlichen, weil seine nach Bereichen getrennten Tabellen nicht geprüft werden konnten. Bitte den Agenten, die Änderung am aktuellen Stand des Speichers zu prüfen."
        }
      ]
    });
  });
});

// GOLIVE-1: the store published with the App failed its migration or is still migrating; the
// dialog names the store by its title and the migration, in its own words.
describe("the sentence of a publish refused for a Data Store published with the App", () => {
  const store = { dataStore: "pruefergebnisse", title: "Prüfergebnisse" };
  const toStore = {
    route: { kind: "build-asset", assetKind: "data-stores", name: "pruefergebnisse" }
  };

  it("names the store by its title and the migration that failed, never the instance's failure", () => {
    const failed = refused(409, "CONFLICT", {
      reason: "data_store_migration_failed",
      ...store,
      migration: "add_status",
      level: 2,
      failure: 'relation "status" already exists'
    });
    expect(appPublishRefusal(failed, de, opensAll)).toEqual({
      message:
        "Die Änderung „add_status“ am Datenspeicher „Prüfergebnisse“ ließ sich nicht anwenden. Die App ist nicht veröffentlicht.",
      action: { label: "Datenspeicher öffnen", ...toStore }
    });
    expect(appPublishRefusal(failed, en)).toEqual({
      message:
        "The change “add_status” to the data store “Prüfergebnisse” could not be applied. The app is not published."
    });
    // A migration the instance names only by its level is not named.
    expect(
      appPublishRefusal(
        refused(409, "CONFLICT", {
          reason: "data_store_migration_failed",
          ...store,
          migration: "3"
        }),
        de
      )?.message
    ).toBe(
      "Eine Änderung am Datenspeicher „Prüfergebnisse“ ließ sich nicht anwenden. Die App ist nicht veröffentlicht."
    );
  });

  it("asks to try again while the store migrates, with the way to the store", () => {
    const migrating = refused(409, "CONFLICT", {
      reason: "data_store_migrating",
      ...store,
      level: 2,
      minSchema: 3,
      retryable: true
    });
    expect(appPublishRefusal(migrating, de, opensAll)).toEqual({
      message:
        "Der Datenspeicher „Prüfergebnisse“ wird noch umgestellt. Versuche es in einer Minute noch einmal.",
      action: { label: "Datenspeicher öffnen", ...toStore }
    });
    expect(appPublishRefusal(migrating, en)?.message).toBe(
      "The data store “Prüfergebnisse” is still being updated. Try again in a minute."
    );
  });

  it("asks for the store's draft to reach the level, with the way to the store", () => {
    const below = refused(409, "CONFLICT", {
      reason: "data_store_draft_below_min_schema",
      ...store,
      minSchema: 3,
      level: 2
    });
    expect(appPublishRefusal(below, de, opensAll)).toEqual({
      message:
        "Die App braucht eine neuere Fassung des Datenspeichers „Prüfergebnisse“, als sein Entwurf hat. Bitte den Agenten, den Datenspeicher zu ergänzen.",
      action: { label: "Datenspeicher öffnen", ...toStore }
    });
    expect(appPublishRefusal(below, en, opensAll)?.action).toEqual({
      label: "Open data store",
      ...toStore
    });
    expect(appPublishRefusal(below, de, { canOpen: () => false })?.action).toBeUndefined();
  });

  it("names a store the publish does not carry by its name where no title is given", () => {
    expect(
      appPublishRefusal(
        refused(422, "VALIDATION_FAILED", {
          reason: "data_store_not_reached",
          dataStore: "pruefergebnisse"
        }),
        de,
        opensAll
      )
    ).toEqual({
      message:
        "Die App nutzt den Datenspeicher „pruefergebnisse“ nicht, darum wird er nicht mit ihr veröffentlicht. Öffne den Dialog noch einmal, um zu sehen, was live geht.",
      action: { label: "Datenspeicher öffnen", ...toStore }
    });
  });

  it.each(["data_store_not_reached", "data_store_migrating", "data_store_named_twice"])(
    "offers the named store for %s only when its page is available",
    (reason) => {
      const error = refused(409, "CONFLICT", { reason, ...store });
      expect(appPublishRefusal(error, de, opensAll)?.action).toEqual({
        label: "Datenspeicher öffnen",
        ...toStore
      });
      expect(appPublishRefusal(error, en, opensAll)?.action).toEqual({
        label: "Open data store",
        ...toStore
      });
      expect(appPublishRefusal(error, de, { canOpen: () => false })?.action).toBeUndefined();
    }
  );
});
