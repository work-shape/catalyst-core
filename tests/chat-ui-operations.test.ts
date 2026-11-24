import { createElement, type ReactNode } from "react";
import type { OperationRunResource } from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  defaultOperationRunFilter,
  formatOperationRunDuration,
  isOperationRunFilterDefault,
  isOperationRunFilterReadsOnly,
  operationRunFilterShowsReads,
  OperationRunDetail,
  OperationRunFilters,
  operationRunOriginFields,
  operationRunQuery,
  OperationRunsTable,
  operationRunWorkspaceLabel
} from "@work-shape/catalyst-chat-ui/operations";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { platformContext } from "./chat-ui-build-fixtures";
import { settingsUser } from "./chat-ui-settings-fixtures";

// Every test here fails without Instance > Operations: the modules it reads did not exist.

const workspaces = [{ id: "cw_team", name: "Produktteam" }];

function run(overrides: Partial<OperationRunResource> = {}): OperationRunResource {
  return {
    id: "opr_1",
    operation: "workspace.apply_patch",
    effect: "changing",
    target: "live",
    status: "done",
    actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
    origin: {
      kind: "agent",
      agentRunId: "run_1",
      conversationId: "conv_1",
      agentName: "payroll-agent",
      toolCallId: "call_1",
      toolName: "workspace_apply_patch"
    },
    workspaceId: "cw_team",
    inputHash: "sha256:abc123",
    attempt: 1,
    correlationId: "corr_1",
    createdAt: "2026-10-05T08:00:00.000Z",
    startedAt: "2026-10-05T08:00:01.000Z",
    finishedAt: "2026-10-05T08:00:05.200Z",
    href: "runs/opr_1",
    ...overrides
  };
}

function render(node: ReactNode, locale: "de" | "en" = "en"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale }, node));
}

const table = (runs: OperationRunResource[]) =>
  render(createElement(OperationRunsTable, { runs, workspaces, onOpen: () => undefined }));

const detail = (
  of: OperationRunResource,
  locale: "de" | "en" = "en",
  approvalRequestHref?: string
) =>
  render(createElement(OperationRunDetail, { run: of, workspaces, approvalRequestHref }), locale);

describe("operation runs model", () => {
  it("asks the server only for the filters that are set, with the name trimmed", () => {
    // The page opens on the changing calls. Fails without the change: it asked for every call.
    expect(operationRunQuery(defaultOperationRunFilter)).toEqual({ effect: "changing" });
    expect(operationRunQuery({ ...defaultOperationRunFilter, effect: undefined })).toEqual({});
    expect(isOperationRunFilterDefault({ ...defaultOperationRunFilter, operation: "  " })).toBe(
      true
    );
    for (const effect of ["reading", undefined] as const) {
      expect(isOperationRunFilterDefault({ ...defaultOperationRunFilter, effect })).toBe(false);
    }
    // The page says which reads are recorded whenever the list holds reads, and an empty list
    // of nothing but reads says it as its empty text.
    const reads = { ...defaultOperationRunFilter, effect: "reading" } as const;
    expect(operationRunFilterShowsReads(defaultOperationRunFilter)).toBe(false);
    expect(operationRunFilterShowsReads(reads)).toBe(true);
    expect(operationRunFilterShowsReads({ ...reads, effect: undefined })).toBe(true);
    expect(isOperationRunFilterReadsOnly(reads)).toBe(true);
    expect(isOperationRunFilterReadsOnly({ ...reads, status: "failed" })).toBe(false);
    expect(isOperationRunFilterReadsOnly({ ...reads, effect: undefined })).toBe(false);
    const filter = {
      operation: " assets.put ",
      effect: "reading",
      status: "failed",
      origin: "cli",
      workspaceId: "cw_team"
    } as const;
    expect(operationRunQuery(filter)).toEqual({
      operation: "assets.put",
      effect: "reading",
      status: "failed",
      origin: "cli",
      workspaceId: "cw_team"
    });
    expect(isOperationRunFilterDefault(filter)).toBe(false);
    expect(isOperationRunFilterDefault({ ...defaultOperationRunFilter, origin: "mcp" })).toBe(
      false
    );
  });

  it("says how long a run took and nothing for one that has not ended", () => {
    const took = (startedAt: string, finishedAt: string | undefined) =>
      formatOperationRunDuration({ startedAt, finishedAt }, "en");

    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T08:00:04.200Z")).toBe("4.2 sec");
    expect(took("2026-10-05T08:00:00.000Z", undefined)).toBeUndefined();
    expect(
      formatOperationRunDuration({ finishedAt: "2026-10-05T08:00:00.000Z" }, "en")
    ).toBeUndefined();
  });

  it("names a workspace the viewer knows, else its id, else nothing", () => {
    expect(operationRunWorkspaceLabel("cw_team", workspaces)).toBe("Produktteam");
    expect(operationRunWorkspaceLabel("cw_other", workspaces)).toBe("cw_other");
    expect(operationRunWorkspaceLabel(undefined, workspaces)).toBeUndefined();
  });

  it("lists what an origin says beyond its kind, names before ids", () => {
    expect(operationRunOriginFields(run().origin).map((entry) => entry.field)).toEqual([
      "agentName",
      "toolName",
      "conversationId",
      "agentRunId",
      "toolCallId"
    ]);
    expect(operationRunOriginFields({ kind: "user" })).toEqual([]);
    expect(operationRunOriginFields({ kind: "mcp" })).toEqual([]);
    expect(operationRunOriginFields({ kind: "schedule", scheduleId: "sch_1" })).toEqual([
      { field: "scheduleId", labelKey: "operations.fieldScheduleId", value: "sch_1" }
    ]);
  });
});

describe("operation runs list", () => {
  it("shows a row per run with its status, its target and who called through which agent", () => {
    const markup = table([
      run({ id: "live", target: "live" }),
      run({ id: "sim", target: "dry_run" })
    ]);
    expect(markup).toContain('data-operation-run-id="live"');
    expect(markup).toContain('data-status="done"');
    expect(markup).toContain('data-target="live"');
    expect(markup).toContain('data-target="dry_run"');
    expect(markup).toContain("Anna Beispiel");
    expect(markup).toContain("Produktteam");
  });

  // fix (EW-2): a decided call waits to run, not for a decision.
  it.each([
    ["pending_confirmation", "confirmed"],
    ["pending_approval", "approved"]
  ] as const)("says a %s call that was %s waits to run, not for a decision", (status, mode) => {
    const waiting = run({
      status,
      startedAt: undefined,
      finishedAt: undefined,
      decision: { mode, by: "user-anna", at: "2026-10-05T08:00:02.000Z" }
    });
    for (const markup of [table([waiting]), detail(waiting)]) {
      expect(markup).toContain("waiting to run");
      expect(markup).not.toMatch(/Waiting for (confirmation|approval)/u);
    }
  });

  it("offers the workspace filter only to a viewer who has workspaces", () => {
    const filters = (of: typeof workspaces) =>
      render(
        createElement(OperationRunFilters, {
          filter: defaultOperationRunFilter,
          workspaces: of,
          onChange: () => undefined
        })
      );
    expect(filters(workspaces)).toContain('aria-label="Filter by workspace"');
    expect(filters([])).not.toContain("Filter by workspace");
  });
});

describe("operation run detail", () => {
  it("shows the whole record, names the decider, never by account id", () => {
    const markup = detail(
      run({
        status: "failed",
        approvalRequestId: "apr_7",
        decision: {
          mode: "approved",
          by: "user-felix",
          byLabel: "Felix Pahlke",
          at: "2026-10-05T07:59:00.000Z",
          comment: "Einmal ist in Ordnung."
        },
        error: { code: "UPSTREAM_FAILED", message: "The connection did not answer." },
        usage: { modelCalls: 2, inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
        expiresAt: "2026-10-05T08:00:00.000Z"
      }),
      "en",
      "/inbox/apr_7"
    );
    for (const field of [
      "decision",
      "approvalRequest",
      "error",
      "usage.totalTokens",
      "expiresAt"
    ]) {
      expect(markup).toContain(`data-field="${field}"`);
    }
    expect(markup).toContain("Felix Pahlke");
    expect(markup).not.toContain("user-felix");
    expect(markup).toContain('href="/inbox/apr_7"');
  });

  it("leaves out what a run does not have", () => {
    const markup = detail(run({ origin: { kind: "cli" }, workspaceId: undefined }));
    for (const field of [
      "workspace",
      "error",
      "usage.modelCalls",
      "approvalRequest",
      "expiresAt"
    ]) {
      expect(markup).not.toContain(`data-field="${field}"`);
    }
    expect(markup).not.toContain('data-field="origin.');
  });

  // ERASE-ACTOR-IDS: a caller whose account is gone is named as one, never by the account id.
  it("names a caller whose account is gone as a deleted account, never by the id", () => {
    const markup = detail(
      run({
        actor: { kind: "user", id: "user-anna", label: "" },
        decision: { mode: "direct", by: "user-anna", at: "2026-10-05T08:00:00.000Z" }
      })
    );
    expect(markup).toContain("Deleted account, ");
    expect(markup).not.toContain("user-anna");
  });
});

describe("Instance > Operations in the catalog", () => {
  it("stands after Jobs in System, wide, behind the right to see the System pages", () => {
    const ids = administration.pages.map((page) => page.id);
    const page = administration.pages.find((candidate) => candidate.id === "operations");

    expect(ids.indexOf("operations")).toBe(ids.indexOf("jobs") + 1);
    expect(page?.group).toBe("instance");
    expect(page?.system).toBe(true);
    expect(page?.width).toBe("wide");
    expect(
      page?.visible({
        user: settingsUser(),
        workspaces: [],
        platform: { ...platformContext(), instanceActions: ["system.view"] }
      })
    ).toBe(true);
    // The audit log's readers keep the audit log, not this page (RIGHTS-1e).
    expect(
      page?.visible({
        user: settingsUser({ permissions: ["audit.view"] }),
        workspaces: [],
        platform: platformContext()
      })
    ).toBe(false);
  });
});
