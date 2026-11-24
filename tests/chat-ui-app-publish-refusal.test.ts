import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ApiError } from "@work-shape/catalyst-api-client";
import { WORKFLOW_ERROR_CODES } from "@work-shape/catalyst-core";
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
  "core/src/data-handover.ts",
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
  rate_limited: "a call that found no room in its limits",
  handover_subject_unreadable: "an Inbox decision on a held call, after the publish waited"
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
  readers: 3,
  issues: [{ path: ["steps"], message: "No steps" }]
};

describe("the refusals of the publish paths, in the reader's language", () => {
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

  it("offers the way to the store a refusal names only where the reader may open its page", () => {
    const store = { dataStore: "pruefergebnisse", title: "Prüfergebnisse" };
    const toStore = {
      route: { kind: "build-asset", assetKind: "data-stores", name: "pruefergebnisse" }
    };
    for (const reason of [
      "data_store_below_min_schema",
      "data_store_draft_below_min_schema",
      "data_store_migration_failed",
      "data_store_job_exhausted",
      "data_store_migrating",
      "data_store_not_reached",
      "data_store_named_twice"
    ]) {
      const error = refused(409, "CONFLICT", { reason, ...store, migration: "add_status" });
      expect(appPublishRefusal(error, de, opensAll)?.action, reason).toEqual({
        label: "Datenspeicher öffnen",
        ...toStore
      });
      expect(appPublishRefusal(error, en, opensAll)?.action?.label, reason).toBe("Open data store");
      expect(
        appPublishRefusal(error, de, { workspaceId: "ws-1", canOpen: () => false })?.action
      ).toBe(undefined);
      expect(appPublishRefusal(error, de, { workspaceId: "ws-1" })?.action).toBeUndefined();
    }
  });

  it("never shows the instance's failure of a store's migration", () => {
    const failure = 'relation "status" already exists';
    const failed = refused(409, "CONFLICT", {
      reason: "data_store_migration_failed",
      dataStore: "pruefergebnisse",
      title: "Prüfergebnisse",
      migration: "add_status",
      level: 2,
      failure
    });
    for (const t of [de, en]) {
      const message = appPublishRefusal(failed, t)?.message;
      expect(message).toContain("Prüfergebnisse");
      expect(message).not.toContain(failure);
    }
  });

  it("names a hand-over's source only where the reader may see it, and links no Knowledge Base as a store", () => {
    const facts = {
      reason: "data_handover_needs_owner",
      dataStore: "belege",
      title: "Belege",
      readers: 3
    };
    const named = tellRefusal(
      { ...facts, connection: "exampledata", connectionTitle: "Exampledata" },
      de
    )?.message;
    expect(named).toContain("Exampledata");
    // A source the reader may not see is not named.
    const hidden = tellRefusal(facts, de)?.message;
    expect(hidden).toBeDefined();
    expect(hidden).not.toContain("exampledata");
    expect(tellRefusal(facts, de, opensAll)?.action?.route).toEqual({
      kind: "build-asset",
      assetKind: "data-stores",
      name: "belege"
    });
    const base = {
      reason: "data_handover_needs_owner",
      knowledgeBase: "handbuch",
      title: "Handbuch",
      readers: 2
    };
    expect(tellRefusal(base, de)?.message).toContain("Handbuch");
    expect(tellRefusal(base, de, opensAll)?.action).toBeUndefined();
  });

  it("offers the way to a Workflow or an App only where a workspace is there to open it in", () => {
    const unavailable = { reason: "workflow_unavailable", workflow: "monatsabschluss" };
    expect(tellRefusal(unavailable, de, { canOpen: () => true })?.action).toBeUndefined();
    expect(tellRefusal(unavailable, de, opensAll)?.action?.route).toEqual({
      kind: "workflow",
      collaborationWorkspaceId: "ws-1",
      workflow: "monatsabschluss"
    });
    // A refusal from a Page of a conversation names no App; one that does opens its draft.
    const needsApp = { reason: "data_store_needs_app", dataStore: "belege" };
    expect(tellRefusal(needsApp, de, opensAll)?.action).toBeUndefined();
    expect(tellRefusal({ ...needsApp, app: "buchhaltung" }, de, opensAll)?.action?.route).toEqual({
      kind: "app-edit",
      collaborationWorkspaceId: "ws-1",
      app: "buchhaltung"
    });
  });

  it("keeps the instance's sentence for a reason or right it does not know, or details that lack a name", () => {
    expect(appPublishRefusal(refused(422, "VALIDATION_FAILED", { reason: "other" }), de)).toBe(
      undefined
    );
    expect(tellRefusal({ reason: "no_grant", action: "data_store.read" }, de)).toBeDefined();
    expect(
      tellRefusal({ reason: "no_grant", action: "connection_exposure.outside" }, de)
    ).toBeUndefined();
    // The review names no input: the sentence that names one is not told without it.
    expect(
      tellRefusal({ reason: "workflow_input_invalid", workflow: "brain-briefing" }, de)
    ).toBeUndefined();
    // The same reason a frame gives for an App's input is no Workflow's definition.
    expect(tellRefusal({ reason: "not_supported_yet" }, de)).toBeUndefined();
    expect(appPublishRefusal(new Error("offline"), de)).toBeUndefined();
  });

  it("is read by every place that showed the instance's sentence", () => {
    const below = refused(409, "CONFLICT", {
      reason: "data_store_below_min_schema",
      dataStore: "belege"
    });
    expect(instanceSentence(below, de)).not.toBe(SERVER);
    expect(instanceSentence(refused(422, "VALIDATION_FAILED", { reason: "other" }), de)).toBe(
      SERVER
    );
    // A store's own Publish on its Build page.
    const build = readBuildRefusal(
      refused(422, "VALIDATION_FAILED", { reason: "scope_migration_invalid" }),
      de,
      "de"
    );
    expect(build).toMatchObject({ ok: false, conflict: false });
    expect("refusals" in build ? build.refusals[0]?.message : undefined).not.toBe(SERVER);
  });
});

// ACCEPT-FIX-5: the worker status and document failure must use Studio's product term too.
it("uses Wissensbasis/Wissensbasen in all German Knowledge Base messages", () => {
  const i18n = join(dirname(fileURLToPath(import.meta.url)), "../packages/chat-ui/src/shared/i18n");
  /** Each German message of a translation file, by key. */
  const german = (file: string) => {
    const path = join(i18n, file);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    const found = new Map<string, string>();
    const visit = (node: ts.Node, inGerman: boolean) => {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(source).replace(/^"|"$/gu, "");
        const next = name === "de" ? true : name === "en" ? false : inGerman;
        if (next && ts.isStringLiteral(node.initializer)) found.set(name, node.initializer.text);
        else ts.forEachChild(node, (child) => visit(child, next));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, inGerman));
    };
    visit(source, false);
    return found;
  };
  for (const file of ["knowledge.ts", "administration.ts"]) {
    expect(german(file).size, file).toBeGreaterThan(0);
    expect([...german(file).values()].filter((text) => text.includes("Wissensdatenbank"))).toEqual(
      []
    );
  }
  expect(german("administration.ts").get("infrastructure.workerKnowledge")).toBe(
    "Dienst für Wissensbasen"
  );
});
