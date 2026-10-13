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
  keptWhileItServes,
  readAppActionInput,
  type AppActionsRead,
  type AppToolsRead
} from "@vivd-catalyst/chat-ui/apps";
import {
  OperationRunDetail,
  operationRunHref,
  operationRunOfSearch,
  operationRunsHref,
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

type ConnectionAction = Extract<AppAction, { kind: "connection" }>;

function action(overrides: Partial<ConnectionAction> = {}): ConnectionAction {
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

    expect([...head.matchAll(/role="tab"[^>]*>([^<]*)</gu)].map((match) => match[1])).toEqual([
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
    expect(load).toContain("The connection and what the action asks of it");
    expect(load).toContain('data-policy="allow"');
    // The draft's word for a reading action that would run: it can be tested here.
    expect(load).toContain("Can be tested");
    expect(markup).toContain(">In this draft<");
    // The label people read, never the name the manifest uses for the Connection.
    expect(load).not.toContain(">crm<");
  });

  it("gives an sql action the same row, with the Data Store where the Connection would be", () => {
    const { name, effect, toolName, inputSchema, policy, agentTool } = action();
    const list: AppAction = {
      name: "list_findings",
      kind: "sql",
      effect,
      toolName,
      inputSchema,
      policy,
      agentTool,
      dataStore: { name: "findings", title: "Findings of the month" }
    };
    const gone: AppAction = {
      ...list,
      name: `${name}_gone`,
      dataStore: { name: "ledger" },
      unavailable: "data_store_missing"
    };
    const markup = actionsView(ready([list, gone]));

    const row = rowOf(markup, "list_findings");
    expect(row).toContain("Findings of the month");
    expect(row).toContain(">sql<");
    expect(row).toContain("Reading");
    expect(row).toContain('data-policy="allow"');
    expect(row).toContain("Can be tested");
    // Without a title the store goes by its name, and a store that is not there says so.
    expect(rowOf(markup, "load_gone")).toContain("ledger");
    expect(rowOf(markup, "load_gone")).toContain('data-unavailable="data_store_missing"');
    expect(rowOf(markup, "load_gone")).toContain("The data store is not available to this app.");
  });

  it("says why a call cannot reach its operation, in the row", () => {
    const markup = actionsView(ready([gone]));

    expect(rowOf(markup, "stock")).toContain('data-unavailable="not_exposed"');
    expect(rowOf(markup, "stock")).toContain("This operation is not open to apps.");
    expect(rowOf(markup, "stock")).toContain("Refused");
  });

  it("says in one line over the list what it is and that a draft changes nothing", () => {
    const intro =
      "What this app can read or change in other systems. Nothing is changed from a draft";

    expect(actionsView(ready([action(), save]))).toContain(intro);
    // The line stands over the room the list loads into, and not over a state with its own.
    expect(actionsView({ status: "loading" })).toContain(intro);
    expect(actionsView(ready([]))).not.toContain("data-app-actions-intro");
    expect(actionsView({ status: "failed", retry: noop })).not.toContain("data-app-actions-intro");
  });

  // At 390 wide the last columns ran out of sight with no cue. The table now stacks its rows
  // in narrow room, and each row says which of its cells take a line of their own.
  it("stacks each action as a block in narrow room, with the test beside what a call comes to", () => {
    const markup = actionsView(ready([action(), save]));

    expect(markup).toContain("@container/table");
    expect(markup).toContain("@max-2xl/table:[&amp;_tr]:grid");
    expect(markup).toContain("@max-2xl/table:[&amp;_thead]:hidden");
    const fullCells = (row: string) => row.match(/data-stacked="full"/gu)?.length ?? 0;
    // What the action calls takes a line. So does the outcome of a row that has no test.
    expect(fullCells(rowOf(markup, "load"))).toBe(1);
    expect(fullCells(rowOf(markup, "save"))).toBe(2);
    expect(rowOf(markup, "save")).toContain('colSpan="2"');
  });

  it("offers the test on a reading action alone and says of a changing one that a draft does not carry it out", () => {
    const markup = actionsView(ready([action(), save]));

    expect(rowOf(markup, "load")).toContain('aria-label="Test load"');
    expect(rowOf(markup, "save")).not.toContain("Test");
    expect(rowOf(markup, "save")).toContain("Not carried out in a draft");
    expect(appActionOutcome(save, true).labelKey).toBe("apps.actionNotCarriedOutInDraft");
    expect(appActionOutcome(action(), true).labelKey).toBe("apps.actionTestableInDraft");
    // A reading action the policy holds or refuses keeps the policy's word in the draft too.
    expect(appActionOutcome(action({ policy: "approval" }), true).labelKey).toBe(
      "apps.actionPolicyApproval"
    );
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
      "In diesem Entwurf",
      "Lesend",
      "Kann getestet werden",
      "Im Entwurf nicht ausgeführt",
      "Was diese App in anderen Systemen lesen oder ändern kann.",
      "Die Verbindung und was die Aktion von ihr verlangt",
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
        operations: { href: operationRunsHref(), runHref: operationRunHref },
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

  it("links the place the call is listed in, for a reader who may open it", () => {
    const link =
      /<a[^>]*href="\/settings\/instance\/operations"[^>]*>It is listed under Operations\.<\/a>/u;

    expect(dialog()).toMatch(link);
    // Nothing links to a page its reader is not shown: the sentence stays, as text.
    const plain = dialog({ operations: undefined });
    expect(plain).toContain("It is listed under Operations.");
    expect(plain).not.toContain("data-app-action-test-operations");
    expect(dialog({}, "de")).toMatch(/<a[^>]*>Er steht unter Operationen\.<\/a>/u);
  });

  it("shows what is wrong with the input at the input", () => {
    const markup = dialog({ problem: { kind: "wrong_type", name: "limit", expected: "integer" } });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("“limit” must be a whole number.");
    expect(dialog({ problem: { kind: "not_json" } }, "de")).toContain(
      "Das ist kein gültiges JSON."
    );
  });

  it("holds its button while the call runs, says that it waits and shows no answer of the call before", () => {
    const outcome = appActionTestOutcome({
      ok: true,
      result: { runId: "opr_6", status: "done", result: { rows: [] } }
    });
    const markup = dialog({ working: true, outcome });

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/u);
    expect(markup).toContain('data-app-action-test-status="running"');
    expect(markup).toContain("Waiting for the answer.");
    expect(markup).not.toContain("&quot;rows&quot;");
    expect(markup).not.toContain("run=opr_6");
    expect(dialog({ working: true }, "de")).toContain("Die Antwort steht noch aus.");
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
    expect(dialog({ outcome, operations: undefined })).not.toContain("data-app-action-test-run");
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

  // The text of a refusal says that asking again does not help, and "Test" stayed the main
  // button under it, with the word "Denied" in the grey of a note.
  it("leads with Close after a refusal and shows the refusal in the colour of a failure", () => {
    const classesOf = (markup: string, label: string) =>
      new RegExp(`<button[^>]*class="([^"]*)"[^>]*>(?:<[^>]*>)*${label}<`, "u").exec(markup)?.[1];
    const badgeOf = (markup: string, label: string) =>
      new RegExp(`<span[^>]*class="([^"]*)"[^>]*>(?:<span[^>]*></span>)?${label}</span>`, "u").exec(
        markup
      )?.[1];
    const idle = dialog();
    const refused = dialog({ outcome: { status: "denied", message: "You may not." } });
    const failed = dialog({ outcome: { status: "failed" } });

    expect(classesOf(idle, "Test")).toBeDefined();
    expect(classesOf(refused, "Close")).toBe(classesOf(idle, "Test"));
    expect(classesOf(refused, "Test")).toBe(classesOf(idle, "Close"));
    // Any other way a test ends can change with the next one: the test keeps leading.
    expect(classesOf(failed, "Test")).toBe(classesOf(idle, "Test"));
    expect(badgeOf(refused, "Denied")).toBeDefined();
    expect(badgeOf(refused, "Denied")).toBe(badgeOf(failed, "Failed"));
    // While the next call runs the refusal is no longer what the dialog says.
    expect(classesOf(dialog({ working: true, outcome: { status: "denied" } }), "Close")).toBe(
      classesOf(idle, "Close")
    );
  });

  it("asks for the address of the draft once while it serves, and again after it expired", async () => {
    let now = 0;
    let asked = 0;
    const frame = keptWhileItServes(
      () => Promise.resolve(++asked),
      () => now
    );

    expect(await frame()).toBe(1);
    now = 54 * 60_000;
    expect(await frame()).toBe(1);
    // The token of an address serves an hour. A dialog left open over it asks again, where
    // it called with the expired address before and failed.
    now = 56 * 60_000;
    expect(await frame()).toBe(2);
    now = 100 * 60_000;
    expect(await frame()).toBe(2);
    expect(asked).toBe(2);
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
    expect(load).not.toContain("Can be tested");
    expect(saved).toContain("Changing");
    expect(saved).toContain("Needs an approval");
    expect(saved).not.toContain("Not carried out in a draft");

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
      target: "live",
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
    truncated: false,
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

  // The instance lists the first 200 published Apps and says when it left some out. The group
  // showed the cut list as if it were whole, and called a held action of an App left out
  // "No longer available".
  it("says that Apps were left out, and judges no held action the cut list does not offer", () => {
    const cut: AppToolsRead = { ...read, truncated: true };
    const view = appToolsView(cut, ["app.orders.load", "app.later.read"]);

    expect(view).toMatchObject({ cut: true, unavailable: [], unchecked: ["app.later.read"] });
    const markup = group(["app.later.read"], cut);
    expect(markup).toContain("data-app-tools-cut");
    expect(markup).toContain("Not every app is listed");
    expect(markup).toContain('data-held-app-tool="app.later.read"');
    expect(markup).toContain("Not in this list. The agent keeps these actions.");
    expect(markup).not.toContain("No longer available");
    // Said also where the cut list offers nothing and the agent holds nothing.
    expect(group([], { status: "ready", truncated: true, apps: [] }, "de")).toContain(
      "Nicht jede App ist aufgeführt"
    );
    expect(group([], read)).not.toContain("data-app-tools-cut");
  });
});
