import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { approvalRequestReverter } from "../packages/chat-ui/src/approvals/approval-request-api";
import {
  ApprovalRequestCardView,
  type ApprovalRequestCardActions,
  type ApprovalRequestCardState
} from "../packages/chat-ui/src/approvals/approval-request-card";
import {
  decidedApprovalRequests,
  readApprovalRequestDisplay
} from "../packages/chat-ui/src/approvals/approval-request-model";
import { ApprovalRequestList } from "../packages/chat-ui/src/approvals/approvals-view";
import { parseSkillChangePreview } from "../packages/chat-ui/src/approvals/skill-change-preview";
import {
  createCompletedAssistantWorkIndices,
  createVisibleFinalAssistantPartIndices
} from "../packages/chat-ui/src/assistant/assistant-work-grouping";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  workspaceRouteFromPath,
  workspaceRouteNavigation
} from "../packages/chat-ui/src/standalone-chat-app";
import { workspaceRouteView } from "../packages/chat-ui/src/workspace/workspace-route";

const skillChangePreview = {
  skillName: "payroll",
  skillTitle: "Gehaltsabrechnungen prüfen",
  isNewSkill: false,
  changes: [
    {
      type: "replace",
      target: "root",
      before: "Prüfe den Bruttolohn.",
      after: "Prüfe den Bruttolohn und die Steuerklasse."
    },
    {
      type: "add",
      target: "root",
      sectionHeading: "Sonderfälle",
      after: "Bei Minijobs gilt die Pauschale."
    },
    { type: "new_resource", target: "references/checkliste.md", after: "# Checkliste" }
  ]
};

function request(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: "apr_1",
    clientInstanceId: "client-1",
    kind: "skill_change",
    summary: "Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.",
    payload: {},
    requestedBy: { id: "user-anna", displayLabel: "Anna Beispiel" },
    status: "pending",
    checks: [],
    createdAt: "2026-10-05T08:00:00Z",
    updatedAt: "2026-10-05T08:00:00Z",
    preview: skillChangePreview,
    canDecide: false,
    canWithdraw: false,
    canRevert: false,
    ...overrides
  } as ApprovalRequestView;
}

const idleActions: ApprovalRequestCardActions = {
  pending: false,
  onDecide: () => undefined,
  onWithdraw: () => undefined,
  onRevert: () => undefined
};

function renderCard(
  state: ApprovalRequestCardState,
  actions: ApprovalRequestCardActions = idleActions,
  locale: "de" | "en" = "de"
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale },
      createElement(ApprovalRequestCardView, { state, actions })
    )
  );
}

function renderReady(overrides: Partial<ApprovalRequestView> = {}, actions = idleActions): string {
  return renderCard({ status: "ready", request: request(overrides) }, actions);
}

describe("approval request card", () => {
  it("shows the proposed change read-only to a user who can neither decide nor withdraw", () => {
    const markup = renderReady();

    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
    expect(markup).toContain("Wartet auf Freigabe");
    expect(markup).toContain("Angefragt von Anna Beispiel");
    expect(markup).toContain("Fähigkeit: Gehaltsabrechnungen prüfen");
    expect(markup).not.toContain("<button");
  });

  it("offers the three decisions to an approver", () => {
    const markup = renderReady({ canDecide: true });

    expect(markup).toContain(">Übernehmen</button>");
    expect(markup).toContain(">Änderung anfragen</button>");
    expect(markup).toContain(">Ablehnen</button>");
    expect(markup).not.toContain(">Zurückziehen</button>");
  });

  it("lets the requester withdraw without offering a decision", () => {
    const markup = renderReady({ canWithdraw: true });

    expect(markup).toContain(">Zurückziehen</button>");
    expect(markup).not.toContain(">Übernehmen</button>");
  });

  it("names the decider and the comment once the request is decided", () => {
    const markup = renderReady({
      status: "changes_requested",
      decision: {
        approved: false,
        decidedBy: "user-felix",
        decidedByLabel: "Felix Pahlke",
        decidedAt: "2026-10-05T09:00:00Z",
        comment: "Bitte ohne Kundennamen."
      }
    });

    expect(markup).toContain("Änderung angefragt");
    expect(markup).toContain("Entscheidung von Felix Pahlke");
    expect(markup).toContain("Bitte ohne Kundennamen.");
    expect(markup).not.toContain("<button");
  });

  it("offers rollback only when the view allows it and the client can do it", () => {
    const approved = { status: "approved", canRevert: true } as Partial<ApprovalRequestView>;

    expect(renderReady(approved)).toContain(">Rückgängig machen</button>");
    expect(renderReady(approved, { ...idleActions, onRevert: undefined })).not.toContain(
      "Rückgängig machen"
    );
    expect(renderReady({ status: "approved" })).not.toContain("Rückgängig machen");
  });

  it("gives a rolled back request its own badge and names who undid it", () => {
    const markup = renderReady({
      status: "reverted",
      reversion: {
        revertedBy: "user-felix",
        revertedByLabel: "Felix Pahlke",
        revertedAt: "2026-10-06T09:00:00Z"
      }
    } as Partial<ApprovalRequestView>);

    expect(markup).toContain("Rückgängig gemacht</span>");
    expect(markup).toContain("Rückgängig gemacht von Felix Pahlke");
  });

  it("shows warned and blocked checks and stays silent about passed ones", () => {
    const markup = renderReady({
      checks: [
        { id: "format", status: "passed", message: "Format in Ordnung." },
        { id: "no_customer_data", status: "warned", message: "Enthält möglicherweise einen Namen." }
      ]
    });

    expect(markup).toContain("Enthält möglicherweise einen Namen.");
    expect(markup).not.toContain("Format in Ordnung.");
    expect(renderReady()).not.toContain("<ul");
  });

  it("falls back to the summary for an unknown kind or an unreadable preview", () => {
    const unknownKind = renderReady({ kind: "future_kind" });
    const brokenPreview = renderReady({ preview: { changes: "nope" } });

    for (const markup of [unknownKind, brokenPreview]) {
      expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
      expect(markup).not.toContain("Bisher");
    }
  });

  it("explains a rollback that newer changes made impossible", () => {
    const markup = renderReady(
      { status: "approved", canRevert: true } as Partial<ApprovalRequestView>,
      {
        ...idleActions,
        failure: "revert_conflict"
      }
    );

    expect(markup).toContain("weil es inzwischen neuere Änderungen gibt");
  });

  it("renders loading, not-found and error as states of their own", () => {
    expect(renderCard({ status: "loading" })).toContain("Vorschlag wird geladen…");
    expect(renderCard({ status: "not-found" })).toContain("du darfst ihn nicht sehen");

    const failed = renderCard({ status: "error", onRetry: () => undefined });
    expect(failed).toContain("Der Vorschlag konnte nicht geladen werden.");
    expect(failed).toContain(">Erneut versuchen</button>");
  });

  it("renders matching English copy", () => {
    const markup = renderCard(
      { status: "ready", request: request({ canDecide: true }) },
      idleActions,
      "en"
    );

    expect(markup).toContain("Awaiting approval");
    expect(markup).toContain(">Accept</button>");
    expect(markup).toContain(">Request changes</button>");
  });
});

describe("skill change body", () => {
  it("describes changes in plain language instead of a diff", () => {
    const markup = renderReady();

    expect(markup).toContain("Bisher");
    expect(markup).toContain("Prüfe den Bruttolohn.");
    expect(markup).toContain("Prüfe den Bruttolohn und die Steuerklasse.");
    expect(markup).toContain("Neu hinzugefügt");
    expect(markup).toContain("im Abschnitt „Sonderfälle“");
    expect(markup).toContain("Neue Referenz");
    expect(markup).toContain("references/checkliste.md");
  });

  it("introduces a new skill by title and description with a collapsible body", () => {
    const markup = renderReady({
      preview: {
        skillName: "onboarding",
        skillTitle: "Onboarding",
        isNewSkill: true,
        changes: [],
        newSkill: {
          name: "onboarding",
          title: "Onboarding",
          description: "Neue Mitarbeitende begleiten.",
          content: "Begrüße neue Mitarbeitende."
        }
      }
    });

    expect(markup).toContain("Neue Fähigkeit");
    expect(markup).toContain("Neue Mitarbeitende begleiten.");
    expect(markup).toContain("<details");
    expect(markup).toContain("Inhalt anzeigen");
  });

  it("keeps readable changes and drops malformed ones", () => {
    const preview = parseSkillChangePreview({
      skillName: "payroll",
      skillTitle: "Payroll",
      isNewSkill: false,
      changes: [
        { type: "replace", target: "root", before: "a", after: "b" },
        { type: "rename", target: "root", after: "c" },
        { type: "add", target: "root" }
      ]
    });

    expect(preview?.changes).toEqual([
      { type: "replace", target: "root", before: "a", after: "b" }
    ]);
    expect(parseSkillChangePreview(undefined)).toBeUndefined();
    expect(parseSkillChangePreview({ skillTitle: "Payroll", changes: [] })).toBeUndefined();
  });
});

describe("approval request model", () => {
  it("reads the request reference from an approval display payload only", () => {
    expect(
      readApprovalRequestDisplay({
        kind: "catalyst.approval_request",
        data: { requestId: "apr_1", kind: "skill_change" }
      })
    ).toEqual({ requestId: "apr_1", kind: "skill_change" });
    expect(
      readApprovalRequestDisplay({ kind: "catalyst.approval_request", data: {} })
    ).toBeUndefined();
    expect(
      readApprovalRequestDisplay({ kind: "html.rendered", data: { requestId: "apr_1" } })
    ).toBeUndefined();
  });

  it("lists decided requests for the history, most recently touched first", () => {
    const history = decidedApprovalRequests([
      request({ id: "pending" }),
      request({ id: "older", status: "rejected", updatedAt: "2026-10-01T08:00:00Z" }),
      request({ id: "newer", status: "approved", updatedAt: "2026-10-03T08:00:00Z" })
    ]);

    expect(history.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("detects the rollback operation on the API client", async () => {
    const calls: string[] = [];
    const revert = approvalRequestReverter({
      approvalRequests: {
        revert: async (requestId: string) => {
          calls.push(requestId);
        }
      }
    });

    await revert?.("apr_1");
    expect(calls).toEqual(["apr_1"]);
    expect(approvalRequestReverter({ approvalRequests: {} })).toBeUndefined();
  });
});

describe("approvals view", () => {
  function renderList(input: { loading?: boolean; failed?: boolean; history?: boolean }): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(ApprovalRequestList, {
          requests: [],
          loading: input.loading ?? false,
          failed: input.failed ?? false,
          emptyKey: input.history ? "approvalsEmptyHistory" : "approvalsEmptyPending",
          onRetry: () => undefined
        })
      )
    );
  }

  it("has an empty state for each tab", () => {
    expect(renderList({})).toContain("Nichts wartet auf Freigabe.");
    expect(renderList({ history: true })).toContain("Noch keine Entscheidungen.");
  });

  it("offers a way out when the list is loading or failed", () => {
    expect(renderList({ loading: true })).toContain("Freigaben werden geladen…");
    expect(renderList({ failed: true })).toContain(">Erneut versuchen</button>");
  });

  it("is reachable by its own route, outside the administration", () => {
    expect(workspaceRouteFromPath("/approvals")).toEqual({ kind: "approvals" });
    expect(workspaceRouteNavigation({ kind: "approvals" })).toEqual({ to: "/approvals" });
    expect(workspaceRouteView({ kind: "approvals" })).toBe("approvals");
  });
});

describe("approval request card in the thread", () => {
  const approvalToolCall = {
    type: "tool-call",
    result: {
      display: {
        kind: "catalyst.approval_request",
        version: 1,
        mode: "inline",
        data: { requestId: "apr_1", kind: "skill_change" }
      }
    }
  };

  it("stays visible below the final text instead of folding into the work summary", () => {
    const parts = [
      { type: "tool-call", result: { ok: true } },
      approvalToolCall,
      { type: "text", text: "Ich habe eine Änderung vorgeschlagen." }
    ];

    expect(createCompletedAssistantWorkIndices(parts, 2)).toEqual([0]);
    expect(createVisibleFinalAssistantPartIndices(parts, 2)).toEqual([2, 1]);
  });
});
