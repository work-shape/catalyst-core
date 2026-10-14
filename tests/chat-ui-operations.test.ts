import { createElement, type ReactNode } from "react";
import type { OperationRunResource } from "@vivd-catalyst/api-client";
import { administration } from "@vivd-catalyst/chat-ui/admin";
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
} from "@vivd-catalyst/chat-ui/operations";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
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

const table = (runs: OperationRunResource[], locale: "de" | "en" = "en") =>
  render(createElement(OperationRunsTable, { runs, workspaces, onOpen: () => undefined }), locale);

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
    const took = (startedAt: string, finishedAt: string | undefined, locale: "de" | "en" = "en") =>
      formatOperationRunDuration({ startedAt, finishedAt }, locale);

    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T08:00:00.320Z")).toBe("320 ms");
    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T08:00:04.200Z")).toBe("4.2 sec");
    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T08:00:04.200Z", "de")).toBe("4,2 Sek.");
    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T08:03:12.000Z")).toBe("3 min 12 sec");
    expect(took("2026-10-05T08:00:00.000Z", "2026-10-05T10:05:00.000Z")).toBe("2 hr 5 min");
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
  it("shows a row per run: operation, who called through which agent, workspace, status, duration", () => {
    const markup = table([run()]);

    expect(markup).toContain('data-operation-run-id="opr_1"');
    expect(markup).toContain('data-status="done"');
    expect(markup).toMatch(
      /aria-label="Show the call of workspace\.apply_patch"[^>]*>workspace\.apply_patch<\/button>/u
    );
    expect(markup).toContain("Anna Beispiel");
    expect(markup).toMatch(/data-origin="agent"[^>]*>.*through agent payroll-agent/u);
    expect(markup).toContain("Produktteam");
    expect(markup).toContain("Done");
    expect(markup).toContain("4.2 sec");
    // Seven facts stand in five columns.
    expect(markup.match(/<th /gu)).toHaveLength(5);
  });

  it("names every origin and status in both languages", () => {
    const runs = [
      run({ id: "a", origin: { kind: "cli" }, status: "pending_confirmation" }),
      run({
        id: "b",
        origin: { kind: "schedule", scheduleId: "sch_1" },
        status: "pending_approval"
      }),
      run({ id: "c", origin: { kind: "user" }, status: "denied" }),
      run({ id: "d", origin: { kind: "mcp" }, status: "expired" }),
      run({ id: "e", origin: { kind: "workflow", workflowRunId: "w", stepRunId: "s" } }),
      run({ id: "f", status: "running" }),
      run({ id: "g", status: "failed" })
    ];
    const german = table(runs, "de");
    for (const word of [
      "Wartet auf Bestätigung",
      "Wartet auf Freigabe",
      "Verweigert",
      "Abgelaufen",
      "Erledigt",
      "Läuft",
      "Fehlgeschlagen",
      "Zeitplan",
      "Benutzer",
      "über Agent payroll-agent"
    ]) {
      expect(german).toContain(word);
    }
    const english = table(runs);
    for (const word of [
      "Waiting for confirmation",
      "Waiting for approval",
      "Denied",
      "Expired",
      "Running",
      "Failed",
      "Schedule",
      "CLI",
      "MCP",
      "Workflow"
    ]) {
      expect(english).toContain(word);
    }
  });

  it("shows a dash for a run outside a workspace and for one that has not ended", () => {
    const markup = table([
      run({ workspaceId: undefined, finishedAt: undefined, status: "running" })
    ]);

    expect(markup).toMatch(/<td[^>]*><span class="text-muted-foreground">–<\/span><\/td>/u);
    expect(markup).toMatch(/data-duration="true"[^>]*>.*–<\/span>/u);
    // A workspace the viewer is not in shows by its id.
    expect(table([run({ workspaceId: "cw_other" })])).toContain(">cw_other</td>");
  });

  it("offers the workspace filter only to a viewer who has workspaces", () => {
    const filters = (of: typeof workspaces, filter = defaultOperationRunFilter, locale?: "de") =>
      render(
        createElement(OperationRunFilters, { filter, workspaces: of, onChange: () => undefined }),
        locale
      );

    const markup = filters(workspaces);
    expect(markup).toContain('aria-label="Operation, exact name"');
    expect(markup).toContain('aria-label="Filter by status"');
    // The effect filter opens on the changing calls and offers the reads and every call.
    expect(markup).toMatch(
      /aria-label="Filter by effect"[^>]*>.*<option value="changing" selected="">Changing calls<\/option><option value="reading">Reading calls<\/option><option value="">All calls<\/option>/u
    );
    expect(filters(workspaces, { ...defaultOperationRunFilter, effect: undefined })).toContain(
      ">Clear filters</button>"
    );
    expect(markup).toContain('aria-label="Filter by origin"');
    expect(markup).toContain('aria-label="Filter by workspace"');
    expect(markup).toContain(">Produktteam</option>");
    expect(markup).not.toContain("Clear filters");
    expect(filters([])).not.toContain("Filter by workspace");
    expect(filters(workspaces, { ...defaultOperationRunFilter, status: "failed" })).toContain(
      ">Clear filters</button>"
    );
    const german = filters(workspaces, { ...defaultOperationRunFilter, origin: "cli" }, "de");
    expect(german).toContain('aria-label="Nach Herkunft filtern"');
    expect(german).toContain('aria-label="Nach Wirkung filtern"');
    expect(german).toContain(">Ändernde Aufrufe</option>");
    expect(german).toContain(">Lesende Aufrufe</option>");
    expect(german).toContain(">Alle Aufrufe</option>");
    expect(german).toContain(">Filter zurücksetzen</button>");
  });
});

describe("operation run detail", () => {
  const decided = run({
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
    expiresAt: "2026-10-12T08:00:00.000Z"
  });

  it("shows the whole record: decision, error, usage, ids and times", () => {
    const markup = detail(decided, "en", "/inbox/apr_7");

    expect(markup).toContain('data-operation-run-detail="opr_1"');
    for (const field of [
      "operation",
      "status",
      "effect",
      "actor",
      "origin",
      "origin.agentName",
      "origin.toolName",
      "workspace",
      "decision",
      "decision.comment",
      "approvalRequest",
      "error",
      "usage.modelCalls",
      "usage.inputTokens",
      "usage.outputTokens",
      "usage.totalTokens",
      "correlationId",
      "inputHash",
      "attempt",
      "createdAt",
      "startedAt",
      "finishedAt",
      "expiresAt"
    ]) {
      expect(markup).toContain(`data-field="${field}"`);
    }
    expect(markup).toContain("Changing");
    expect(markup).toContain("Approved");
    expect(markup).toContain("Felix Pahlke");
    expect(markup).not.toContain("user-felix");
    expect(markup).toContain("Einmal ist in Ordnung.");
    expect(markup).toContain("UPSTREAM_FAILED");
    expect(markup).toContain("The connection did not answer.");
    expect(markup).toContain("1,540");
    expect(markup).toContain("sha256:abc123");
    expect(markup).toMatch(/<a href="\/inbox\/apr_7"[^>]*>Open approval request<\/a>/u);
    // The correlation id can be copied.
    expect(markup).toContain('aria-label="Copy"');
  });

  it("leaves out what a run does not have and names the decider by id without a name", () => {
    const markup = detail(
      run({
        origin: { kind: "cli" },
        workspaceId: undefined,
        decision: { mode: "direct", by: "user-anna", at: "2026-10-05T08:00:00.000Z" }
      })
    );

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
    expect(markup).toContain("The caller&#x27;s own call");
    expect(markup).toContain("user-anna");
  });

  it("uses the spec's words in German", () => {
    const markup = detail(
      run({
        effect: "reading",
        decision: { mode: "declined", by: "user-felix", at: "2026-10-05T08:00:00.000Z" }
      }),
      "de",
      "/inbox/apr_7"
    );

    expect(markup).toContain("Lesend");
    expect(markup).toContain("Abgelehnt");
    expect(markup).toContain(">Freigabeanfrage öffnen</a>");
    expect(markup).toContain("Korrelations-ID");
    for (const mode of ["confirmed", "approved"] as const) {
      expect(
        detail(run({ decision: { mode, by: "u", at: "2026-10-05T08:00:00.000Z" } }), "de")
      ).toContain(mode === "confirmed" ? "Bestätigt" : "Freigegeben");
    }
  });
});

describe("Instance > Operations in the catalog", () => {
  it("stands after Jobs, wide, behind the right to view the audit log", () => {
    const ids = administration.pages.map((page) => page.id);
    const page = administration.pages.find((candidate) => candidate.id === "operations");

    expect(ids.indexOf("operations")).toBe(ids.indexOf("jobs") + 1);
    expect(page?.group).toBe("instance");
    expect(page?.width).toBe("wide");
    expect(
      page?.visible({ user: settingsUser({ permissions: ["audit.view"] }), workspaces: [] })
    ).toBe(true);
    expect(page?.visible({ user: settingsUser(), workspaces: [] })).toBe(false);
  });
});
