import { createElement, type ReactNode } from "react";
import type {
  AppAction,
  AppActions,
  Asset,
  OperationRunResource
} from "@work-shape/catalyst-api-client";
import {
  ActionTestDialogView,
  appActionInputStart,
  appActionLiveOnceOffered,
  appActionOutcome,
  AppActionsView,
  appActionTestable,
  appActionTestOutcome,
  AppDetailsDialog,
  AppToolsGroup,
  appsOfOwner,
  appToolsView,
  formatAppActionResult,
  keptWhileItServes,
  readAppActionInput,
  type AppActionsLiveOnce,
  type AppActionsRead,
  type AppToolsRead
} from "@work-shape/catalyst-chat-ui/apps";
import {
  OperationRunDetail,
  operationRunHref,
  operationRunOfSearch,
  operationRunsHref,
  OperationRunsTable
} from "@work-shape/catalyst-chat-ui/operations";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The screens of an App's named actions, on answers of `apps.actions.list` and
// `operations.list_runs` handed to them: the Actions side of a draft, the test dialog, the
// Details of an App, the origin of a run in Instance > Operations and the Apps group of an
// agent's tools. That the instance answers what these read is held in
// tests/app-actions-list.test.ts; the target each row shows in tests/app-draft-safe-mode.test.ts.

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
const switchOff: AppActionsLiveOnce = { switching: undefined, failed: undefined, switchOn: noop };
const actionsView = (read: AppActionsRead, write = true, liveOnce?: AppActionsLiveOnce) =>
  render(
    createElement(AppActionsView, {
      read,
      rights: { write },
      onTest: noop,
      ...(liveOnce ? { liveOnce } : {})
    })
  );
/** `save` as a draft lists it to a writer whose call the policy lets run. */
const simulated = { ...save, policy: "confirm" as const, target: "dry_run" as const };
/** The markup of one row. */
const rowOf = (markup: string, name: string) =>
  markup.split("<tr").find((row) => row.includes(`data-app-action="${name}"`)) ?? "";

describe("the Actions side of a draft", () => {
  it("lists one row per action with the Connection by its label and what a call would come to", () => {
    const markup = actionsView(ready([action(), save, gone]));

    const load = rowOf(markup, "load");
    expect(load).toContain("Kundenkartei");
    expect(load).toContain("list_orders");
    expect(load).toContain('data-policy="allow"');
    // The label people read, never the name the manifest uses for the Connection.
    expect(load).not.toContain(">crm<");
    expect(rowOf(markup, "stock")).toContain('data-unavailable="not_exposed"');
  });

  it("gives an sql action the Data Store where the Connection would be, and marks a store that is not there", () => {
    const { effect, toolName, inputSchema, policy, agentTool } = action();
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
    const missing: AppAction = {
      ...list,
      name: "load_gone",
      dataStore: { name: "ledger" },
      unavailable: "data_store_missing"
    };
    const markup = actionsView(ready([list, missing]));

    expect(rowOf(markup, "list_findings")).toContain("Findings of the month");
    expect(rowOf(markup, "load_gone")).toContain("ledger");
    expect(rowOf(markup, "load_gone")).toContain('data-unavailable="data_store_missing"');
  });

  // ADR-0031: a changing action of a draft is simulated, and "Run live once" carries out the
  // writer's own next call of it.
  it("offers the test on every action of a draft, and Run live once on a changing one the policy lets run", () => {
    const markup = actionsView(ready([action({ target: "live" }), simulated]), true, switchOff);

    expect(rowOf(markup, "load")).toContain('aria-label="Test load"');
    expect(rowOf(markup, "load")).not.toContain("data-run-live-once");
    const row = rowOf(markup, "save");
    expect(row).toContain('aria-label="Test save"');
    expect(row).toContain('data-target="dry_run"');
    expect(row).toContain('data-run-live-once="off"');
    // What a call comes to: in the draft an allowed call can be tested, either effect.
    expect(appActionOutcome({ ...save, policy: "allow" }, true).labelKey).toBe(
      "apps.actionTestableInDraft"
    );
    expect(appActionOutcome(action({ policy: "approval" }), true).labelKey).toBe(
      "apps.actionPolicyApproval"
    );
    expect(appActionOutcome({ ...save, policy: "confirm" }, false).labelKey).toBe(
      "apps.actionPolicyConfirm"
    );
    expect(appActionTestable("published", { write: true })).toBe(false);
    expect(appActionTestable("draft", { write: false })).toBe(false);
  });

  it("renders no test control, and keeps no column for one, for a reader who may not write the App", () => {
    const markup = actionsView(ready([action(), save]), false);

    expect(markup).not.toContain("Test load");
    expect(markup.match(/<th[ >]/gu)).toHaveLength(4);
    expect(actionsView(ready([action(), save])).match(/<th[ >]/gu)).toHaveLength(5);
  });

  it("has a state of its own while it loads, for an App without actions and for a list that failed", () => {
    expect(actionsView({ status: "loading" })).toContain('aria-busy="true"');
    expect(actionsView(ready([]))).toContain('data-app-actions="empty"');
    const failed = actionsView({ status: "failed", retry: noop });
    expect(failed).toContain('data-app-actions="failed"');
    expect(failed).toContain("Try again");
  });
});

describe("Run live once on the Actions side of a draft", () => {
  it("is on once switched, waits while it switches, and says a failed switch", () => {
    expect(
      rowOf(actionsView(ready([{ ...simulated, target: "live" }]), true, switchOff), "save")
    ).toContain('data-run-live-once="on"');
    expect(
      rowOf(actionsView(ready([simulated]), true, { ...switchOff, switching: "save" }), "save")
    ).toContain('data-run-live-once="busy"');
    const failed = { action: "save", message: "The draft changed." };
    expect(actionsView(ready([simulated]), true, { ...switchOff, failed })).toContain(
      "The draft changed."
    );
  });

  it("is not offered where the call would wait for an approval, is refused, reads, or to whom may not write", () => {
    for (const policy of ["approval", "deny"] as const) {
      expect(actionsView(ready([{ ...simulated, policy }]), true, switchOff), policy).not.toContain(
        "data-run-live-once"
      );
    }
    const writer = { write: true };
    expect(appActionLiveOnceOffered(simulated, "draft", writer)).toBe(true);
    expect(appActionLiveOnceOffered(simulated, "draft", { write: false })).toBe(false);
    expect(appActionLiveOnceOffered(simulated, "published", writer)).toBe(false);
    expect(appActionLiveOnceOffered({ ...simulated, effect: "reading" }, "draft", writer)).toBe(
      false
    );
    const missing = { ...simulated, unavailable: "connection_missing" as const };
    expect(appActionLiveOnceOffered(missing, "draft", writer)).toBe(false);
  });

  // Fails before DP-1: a draft's `workflow` action offered the switch, though its call starts a
  // test run of the Workflow that no switch makes live.
  it("is not offered on a workflow action, whose draft call is a test run", () => {
    const {
      connection: _connection,
      operation: _operation,
      unavailable: _u,
      ...shared
    } = simulated;
    const run: AppAction = {
      ...shared,
      kind: "workflow",
      workflow: { name: "notify-clients" },
      target: "test"
    };
    expect(appActionLiveOnceOffered(run, "draft", { write: true })).toBe(false);
    expect(actionsView(ready([run]), true, switchOff)).not.toContain("data-run-live-once");
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

  it("shows what a simulated call would have done, in the reader's language and not the instance's", () => {
    const outcome = {
      status: "dry_run" as const,
      message: "Would have started the Workflow 'visit-log' (instance).",
      input: { page: "/draft" }
    };
    const en = dialog({ outcome });
    expect(en).toContain('data-app-action-test-status="dry_run"');
    expect(en).toContain("&quot;page&quot;: &quot;/draft&quot;");
    expect(en).not.toContain("(instance)");
    expect(dialog({ outcome }, "de")).not.toContain("Would have");
  });

  it("links the place the call is listed in only for a reader who may open it", () => {
    expect(dialog()).toContain('href="/settings/instance/operations"');
    expect(dialog({ operations: undefined })).not.toContain("data-app-action-test-operations");
  });

  it("shows what is wrong with the input at the input", () => {
    const markup = dialog({ problem: { kind: "wrong_type", name: "limit", expected: "integer" } });
    expect(markup).toContain('role="alert"');
  });

  it("holds its button while the call runs, and shows no answer of an earlier call", () => {
    const outcome = appActionTestOutcome({
      ok: true,
      result: { runId: "opr_6", status: "done", result: { rows: [] } }
    });
    const markup = dialog({ working: true, outcome });

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"/u);
    expect(markup).toContain('data-app-action-test-status="running"');
    expect(markup).not.toContain("&quot;rows&quot;");
    expect(markup).not.toContain("run=opr_6");
  });

  it("shows the result with its status and the link to the run, which a reader without Operations is not offered", () => {
    const outcome = appActionTestOutcome({
      ok: true,
      result: { runId: "opr_7", status: "done", result: { rows: [{ id: 1 }] } }
    });
    const markup = dialog({ outcome });

    expect(markup).toContain('data-app-action-test-status="done"');
    expect(markup).toContain("&quot;rows&quot;: [");
    expect(markup).toContain('href="/settings/instance/operations?run=opr_7"');
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
  });

  it("reads a refused, a failed and a held call", () => {
    const refused = appActionTestOutcome({
      ok: false,
      error: { code: "forbidden", message: "You may not use the connection.", runId: "opr_9" }
    });
    expect(refused.status).toBe("denied");
    const markup = dialog({ outcome: refused });
    expect(markup).toContain("You may not use the connection.");
    expect(markup).toContain("run=opr_9");
    expect(
      appActionTestOutcome({
        ok: false,
        error: { code: "failed", message: "The call could not be made." }
      })
    ).toEqual({ status: "failed" });
    expect(
      appActionTestOutcome({ ok: true, result: { runId: "opr_10", status: "pending_approval" } })
        .status
    ).toBe("pending_approval");
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
  const details = (actions: AppActionsRead, dataSources?: string[]) =>
    render(
      createElement(AppDetailsDialog, {
        name: "Orders",
        app,
        actions,
        ...(dataSources ? { dataSources } : {}),
        failed: false,
        onClose: noop
      })
    );

  it("lists the instance's actions, and the manifest's names until the instance said more", () => {
    expect(details(ready([action()]))).toContain("data-app-details-actions");
    const waiting = details({ status: "loading" });
    expect(waiting).not.toContain("data-app-details-actions");
    expect(waiting).toContain(">load<");
    expect(waiting).toContain(">save<");
  });

  it("says where the data of each store comes from only once it is known", () => {
    const line = "Shows data from “Kunden”.";
    expect(details(ready([action()]), [line])).toContain(`>${line}<`);
    expect(details(ready([action()]))).not.toContain("data-app-data-sources");
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
  const table = (runs: OperationRunResource[]) =>
    render(createElement(OperationRunsTable, { runs, workspaces: [], onOpen: noop }));
  const detail = (shown: OperationRunResource) =>
    render(createElement(OperationRunDetail, { run: shown, workspaces: [] }));
  const factOf = (markup: string, name: string) =>
    markup.split("data-field=").find((fact) => fact.startsWith(`"${name}"`)) ?? "";

  it("names the App, its revision and the action, and makes up no revision the App no longer points at", () => {
    expect(table([run()])).toContain("Orders board · revision 4 · load");
    expect(table([run({ app: { title: "Orders board", deleted: false } })])).toContain(
      "Orders board · load"
    );
    // The run of a deleted App is kept, with the App's id.
    const deleted = run({ app: { deleted: true } });
    expect(table([deleted])).toContain('data-origin-app="deleted"');
    expect(factOf(detail(deleted), "origin.app")).toContain("orders");
  });

  it("shows the Connection and the operation in the detail, and no input and no result", () => {
    const markup = detail(run());

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
        scope: { kind: "instance" },
        view: "published",
        revision: 3,
        actions: [action(), save, gone]
      },
      {
        name: "empty",
        title: "Empty",
        scope: { kind: "instance" },
        view: "published",
        revision: 1,
        actions: [gone]
      }
    ]
  };
  const group = (selected: string[], state: AppToolsRead = read) =>
    render(createElement(AppToolsGroup, { read: state, selected, onChange: noop }));

  // REF-OWNER: a holder of use alone gets each action's name, description and effect, and the
  // chooser offers every one of them under its deterministic tool name.
  it("offers one sub-group per App with the actions an agent can carry, and keeps what the agent holds that nothing offers", () => {
    const view = appToolsView(read, ["web_search", "app.orders.load", "app.gone.read"]);

    expect(view.groups.map((entry) => entry.name)).toEqual(["orders"]);
    expect(view.groups[0]?.tools).toEqual([
      {
        toolName: "app.orders.load",
        label: "load",
        effect: "reading",
        description: "Reads the open orders."
      },
      { toolName: "app.orders.save", label: "save", effect: "changing" }
    ]);
    expect(view.unavailable).toEqual(["app.gone.read"]);
    expect(appToolsView({ status: "loading" }, ["app.orders.load"])).toMatchObject({
      groups: [],
      unchecked: ["app.orders.load"]
    });
  });

  // REF-OWNER: an agent names Apps of its own owner and of the instance, as it names skills.
  it("offers an agent of the instance the instance's Apps alone, and a workspace's agent its workspace's and the instance's", () => {
    const app = (name: string, scope: AppActions["apps"][number]["scope"]) => ({
      name,
      title: name,
      scope,
      view: "published" as const,
      revision: 1,
      actions: [action()]
    });
    const apps = [
      app("shared", { kind: "instance" }),
      app("own", { kind: "workspace", workspaceId: "cw_own" }),
      app("other", { kind: "workspace", workspaceId: "cw_other" })
    ];

    expect(appsOfOwner(apps, undefined).map((entry) => entry.name)).toEqual(["shared"]);
    expect(appsOfOwner(apps, "cw_own").map((entry) => entry.name)).toEqual(["shared", "own"]);
  });

  it("offers a check box per carried action, the held ones to remove, and nothing where there is nothing to show", () => {
    const markup = group(["app.orders.load", "app.gone.read"]);
    expect(markup).toContain('data-app-tool="app.orders.load"');
    expect(markup).toContain('data-app-tool="app.orders.save"');
    expect(markup).not.toContain("app.orders.stock");
    expect(markup).toContain('data-held-app-tool="app.gone.read"');
    expect(group([], { status: "unknown" })).toBe("");
  });

  // The instance pages the published Apps. The group showed a partial list as if it were
  // whole, and called a held action of an App not read yet "No longer available"
  // (DISCOVERY-PAGING: the next page is read from the group).
  it("says that more Apps follow, offers the next page, and judges no held action not read yet", () => {
    const cut: AppToolsRead = { ...read, more: { loading: false, load: noop } };
    const view = appToolsView(cut, ["app.orders.load", "app.later.read"]);

    expect(view).toMatchObject({ cut: true, unavailable: [], unchecked: ["app.later.read"] });
    const markup = group(["app.later.read"], cut);
    expect(markup).toContain("data-app-tools-cut");
    expect(markup).toContain("data-app-tools-more");
    expect(markup).toContain('data-held-app-tool="app.later.read"');
    expect(markup).not.toContain("No longer available");
    expect(group([], read)).not.toContain("data-app-tools-cut");
  });
});
