import { createElement, type ReactNode } from "react";
import type { AppAction, Asset, OperationRunResource } from "@vivd-catalyst/api-client";
import {
  ActionTestDialogView,
  appActionInputStart,
  appActionOutcome,
  AppActionsView,
  appActionTestable,
  appActionTestOutcome,
  AppDetailsDialog,
  AppEditFrame,
  AppToolsGroup,
  appToolsView,
  formatAppActionResult,
  readAppActionInput,
  type AppActionsRead,
  type AppToolsRead
} from "@vivd-catalyst/chat-ui/apps";
import {
  OperationRunDetail,
  operationRunHref,
  operationRunOfSearch,
  OperationRunsTable
} from "@vivd-catalyst/chat-ui/operations";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The screens of an App's named actions, on answers of `apps.actions.list` and
// `operations.list_runs` handed to them: the Actions side of a draft, the test dialog, the
// Details of an App, the origin of a run in Instance > Operations and the Apps group of an
// agent's tools. That the instance answers what these read is held in
// tests/app-actions-list.test.ts.
//
// Every test here fails without the change: the modules it reads did not exist, the draft had
// two sides, a run said "App" and nothing of its App, and an agent's Tools section had no
// group for Apps.

const noop = () => undefined;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

function action(overrides: Partial<AppAction> = {}): AppAction {
  return {
    name: "load",
    kind: "connection",
    effect: "reading",
    description: "Reads the open orders.",
    toolName: "app.orders.load",
    connection: { name: "crm", title: "Kundenkartei" },
    operation: "list_orders",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 },
        state: { type: "string" }
      },
      required: ["limit"]
    },
    policy: "allow",
    agentTool: true,
    ...overrides
  };
}

const save = action({
  name: "save",
  effect: "changing",
  description: undefined,
  toolName: "app.orders.save",
  operation: "write_order",
  policy: "deny"
});
const gone = action({
  name: "stock",
  toolName: "app.orders.stock",
  connection: { name: "depot" },
  operation: "count",
  policy: "deny",
  unavailable: "not_exposed",
  agentTool: false
});

const ready = (actions: AppAction[]): AppActionsRead => ({
  status: "ready",
  view: "draft",
  revision: 4,
  actions
});
const actionsView = (read: AppActionsRead, write = true, locale: "en" | "de" = "en") =>
  render(createElement(AppActionsView, { read, rights: { write }, onTest: noop }), locale);
/** The markup of one row. */
const rowOf = (markup: string, name: string) =>
  markup.split("<tr").find((row) => row.includes(`data-app-action="${name}"`)) ?? "";

describe("the Actions side of a draft", () => {
  it("is the third side of the draft beside Preview and Files", () => {
    const head = render(
      createElement(AppEditFrame, {
        name: "Orders",
        workspace: { id: "cw_1", name: "Sales" },
        rights: { read: true, write: true, publish: true, delete: false },
        draftRevision: 4,
        publishedRevision: 3,
        view: "actions",
        children: null,
        onViewChange: noop,
        onBack: noop
      })
    );

    expect([...head.matchAll(/role="radio"[^>]*>([^<]*)</gu)].map((match) => match[1])).toEqual([
      "Preview",
      "Files",
      "Actions"
    ]);
  });

  it("lists one row per action: its name, its effect, the Connection by its label with the operation, and what a call would come to", () => {
    const markup = actionsView(ready([action(), save, gone]));

    expect(markup).toContain('data-app-actions="ready"');
    const load = rowOf(markup, "load");
    expect(load).toContain("Reads the open orders.");
    expect(load).toContain("Reading");
    expect(load).toContain("Kundenkartei");
    expect(load).toContain("list_orders");
    expect(load).toContain("Operation of a connection");
    expect(load).toContain('data-policy="allow"');
    expect(load).toContain("Runs");
    // The label people read, never the name the manifest uses for the Connection.
    expect(load).not.toContain(">crm<");
  });

  it("says why a call cannot reach its operation, in the row", () => {
    const markup = actionsView(ready([gone]));

    expect(rowOf(markup, "stock")).toContain('data-unavailable="not_exposed"');
    expect(rowOf(markup, "stock")).toContain("This operation is not open to apps.");
    expect(rowOf(markup, "stock")).toContain("Refused");
  });

  it("offers the test on a reading action alone and says of a changing one that drafts refuse it", () => {
    const markup = actionsView(ready([action(), save]));

    expect(rowOf(markup, "load")).toContain('aria-label="Test load"');
    expect(rowOf(markup, "save")).not.toContain("Test");
    expect(rowOf(markup, "save")).toContain("Refused in drafts");
    expect(appActionOutcome(save, true).labelKey).toBe("apps.actionRefusedInDraft");
    expect(appActionOutcome({ ...save, policy: "confirm" }, false).labelKey).toBe(
      "apps.actionPolicyConfirm"
    );
    expect(appActionTestable(action(), "published", { write: true })).toBe(false);
  });

  it("renders no test control, and keeps no column for one, for a reader who may not write the App", () => {
    const markup = actionsView(ready([action(), save]), false);

    expect(markup).not.toContain("Test load");
    expect(markup.match(/<th[ >]/gu)).toHaveLength(4);
    expect(actionsView(ready([action(), save])).match(/<th[ >]/gu)).toHaveLength(5);
  });

  it("has a state of its own while it loads, for an App without actions and for a list that failed", () => {
    expect(actionsView({ status: "loading" })).toContain('aria-busy="true"');
    const empty = actionsView(ready([]));
    expect(empty).toContain('data-app-actions="empty"');
    expect(empty).toContain("This app has no actions yet.");
    const failed = actionsView({ status: "failed", retry: noop });
    expect(failed).toContain('data-app-actions="failed"');
    expect(failed).toContain("The actions could not be loaded.");
    expect(failed).toContain("Try again");
  });

  it("says all of it in German", () => {
    const markup = actionsView(ready([action(), save, gone]), true, "de");

    for (const text of [
      "Aktion",
      "Wirkung",
      "Ruft auf",
      "Für dich",
      "Lesend",
      "Läuft",
      "In Entwürfen abgelehnt",
      "Diese Operation ist für Apps nicht freigegeben.",
      'aria-label="load testen"'
    ]) {
      expect(markup, text).toContain(text);
    }
    expect(actionsView(ready([]), true, "de")).toContain("Diese App hat noch keine Aktionen.");
    expect(actionsView({ status: "failed", retry: noop }, true, "de")).toContain(
      "Die Aktionen konnten nicht geladen werden."
    );
  });
});

describe("the input of a test", () => {
  const { inputSchema } = action();

  it("starts with the required parameters and an empty value of each type", () => {
    expect(JSON.parse(appActionInputStart(inputSchema))).toEqual({ limit: 0 });
    expect(appActionInputStart({})).toBe("{}");
  });

  it("is read as JSON and held against the schema before any call", () => {
    expect(readAppActionInput('{"limit": 5, "state": "open"}', inputSchema)).toEqual({
      ok: true,
      input: { limit: 5, state: "open" }
    });
    const problemOf = (text: string) => {
      const read = readAppActionInput(text, inputSchema);
      return read.ok ? undefined : read.problem;
    };
    expect(problemOf("{limit: 5}")).toEqual({ kind: "not_json" });
    expect(problemOf("[5]")).toEqual({ kind: "not_object" });
    expect(problemOf("{}")).toEqual({ kind: "missing", name: "limit" });
    expect(problemOf('{"limit": 5, "page": 2}')).toEqual({ kind: "unknown", name: "page" });
    expect(problemOf('{"limit": "5"}')).toEqual({
      kind: "wrong_type",
      name: "limit",
      expected: "integer"
    });
    expect(problemOf('{"limit": 2.5}')).toMatchObject({ kind: "wrong_type" });
    expect(problemOf('{"limit": 51}')).toEqual({ kind: "not_allowed", name: "limit" });
  });
});

describe("the test dialog", () => {
  const dialog = (
    props: Partial<Parameters<typeof ActionTestDialogView>[0]> = {},
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(ActionTestDialogView, {
        action: action(),
        text: '{\n  "limit": 0\n}',
        problem: undefined,
        working: false,
        outcome: undefined,
        runHref: operationRunHref,
        onTextChange: noop,
        onTest: noop,
        onClose: noop,
        ...props
      }),
      locale
    );

  it("opens on the input with what the action calls, and shows no outcome before a call", () => {
    const markup = dialog();

    expect(markup).toContain("Test “load”");
    expect(markup).toContain("A real call from the draft, made in your name.");
    expect(markup).toContain("Kundenkartei");
    expect(markup).toContain("&quot;limit&quot;: 0");
    expect(markup).not.toContain("data-app-action-test-status");
  });

  it("shows what is wrong with the input at the input", () => {
    const markup = dialog({ problem: { kind: "wrong_type", name: "limit", expected: "integer" } });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("“limit” must be a whole number.");
    expect(dialog({ problem: { kind: "not_json" } }, "de")).toContain(
      "Das ist kein gültiges JSON."
    );
  });

  it("holds its button while the call runs", () => {
    expect(dialog({ working: true })).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/u);
  });

  it("shows the result as formatted JSON with the status and the link to the run", () => {
    const outcome = appActionTestOutcome({
      ok: true,
      result: { runId: "opr_7", status: "done", result: { rows: [{ id: 1 }] } }
    });
    const markup = dialog({ outcome });

    expect(markup).toContain('data-app-action-test-status="done"');
    expect(markup).toContain("Done");
    expect(markup).toContain("&quot;rows&quot;: [");
    expect(markup).toContain('href="/settings/instance/operations?run=opr_7"');
    expect(markup).toContain("Open the run in Operations");
    expect(markup).not.toContain("data-truncated");
    // Nothing links to a page its reader is not shown.
    expect(dialog({ outcome, runHref: undefined })).not.toContain("data-app-action-test-run");
  });

  it("cuts a result above the cap and marks it", () => {
    const whole = JSON.stringify({ text: "x".repeat(30_000) }, null, 2);
    const shown = formatAppActionResult({ text: "x".repeat(30_000) });

    expect(shown).toMatchObject({ truncated: true, length: whole.length });
    expect(shown.text.length).toBeLessThan(whole.length);
    expect(whole.startsWith(shown.text)).toBe(true);
    expect(formatAppActionResult({ ok: true })).toMatchObject({ truncated: false });

    const markup = dialog({
      outcome: { status: "done", runId: "opr_8", result: { text: "x".repeat(30_000) } }
    });
    expect(markup).toContain('data-truncated="true"');
    expect(markup).toContain(`Shortened: the first ${shown.text.length} of ${whole.length}`);
  });

  it("shows what a refused call answered, with its status and its run", () => {
    const outcome = appActionTestOutcome({
      ok: false,
      error: { code: "forbidden", message: "You may not use the connection.", runId: "opr_9" }
    });
    const markup = dialog({ outcome });

    expect(outcome.status).toBe("denied");
    expect(markup).toContain('data-app-action-test-status="denied"');
    expect(markup).toContain("Denied");
    expect(markup).toContain("You may not use the connection.");
    expect(markup).toContain("run=opr_9");
  });

  it("says in its own words that a call got no answer, and that one waits for an approval", () => {
    const failed = appActionTestOutcome({
      ok: false,
      error: { code: "failed", message: "The call could not be made." }
    });

    expect(failed).toEqual({ status: "failed" });
    expect(dialog({ outcome: failed }, "de")).toContain(
      "Der Aufruf konnte nicht ausgeführt werden."
    );
    const pending = appActionTestOutcome({
      ok: true,
      result: { runId: "opr_10", status: "pending_approval" }
    });
    expect(dialog({ outcome: pending })).toContain("The call waits for an approval.");
  });
});

describe("the Details of an App", () => {
  const app: Asset = {
    id: "asset_1",
    kind: "app",
    name: "orders",
    scope: { kind: "workspace", workspaceId: "cw_1" },
    revision: 4,
    config: { title: "Orders", manifest: { actions: [{ name: "load" }, { name: "save" }] } },
    updatedAt: "2026-10-12T08:00:00.000Z"
  };
  const details = (actions: AppActionsRead) =>
    render(
      createElement(AppDetailsDialog, {
        name: "Orders",
        app,
        actions,
        failed: false,
        onClose: noop
      })
    );

  it("lists each action with its effect and the policy's word, also where the record is the draft", () => {
    const markup = details(ready([action(), { ...save, policy: "approval" }]));
    const [, load = "", saved = ""] = markup.split("data-app-action=");

    expect(load).toContain("load");
    expect(load).toContain("Reading");
    expect(load).toContain("Runs");
    expect(saved).toContain("Changing");
    expect(saved).toContain("Needs an approval");
    expect(saved).not.toContain("Refused in drafts");

    // Until the instance said more, the actions are the names of the manifest.
    const waiting = details({ status: "loading" });
    expect(waiting).not.toContain("data-app-details-actions");
    expect(waiting).toContain(">load<");
    expect(waiting).toContain(">save<");
  });
});

describe("a run of an App in Instance > Operations", () => {
  function run(overrides: Partial<OperationRunResource> = {}): OperationRunResource {
    return {
      id: "opr_1",
      operation: "app.orders.load",
      effect: "reading",
      status: "done",
      actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
      origin: {
        kind: "app",
        appName: "orders",
        appRevisionId: "rev_4",
        actionName: "load",
        pageSessionId: "ps_1",
        target: { connection: "crm", operation: "list_orders" }
      },
      app: { title: "Orders board", revision: 4, deleted: false },
      inputHash: "sha256:abc123",
      attempt: 1,
      correlationId: "corr_1",
      createdAt: "2026-10-12T08:00:00.000Z",
      href: "runs/opr_1",
      ...overrides
    };
  }
  const table = (runs: OperationRunResource[], locale: "en" | "de" = "en") =>
    render(createElement(OperationRunsTable, { runs, workspaces: [], onOpen: noop }), locale);
  const detail = (shown: OperationRunResource) =>
    render(createElement(OperationRunDetail, { run: shown, workspaces: [] }));
  const factOf = (markup: string, name: string) =>
    markup.split("data-field=").find((fact) => fact.startsWith(`"${name}"`)) ?? "";

  it("says App with the App's name, the revision and the action under who called", () => {
    const markup = table([run()]);

    expect(markup).toContain('data-origin="app"');
    expect(markup).toContain('data-origin-app="active"');
    expect(markup).toContain("App · Orders board · revision 4 · load");
    expect(table([run()], "de")).toContain("Orders board · Revision 4 · load");
    // A revision the App no longer points at has no number, and none is made up.
    expect(table([run({ app: { title: "Orders board", deleted: false } })])).toContain(
      "Orders board · load"
    );
  });

  it("keeps the run of a deleted App and says so with the App's id", () => {
    const deleted = run({ app: { deleted: true } });

    expect(table([deleted])).toContain('data-origin-app="deleted"');
    expect(table([deleted])).toContain("Deleted app (orders) · load");
    expect(table([deleted], "de")).toContain("Gelöschte App (orders) · load");
    expect(factOf(detail(deleted), "origin.app")).toContain("Deleted app (orders)");
  });

  it("shows the Connection and the operation in the detail, and no input and no result", () => {
    const markup = detail(run());

    expect(factOf(markup, "origin.app")).toContain("Orders board");
    expect(factOf(markup, "origin.app")).toContain("revision 4");
    expect(factOf(markup, "origin.target")).toContain("crm");
    expect(factOf(markup, "origin.target")).toContain("list_orders");
    expect(markup).not.toContain('data-field="input"');
    expect(markup).not.toContain('data-field="output"');
    // A call of a Page of a conversation names no App.
    const page = run({
      origin: { kind: "app", appRevisionId: "fs_1", actionName: "load", pageSessionId: "ps_1" },
      app: undefined
    });
    expect(detail(page)).not.toContain('data-field="origin.app"');
    expect(table([page])).not.toContain("data-origin-app");
  });

  it("opens on the run its address names", () => {
    const href = operationRunHref("opr_1 2");

    expect(href).toBe("/settings/instance/operations?run=opr_1+2");
    expect(operationRunOfSearch(new URL(href, "https://catalyst.test").search)).toBe("opr_1 2");
    expect(operationRunOfSearch("")).toBeUndefined();
  });
});

describe("the Apps group of an agent's tools", () => {
  const read: AppToolsRead = {
    status: "ready",
    apps: [
      {
        name: "orders",
        title: "Orders board",
        view: "published",
        revision: 3,
        actions: [action(), save, gone]
      },
      { name: "empty", title: "Empty", view: "published", revision: 1, actions: [gone] }
    ]
  };
  const group = (selected: string[], state: AppToolsRead = read, locale: "en" | "de" = "en") =>
    render(createElement(AppToolsGroup, { read: state, selected, onChange: noop }), locale);

  it("offers one sub-group per App with the actions an agent can carry, and keeps what the agent holds that nothing offers", () => {
    const view = appToolsView(read, ["web_search", "app.orders.load", "app.gone.read"]);

    expect(view.groups.map((entry) => entry.name)).toEqual(["orders"]);
    expect(view.groups[0]?.tools.map((tool) => tool.toolName)).toEqual([
      "app.orders.load",
      "app.orders.save"
    ]);
    expect(view.unavailable).toEqual(["app.gone.read"]);
    expect(appToolsView({ status: "loading" }, ["app.orders.load"])).toMatchObject({
      groups: [],
      unchecked: ["app.orders.load"]
    });
  });

  it("is a labelled group with a check box per action, its description and its effect", () => {
    const markup = group(["app.orders.load"]);

    expect(markup).toContain('data-tool-group="apps"');
    expect(markup).toContain("<legend");
    expect(markup).toContain('data-app-tools="orders"');
    expect(markup).toContain("Orders board");
    expect(markup).toContain("1 of 2 selected");
    const [, load = "", saved = ""] = markup.split("data-app-tool=");
    expect(load).toContain('"app.orders.load"');
    expect(load).toContain("Reads the open orders.");
    expect(load).toContain("Reading");
    expect(saved).toContain('"app.orders.save"');
    expect(saved).toContain("Changing");
    expect(markup).not.toContain("app.orders.stock");
  });

  it("shows what the agent holds and nothing offers as names to remove, and nothing at all where there is nothing to show", () => {
    const markup = group(["app.gone.read"]);

    expect(markup).toContain('data-held-app-tool="app.gone.read"');
    expect(markup).toContain("No longer available");
    expect(group([], { status: "unknown" })).toBe("");
    expect(group(["app.orders.load"], { status: "loading" }, "de")).toContain(
      "Die Apps werden geprüft."
    );
    expect(group(["app.orders.load"], read, "de")).toContain("Aktionen veröffentlichter Apps.");
  });
});
