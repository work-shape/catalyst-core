import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  WorkflowRunsPageView,
  toWorkflow,
  toWorkflowRun,
  type WorkflowRunList
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// LOWS-B 3: a run refused the right `connection.use` says in the runs list, in plain words,
// which account may not use a Connection. The account is the one the run itself acted as, not
// the Workflow's account now, and the row never shows the right's technical name.

type WorkflowRunResource = Parameters<typeof toWorkflowRun>[0];

const noop = () => undefined;
const now = new Date("2026-10-17T12:00:00.000Z");
const refused = { code: "FORBIDDEN", message: "The instance's sentence", action: "connection.use" };

// The Workflow runs as "Buchhaltung" now, as the page head says; the runs below ran as
// "Belegprüfung" before, and each row names that account.
const workflow = toWorkflow(
  {
    name: "ledger-import",
    config: {
      id: "ledger-import",
      name: "Ledger import",
      runAs: "accounting",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] }],
      wiring: []
    },
    publishedRevision: 1
  },
  { mayStart: true, runsAs: "Buchhaltung" }
);

function run(id: string, extra: Partial<WorkflowRunResource>): WorkflowRunResource {
  return {
    id,
    workflow: "ledger-import",
    trigger: "manual",
    status: "failed",
    startedBy: { id: "user_1", label: "Ada Lovelace" },
    principal: { displayLabel: "Belegprüfung" },
    createdAt: "2026-10-17T09:00:00.000Z",
    error: refused,
    ...extra
  };
}

const rows = [
  // The newest part of a run that continued as new failed: its Lauf row says why.
  toWorkflowRun(
    run("wr_3", {
      createdAt: "2026-10-17T10:00:00.000Z",
      runKey: "2026-10-17",
      continuation: { rootRunId: "wr_2", previousRunId: "wr_2", number: 2 }
    })
  ),
  toWorkflowRun(
    run("wr_2", {
      status: "continued",
      createdAt: "2026-10-17T09:30:00.000Z",
      runKey: "2026-10-17",
      continuation: { rootRunId: "wr_2", number: 1 }
    })
  ),
  toWorkflowRun(run("wr_1", {})),
  // The instance names the Connection the refused step called.
  toWorkflowRun(
    run("wr_c", {
      createdAt: "2026-10-17T08:30:00.000Z",
      error: { ...refused, connection: "Buchungen" }
    })
  ),
  // An instance that names no account for the run: no account is guessed from the Workflow.
  toWorkflowRun(run("wr_0", { createdAt: "2026-10-17T08:00:00.000Z", principal: undefined }))
];

function reasons(locale: "en" | "de"): string[] {
  const runs: WorkflowRunList = {
    rows,
    failed: false,
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    retry: noop
  };
  const markup = renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(WorkflowRunsPageView, {
        workspaceId: "cw_1",
        workflowId: "ledger-import",
        workflow,
        runs,
        runsAvailable: true,
        now,
        onStart: noop,
        onOpenRoute: noop
      })
    })
  );
  expect(markup).toContain('data-run-group="wr_2"');
  expect(markup).not.toContain("connection.use");
  return [...markup.matchAll(/data-run-reason=""[^>]*>([^<]*)</gu)].map((match) => match[1] ?? "");
}

describe("why a run refused a Connection failed, in the runs list", () => {
  it("names the run's own account and the Connection in plain words", () => {
    const named =
      "The workflow may not do this: its account “Belegprüfung” may not use the Connection that one of its steps calls.";
    expect(reasons("en")).toEqual([
      named,
      named,
      "The workflow may not do this: its account “Belegprüfung” may not use the Connection “Buchungen”.",
      "The workflow may not do this: its account may not use the Connection that one of its steps calls."
    ]);
  });

  it("says it in German", () => {
    const named =
      "Der Workflow darf das nicht: Sein Konto „Belegprüfung“ darf die Verbindung nicht verwenden, die einer seiner Schritte aufruft.";
    expect(reasons("de")).toEqual([
      named,
      named,
      "Der Workflow darf das nicht: Sein Konto „Belegprüfung“ darf die Verbindung „Buchungen“ nicht verwenden.",
      "Der Workflow darf das nicht: Sein Konto darf die Verbindung nicht verwenden, die einer seiner Schritte aufruft."
    ]);
  });

  it("gives an administrator the advice in plain German", () => {
    const { t } = createTranslationContext("de");
    expect(
      t("workflows.advice.connectionUseAdmin", {
        account: "Belegprüfung",
        place: "Einstellungen › API-Zugang",
        connection: "Buchungen"
      })
    ).toBe(
      "Erlaube dem Konto „Belegprüfung“ unter Einstellungen › API-Zugang, die Verbindung „Buchungen“ zu verwenden, und starte den Workflow dann erneut."
    );
  });
});
