// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, type ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { ToolInboxWaitView } from "@work-shape/catalyst-chat-ui/tool-decision-card";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { createTranslationContext, TranslationProvider } from "./support/chat-ui/shared";
import {
  ApprovalRevisionHostProvider,
  filterInboxItems,
  InboxItemPanel,
  inboxFilterOptions,
  inboxPlaces,
  WorkspaceDraftsProvider,
  type ApprovalRevisionHost
} from "./support/chat-ui";
import { appsContext, workflowsContext } from "./chat-ui-build-fixtures";
import {
  approvalActionFailure,
  decision,
  idleActions,
  INBOX_API_BASE_URL,
  InboxAreaView,
  inboxItemKinds,
  inboxItemSurface,
  InboxItemView,
  InboxList,
  inboxListOutdatesItem,
  inboxRailEntry,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  item,
  now,
  orderInboxItems,
  render,
  renderItem,
  type InboxCounts,
  type InboxItemKind,
  type InboxTab
} from "./chat-ui-inbox-harness";

const kindOf = (kind: string) => inboxItemKinds.find((entry) => entry.kind === kind);
const decisions = (markup: string) =>
  [...markup.matchAll(/data-decision="([a-z_]+)"/gu)].map((match) => match[1]);
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/gu)].map((m) => m[1]);

/** The Inbox's host as one person reads it. */
const host = (currentUserId: string): ApprovalRevisionHost => ({
  currentUserId,
  personalWorkspaceAgentName: () => undefined,
  startRevision: () => undefined,
  agentDisplayName: () => undefined,
  openConversation: () => undefined
});

describe("inbox model", () => {
  const reviewer: InboxCounts = {
    count: 2,
    canReview: true,
    decided: 3,
    mine: { pending: 1, total: 4 }
  };
  const member: InboxCounts = {
    count: 0,
    canReview: false,
    decided: 0,
    mine: { pending: 1, total: 1 }
  };

  it("gives a reviewer three lists and everyone else their own requests alone", () => {
    expect(inboxTabs(true)).toEqual(["to_decide", "mine", "decided"]);
    expect(inboxTabs(false)).toEqual(["mine"]);
  });

  it("puts the Inbox in the rail for a reviewer and for a person who has asked", () => {
    expect(inboxRailEntry(reviewer)).toEqual({ toDecide: 2 });
    expect(inboxRailEntry(member)).toEqual({ toDecide: 0 });
    expect(inboxRailEntry({ ...member, mine: { pending: 0, total: 0 } })).toBeUndefined();
    expect(inboxRailEntry(undefined)).toBeUndefined();
  });

  it("counts what waits in the first two lists, and nothing in the decided one", () => {
    expect(inboxTabCount("to_decide", reviewer)).toEqual({ count: 2, tone: "primary" });
    expect(inboxTabCount("mine", reviewer)).toEqual({ count: 1, tone: "muted" });
    expect(inboxTabCount("decided", reviewer)).toBeUndefined();
    expect(inboxTabCount("to_decide", { ...reviewer, count: 0 })).toBeUndefined();
    expect(inboxTabCount("mine", undefined)).toBeUndefined();
  });

  it("finds the list that holds an item opened by its address", () => {
    const viewer = { userId: "user-felix", canReview: true };
    expect(inboxTabOfItem(item({ canDecide: true }), viewer)).toBe("to_decide");
    expect(inboxTabOfItem(item({ status: "approved" }), viewer)).toBe("decided");
    expect(inboxTabOfItem(item(), { ...viewer, userId: "user-anna" })).toBe("mine");
    expect(
      inboxTabOfItem(item({ canDecide: true }), { userId: "user-anna", canReview: false })
    ).toBe("mine");
  });

  it("orders what waits oldest first, own requests pending first, decided by decision", () => {
    const rows = [
      item({ id: "b", createdAt: "2026-10-02T08:00:00Z", updatedAt: "2026-10-04T08:00:00Z" }),
      item({
        id: "a",
        status: "approved",
        createdAt: "2026-10-03T08:00:00Z",
        updatedAt: "2026-10-03T09:00:00Z"
      }),
      item({ id: "c", createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-05T08:00:00Z" })
    ];
    const ids = (tab: InboxTab) => orderInboxItems(tab, rows).map((row) => row.id);
    expect(ids("to_decide")).toEqual(["c", "b", "a"]);
    expect(ids("mine")).toEqual(["b", "c", "a"]);
    expect(ids("decided")).toEqual(["c", "b", "a"]);
    expect(rows.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  // Fails without the check: nothing asked for the open item again when a list brought news.
  it("has the open item asked for again when a list shows it in another state or lost it", () => {
    const open = item({ canDecide: true });
    const row = item();
    expect(inboxListOutdatesItem("to_decide", [row], open)).toBe(false);
    expect(inboxListOutdatesItem("to_decide", [{ ...row, status: "rejected" }], open)).toBe(true);
    expect(
      inboxListOutdatesItem("mine", [{ ...row, updatedAt: "2026-10-05T09:00:00Z" }], open)
    ).toBe(true);
    expect(inboxListOutdatesItem("to_decide", [], open)).toBe(true);
    expect(inboxListOutdatesItem("decided", [], open)).toBe(false);
    expect(inboxListOutdatesItem("to_decide", [], item({ status: "rejected" }))).toBe(false);
  });

  // Fails without the mapping: a decision that lost the race said nothing.
  it("tells a refused decision on a decided request apart from a failure", () => {
    const conflict = new ApiError(409, "Conflict", { code: "CONFLICT" });
    const broken = new ApiError(500, "Internal", {});
    const none = { decide: null, withdraw: null, revert: null };
    expect(approvalActionFailure(none)).toBeUndefined();
    expect(approvalActionFailure({ ...none, decide: conflict })).toBe("already_decided");
    expect(approvalActionFailure({ ...none, decide: broken })).toBe("failed");
    expect(approvalActionFailure({ ...none, withdraw: conflict })).toBeUndefined();
    expect(approvalActionFailure({ ...none, withdraw: broken })).toBe("failed");
    expect(approvalActionFailure({ ...none, revert: conflict })).toBe("revert_conflict");
  });

  // ACCEPT-2d C-9: the German kind said "Fähigkeit" where body and Studio say "Skill".
  it("names the surface of an item by its kind and what it concerns", () => {
    const { t } = createTranslationContext("de");
    expect(inboxItemSurface("apr_1", item(), kindOf, t)).toEqual({
      kind: "inbox_item",
      key: "inbox-item:apr_1",
      title: "Skill-Änderung",
      subtitle: "Skill: Gehaltsabrechnungen prüfen",
      itemId: "apr_1"
    });
    expect(inboxItemSurface("apr_1", item({ kind: "future_kind" }), kindOf, t).title).toBe(
      "Anfrage"
    );
  });
});

describe("inbox list", () => {
  function renderList(
    tab: InboxTab,
    items: readonly ApprovalRequestView[] | "error",
    selectedItemId?: string
  ): string {
    return render(
      createElement(InboxList, {
        tab,
        state:
          items === "error"
            ? { status: "error", onRetry: () => undefined }
            : { status: "ready", items },
        selectedItemId,
        now,
        agentDisplayName: (agentName) => (agentName === "payroll-agent" ? "Lohnbüro" : undefined),
        onOpenItem: () => undefined
      })
    );
  }
  const save = (id: string, actorId: string, label: string, createdAt = "2026-10-05T08:00:00Z") =>
    item({
      id,
      kind: "operation_call",
      requestedBy: { id: actorId, displayLabel: label },
      createdAt,
      updatedAt: createdAt,
      preview: {
        runId: `opr_${id}`,
        operation: "assets.put",
        effect: "changing",
        actor: { kind: "user", id: actorId, label },
        origin: { kind: "user" },
        inputs: [],
        asset: { kind: "skill", name: "leave", title: "Urlaubsrichtlinie", isNew: false }
      }
    });

  // ACCEPT-2d C-9: two pending changes of one skill carried the same heading.
  it("tells two requests for the same skill apart by who asked", () => {
    const rows = renderList("to_decide", [
      save("apr_e", "user-elif", "Elif Aydin"),
      save("apr_m", "user-mara", "Mara Lindqvist")
    ]);
    const titles = [...rows.matchAll(/title="([^"]*Urlaubsrichtlinie)"/gu)].map((m) => m[1]);
    expect(titles).toEqual([
      "Skill-Änderung von Elif Aydin: Urlaubsrichtlinie",
      "Skill-Änderung von Mara Lindqvist: Urlaubsrichtlinie"
    ]);
  });

  // ACCEPT-2e C-5: two requests by one person for one skill read alike; only the age differed.
  it("tells two requests alike in title and requester apart by when each was asked", () => {
    const rows = renderList("to_decide", [
      save("apr_seeded", "user-elif", "Elif Aydin", "2026-10-04T12:00:00Z"),
      save("apr_mine", "user-elif", "Elif Aydin", "2026-10-05T10:30:00Z"),
      save("apr_mara", "user-mara", "Mara Lindqvist", "2026-10-03T12:00:00Z")
    ]);
    const rowOf = (id: string) =>
      rows.slice(rows.indexOf(`data-item-id="${id}"`)).split("</button>")[0] ?? "";
    expect(rowOf("apr_seeded")).toContain("04.10.2026");
    expect(rowOf("apr_mine")).toContain("05.10.2026");
    expect(rowOf("apr_mara")).not.toContain("03.10.2026");
  });

  it("names the agent by its display name, marks the open item and decides nothing from the row", () => {
    const markup = renderList("to_decide", [item({ canDecide: true })], "apr_1");
    expect(markup).toContain("Anna Beispiel über Lohnbüro");
    expect(markup).toMatch(/<button[^>]*aria-current="true"/u);
    expect(markup.match(/<button/gu)).toHaveLength(1);
  });

  it("lists an item of a kind the client does not know, by its summary", () => {
    const markup = renderList("to_decide", [item({ kind: "future_kind", origin: undefined })]);
    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
  });
});

describe("inbox item", () => {
  it("offers nothing to a reader who can do nothing", () => {
    const markup = renderItem();
    expect(markup).toContain("Prüfe den Bruttolohn und die Steuerklasse.");
    expect(markup).not.toContain("inbox-item-foot");
    expect(markup).not.toContain("<button");
  });

  it("offers a person who can decide a comment and the three decisions, below the proposal", () => {
    const markup = renderItem({ canDecide: true, canWithdraw: true });
    // Fix #305: the foot sits flush on the surface's lower edge.
    expect(markup).toContain("sticky -bottom-4 -mx-4 -mb-4");
    expect(markup).toContain("<textarea");
    expect(decisions(markup)).toEqual(["reject", "request_changes", "approve"]);
    // A requester who may decide rejects; a second button with the same effect is left out.
    expect(markup).not.toContain("Zurückziehen");
    expect(markup.indexOf("Prüfe den Bruttolohn")).toBeLessThan(markup.indexOf("data-decision"));
  });

  it("offers the requester who cannot decide withdraw alone", () => {
    const markup = renderItem({ canWithdraw: true });
    expect(markup).toContain(">Zurückziehen</button>");
    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).not.toContain("<textarea");
  });

  it("shows who decided and who undid it, and offers undo only when the server allows it", () => {
    const markup = renderItem({
      status: "reverted",
      decision: { ...decision, approved: true },
      reversion: {
        revertedBy: "user-felix",
        revertedByLabel: "Felix Pahlke",
        revertedAt: "2026-10-06T09:00:00Z"
      }
    });
    expect(markup).toContain("Bitte ohne Kundennamen.");
    expect(markup).toContain("Rückgängig gemacht von Felix Pahlke");
    expect(markup).not.toContain("<button");
    expect(renderItem({ status: "approved", canRevert: true })).toContain(
      ">Rückgängig machen</button>"
    );
    expect(renderItem({ status: "approved" })).not.toContain("Rückgängig machen");
    expect(
      renderItem(
        { status: "approved", canRevert: true },
        { actions: { ...idleActions, failure: "revert_conflict" } }
      )
    ).toContain("weil es inzwischen neuere Änderungen gibt");
  });

  // Fails without the sentence: the item turned to "Rejected" under an Accept click, unexplained.
  it("says who decided when a decision came too late", () => {
    const refused = { actions: { ...idleActions, failure: "already_decided" as const } };
    const decided = renderItem({ status: "rejected", decision }, refused);
    expect(decided).toContain("Felix Pahlke hat diese Anfrage bereits entschieden.");
    expect(decided).not.toContain("data-decision");
    expect(renderItem({ status: "withdrawn" }, refused)).toContain(
      "Diese Anfrage ist nicht mehr offen."
    );
  });

  it("shows warned and blocked checks and stays silent about passed ones", () => {
    const markup = renderItem({
      checks: [
        { id: "format", status: "passed", message: "Format in Ordnung." },
        {
          id: "no_customer_data",
          status: "warned",
          message: "Enthält möglicherweise einen Namen."
        },
        { id: "size", status: "blocked", message: "" }
      ]
    });
    expect(markup).toContain("Enthält möglicherweise einen Namen.");
    expect(markup).not.toContain("Format in Ordnung.");
    expect(markup.match(/role="note"/gu)).toHaveLength(2);
  });

  it("opens an item of an unknown kind with no way to decide it, but lets its requester withdraw", () => {
    const markup = renderItem({
      kind: "future_kind",
      canDecide: true,
      canRevert: true,
      canWithdraw: false
    });
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<textarea");
    expect(renderItem({ kind: "future_kind", canWithdraw: true })).toContain(
      ">Zurückziehen</button>"
    );
  });

  it("renders a planted kind through the same frame, with its body and its own decisions", () => {
    const [platformKind] = inboxItemKinds;
    if (!platformKind) throw new Error("The platform registers no item kind.");
    const expenseKind: InboxItemKind = {
      kind: "expense_claim",
      label: "nav.inbox",
      icon: platformKind.icon,
      subject: () => "Reise nach Hamburg",
      Body: ({ item: claim }) =>
        createElement("p", { "data-testid": "expense-body" }, claim.summary),
      decisions: [
        { decision: "reject", label: "approvalWithdraw" },
        { decision: "approve", label: "approvalRevert" }
      ]
    };
    const markup = renderItem(
      { kind: "expense_claim", canDecide: true, preview: { amount: 120 } },
      { kinds: [...inboxItemKinds, expenseKind] }
    );
    expect(markup).toContain('data-testid="expense-body"');
    expect(decisions(markup)).toEqual(["reject", "approve"]);
    expect(renderItem({ kind: "expense_claim", canDecide: true })).not.toContain("<button");
  });

  // ACCEPT-FIX-9 C13: the refusal named nobody; it names the instance admin where it is told one.
  it("renders loading, not-found and failure as states of their own", () => {
    const state = (value: Parameters<typeof InboxItemView>[0]["state"]) =>
      render(createElement(InboxItemView, { state: value, actions: idleActions }));
    expect(state({ status: "loading" })).toContain('aria-busy="true"');
    expect(state({ status: "not-found" })).toContain("du darfst ihn nicht sehen");
    const named = render(
      createElement(
        ApprovalRevisionHostProvider,
        { value: { ...host("user-sven"), instanceAdminName: "Mara Lindqvist" } },
        createElement(InboxItemView, { state: { status: "not-found" }, actions: idleActions })
      )
    );
    expect(named).toContain("Mara Lindqvist");
    expect(state({ status: "error", onRetry: () => undefined })).toContain(
      ">Erneut versuchen</button>"
    );
  });
});

describe("inbox area", () => {
  function renderArea(
    counts: InboxCounts,
    tab: InboxTab,
    items: readonly ApprovalRequestView[],
    extra: Partial<Parameters<typeof InboxAreaView>[0]> = {}
  ): string {
    return render(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(InboxAreaView, {
          tabs: inboxTabs(counts.canReview),
          tab,
          counts,
          state: { status: "ready", items },
          now,
          filter: {},
          onFilterChange: () => undefined,
          ...extra,
          onTabChange: () => undefined,
          onOpenItem: () => undefined,
          onCloseItem: () => undefined
        })
      ),
      "en"
    );
  }

  it("offers the requests others can approve themselves in To decide, off by default", () => {
    const counts = {
      count: 0,
      canReview: true,
      decided: 0,
      othersOwn: 2,
      mine: { pending: 0, total: 0 }
    };
    const extra = { onOthersOwnChange: () => undefined };
    const offered = renderArea(counts, "to_decide", [], extra);
    expect(offered).toContain('data-testid="inbox-others-own"');
    expect(offered).toMatch(
      /role="switch" aria-checked="false"|aria-checked="false"[^>]*role="switch"/u
    );
    expect(renderArea({ ...counts, othersOwn: 0 }, "to_decide", [], extra)).not.toContain(
      'data-testid="inbox-others-own"'
    );
    expect(renderArea(counts, "decided", [], extra)).not.toContain(
      'data-testid="inbox-others-own"'
    );
  });

  // DAILY-WINS 5: the lists filter by kind and workspace.
  describe("filters", () => {
    const counts: InboxCounts = {
      count: 3,
      canReview: true,
      decided: 0,
      mine: { pending: 0, total: 0 }
    };
    const heldIn = (id: string, workspaceId: string, kind = "app_publish") =>
      item({
        id,
        kind,
        canDecide: true,
        preview: {
          runId: `opr_${id}`,
          operation: "app.action",
          effect: "changing",
          actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
          origin: { kind: "user" },
          workspaceId,
          inputs: []
        }
      });
    const names: Record<string, string> = { cw_1: "Vertrieb", cw_2: "Einkauf" };
    const workspace = (id: string) => (names[id] ? { name: names[id], emoji: null } : undefined);
    const items = [heldIn("a", "cw_1"), heldIn("b", "cw_2"), item({ id: "c", canDecide: true })];
    const rows = (markup: string) => markup.match(/data-testid="inbox-row"/gu)?.length ?? 0;

    it("offers kind and workspace where the list mixes them, and shows only what matches", () => {
      const all = renderArea(counts, "to_decide", items, { workspace });
      expect(all).toContain('aria-label="Filter by kind"');
      expect(all).toContain('<option value="cw_2">Einkauf</option>');
      expect(rows(all)).toBe(3);

      const inEinkauf = renderArea(counts, "to_decide", items, {
        workspace,
        filter: { workspaceId: "cw_2" }
      });
      expect(rows(inEinkauf)).toBe(1);
      expect(inEinkauf).toContain('data-item-id="b"');
      const skills = renderArea(counts, "mine", items, {
        workspace,
        filter: { kind: "skill_change" }
      });
      expect(rows(skills)).toBe(1);
      expect(skills).toContain('data-item-id="c"');
      const none = renderArea(counts, "decided", items, {
        workspace,
        filter: { kind: "skill_change", workspaceId: "cw_1" }
      });
      expect(rows(none)).toBe(0);
      // The filter stays in reach to be undone.
      expect(none).toContain('data-testid="inbox-filters"');
    });

    it("offers no filter where there is nothing to choose, and no workspace the reader lacks", () => {
      const one = renderArea(
        counts,
        "to_decide",
        [heldIn("a", "cw_1"), item({ id: "c", kind: "app_publish", canDecide: true })],
        { workspace }
      );
      expect(one).toContain('aria-label="Filter by workspace"');
      expect(one).not.toContain('aria-label="Filter by kind"');
      expect(
        renderArea(counts, "to_decide", [item({ id: "c", canDecide: true })], { workspace })
      ).not.toContain('data-testid="inbox-filters"');
      expect(
        renderArea(counts, "to_decide", [heldIn("a", "cw_9"), heldIn("b", "cw_9")], { workspace })
      ).not.toContain('data-testid="inbox-filters"');
    });
  });
});

describe("inbox item of an operation call", () => {
  const callPreview = {
    runId: "opr_1",
    operation: "workspace.apply_patch",
    effect: "changing",
    actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
    origin: { kind: "agent", agentName: "payroll-agent", toolName: "workspace_apply_patch" },
    workspaceId: "cw_team",
    inputs: [
      { key: "path", value: "docs/plan.md" },
      { key: "patch", value: "+ Neue Zeile", truncated: true }
    ],
    expiresAt: "2026-10-12T08:00:00Z"
  };
  const call = (overrides: Partial<ApprovalRequestView> = {}, locale: "de" | "en" = "en") =>
    renderItem(
      {
        kind: "operation_call",
        summary: "workspace.apply_patch",
        preview: callPreview,
        canDecide: true,
        ...overrides
      },
      { locale }
    );

  it("shows the operation and each input, folds the origin away, and offers approve and decline", () => {
    const markup = call();
    expect(markup).toMatch(/data-field="operation".*workspace\.apply_patch/u);
    expect(markup).toMatch(/data-input-key="patch" data-truncated="true"/u);
    expect(markup.match(/data-input-key=/gu)).toHaveLength(2);
    expect(markup).not.toContain('data-field="origin"');
    expect(markup).not.toContain('data-testid="operation-call-full-input"');
    expect(markup).not.toContain('data-testid="operation-call-why"');
    expect(decisions(markup)).toEqual(["reject", "approve"]);
  });

  // Fails before the fix: the preview ended at 50 fields without a word and no way to the rest.
  it("says what the rows leave out and opens the fold with the full input", () => {
    const payload = { runId: "opr_1", input: { path: "docs/plan.md", patch: "xxxtail" } };
    const markup = call({ payload, preview: { ...callPreview, inputFieldCount: 61 } });
    expect(markup).toContain('data-testid="operation-call-hidden-fields"');
    expect(markup).toContain('data-field="origin"');
    expect(markup).toMatch(/data-testid="operation-call-full-input"[\s\S]*xxxtail/u);
    const whole = call({ payload });
    expect(whole).not.toContain('data-testid="operation-call-hidden-fields"');
    expect(whole).not.toContain('data-testid="operation-call-full-input"');
  });

  // Fails before the fix: a decided item read "Übernommen" whatever became of the call.
  it("says what became of the call once the request is decided, and that its input is gone", () => {
    const ended = (status: ApprovalRequestView["status"], applyResult: Record<string, unknown>) =>
      call({
        status,
        canDecide: false,
        applyResult,
        payload: { runId: "opr_1", inputRemoved: true },
        preview: { ...callPreview, inputs: [], inputFieldCount: 0, inputRemoved: true }
      });
    for (const [status, execution] of [
      ["approved", "queued"],
      ["approved", "done"],
      ["approved", "failed"],
      ["approved", "interrupted"],
      ["superseded", "refused"],
      ["superseded", "expired"]
    ] as const) {
      const markup = ended(status, { execution });
      expect(markup).toContain(`data-outcome="${execution}"`);
      expect(markup).not.toContain('data-testid="operation-call-headline"');
      expect(markup).not.toContain("data-decision");
      expect(markup).toContain('data-testid="operation-call-input-removed"');
    }
    expect(
      ended("approved", { execution: "failed", error: { message: "Revision 2 erwartet." } })
    ).toContain("Revision 2 erwartet.");
  });

  it("shows a sentence instead of half a call when the preview cannot be read", () => {
    for (const preview of [
      undefined,
      { operation: "assets.put" },
      { ...callPreview, origin: { kind: "carrier_pigeon" } },
      { ...callPreview, actor: { kind: "user" } },
      { ...callPreview, effect: "deleting" }
    ]) {
      const markup = call({ preview });
      expect(markup).toContain('data-testid="operation-call-unreadable"');
      expect(markup).not.toContain('data-testid="operation-call"');
    }
    const partial = call({
      preview: {
        ...callPreview,
        inputs: [{ key: "path", value: "a.md" }, { key: "n", value: 3 }, 7]
      }
    });
    expect(partial.match(/data-input-key=/gu)).toHaveLength(1);
  });

  // Fails without the fix round: a call held by an operation's floor gave no reason at all.
  it("gives a reason only where the request says a rule of the instance held it", () => {
    expect(call({ preview: { ...callPreview, heldBy: "policy_floor" } })).toContain(
      'data-testid="operation-call-why"'
    );
    for (const heldBy of [undefined, "guardrail"]) {
      expect(call({ preview: { ...callPreview, heldBy } })).not.toContain(
        'data-testid="operation-call-why"'
      );
    }
  });

  // INBOX-CARD-1: a held save of a skill reads as that skill.
  const skillText = "# Elternzeit\n\n- Sieben Wochen vor Beginn anmelden.\n";
  const putPreview = {
    runId: "opr_2",
    operation: "assets.put",
    effect: "changing",
    actor: { kind: "user", id: "user-elif", label: "Elif Aydin" },
    origin: { kind: "user" },
    heldBy: "central_setting",
    inputs: [
      { key: "kind", value: "skill" },
      { key: "config.content", value: skillText }
    ],
    expiresAt: "2026-10-12T08:00:00Z"
  };
  const newSkill = {
    kind: "skill",
    name: "hr-parental-leave-faq",
    title: "Elternzeit: häufige Fragen",
    description: "Nutzen bei Fragen zur Elternzeit.",
    isNew: true,
    content: {
      skillName: "hr-parental-leave-faq",
      skillTitle: "Elternzeit: häufige Fragen",
      isNewSkill: true,
      changes: [],
      newSkill: {
        name: "hr-parental-leave-faq",
        title: "Elternzeit: häufige Fragen",
        description: "Nutzen bei Fragen zur Elternzeit.",
        content: skillText
      }
    }
  };
  const changedSkill = {
    kind: "skill",
    name: "hr-leave-policy",
    title: "Urlaubsrichtlinie",
    description: "Nutzen bei Fragen zu Urlaub.",
    isNew: false,
    previous: { title: "Urlaub" },
    removedResources: ["old/table.md"],
    content: {
      skillName: "hr-leave-policy",
      skillTitle: "Urlaubsrichtlinie",
      isNewSkill: false,
      changes: [
        {
          type: "replace",
          target: "root",
          before: "Krankmeldung ab dem dritten Tag.",
          after: "Krankmeldung ab dem ersten Tag."
        }
      ]
    }
  };
  const put = (
    asset: Record<string, unknown>,
    locale: "de" | "en" = "en",
    preview: Record<string, unknown> = putPreview
  ) => call({ summary: "assets.put", preview: { ...preview, asset } }, locale);
  const row = (preview: ApprovalRequestView["preview"]) =>
    render(
      createElement(InboxList, {
        tab: "to_decide",
        state: {
          status: "ready",
          items: [
            item({
              kind: "operation_call",
              summary: "assets.put",
              origin: undefined,
              requestedBy: { id: "user-elif", displayLabel: "Elif Aydin" },
              preview
            })
          ]
        },
        now,
        onOpenItem: () => undefined
      }),
      "en"
    );

  // ACCEPT-FIX-9 C13: the skill is named by its title, not by its id.
  it("names a new skill by its title, shows its text, and folds the operation away", () => {
    const markup = put(newSkill);
    expect(markup).toContain("Elternzeit: häufige Fragen");
    expect(markup).not.toContain("hr-parental-leave-faq<");
    expect(markup).toContain('data-testid="operation-call-why"');
    expect(markup).toContain("- Sieben Wochen vor Beginn anmelden.");
    expect(markup).not.toContain('data-testid="operation-call-inputs"');
    expect(markup).not.toContain("assets.put");
    const { content: _content, ...listed } = newSkill;
    const listedRow = row({ ...putPreview, asset: listed });
    expect(listedRow).toContain("Elternzeit: häufige Fragen");
    expect(listedRow).not.toContain("hr-");
    expect(listedRow).not.toContain("assets.put");
  });

  // Hosted check 39180143605: a reader who may not read the asset was shown the call's raw
  // input with the proposed text.
  it("shows a reader who may not read the asset its title, and nothing the call writes", () => {
    const proposed = "Krankmeldung ab dem ersten Tag.";
    for (const kind of ["skill", "agent"]) {
      for (const locale of ["en", "de"] as const) {
        const markup = call(
          {
            summary: "assets.put",
            preview: {
              ...putPreview,
              inputs: [{ key: "config.content", value: proposed }],
              inputFieldCount: 4,
              asset: {
                kind,
                name: "hr-leave-policy",
                title: "Urlaubsrichtlinie",
                beforeWithheld: true
              }
            },
            payload: { runId: "opr_2", input: { config: { content: proposed } } }
          },
          locale
        );
        expect(markup).toContain("Urlaubsrichtlinie");
        expect(markup).toContain('data-testid="operation-call-no-before"');
        expect(markup).not.toContain(proposed);
        expect(markup).not.toContain("config.content");
        expect(markup).not.toContain('data-testid="operation-call-skill"');
        expect(markup).not.toContain('data-testid="operation-call-full-input"');
      }
    }
  });

  it("claims no new skill or change where a frozen preview says neither", () => {
    const markup = put({ kind: "skill", name: "hr-leave-policy", title: "Urlaubsrichtlinie" });
    expect(markup).toContain("Urlaubsrichtlinie");
    expect(markup).not.toContain("wants to create");
    expect(markup).not.toContain("wants to change");
    expect(
      put({ kind: "skill", name: "hr-leave-policy", title: "Urlaubsrichtlinie", isNew: "yes" })
    ).not.toContain("Urlaubsrichtlinie");
  });

  // ACCEPT-FIX-9 E4: once decided, the item lost the skill and read "assets.put".
  it("keeps the skill's title and what changed once the request is decided", () => {
    for (const canDecide of [true, false]) {
      const markup = call({
        summary: "assets.put",
        status: "approved",
        canDecide,
        applyResult: { execution: "done" },
        payload: { runId: "opr_1", inputRemoved: true },
        preview: {
          ...putPreview,
          inputs: [],
          inputFieldCount: 0,
          inputRemoved: true,
          asset: changedSkill
        }
      });
      expect(markup).toContain("Urlaubsrichtlinie");
      expect(markup).toMatch(/New<\/span>.*Krankmeldung ab dem ersten Tag\./u);
      expect(markup).not.toContain('data-testid="operation-call-input-removed"');
      expect(markup).not.toContain("assets.put");
    }
  });

  // ACCEPT-2e: once an outdated request was declined, its decided view went back to "Bisher/Neu".
  it("keeps the comparison labels of an outdated request after it is declined", () => {
    const markup = call({
      summary: "assets.put",
      status: "rejected",
      canDecide: false,
      payload: { runId: "opr_1", inputRemoved: true },
      preview: {
        ...putPreview,
        inputs: [],
        inputFieldCount: 0,
        inputRemoved: true,
        asset: { ...changedSkill, isStale: true }
      }
    });
    expect(markup).toMatch(/Version Elif Aydin saw<\/span>.*Krankmeldung ab dem dritten Tag\./u);
    expect(markup).not.toMatch(/>Before<\/span>/u);
  });

  // ACCEPT-FIX-9 E7 / ACCEPT-2d C-2 / LOWS-D: an outdated request offered Approve, although
  // approving applies nothing, and the requester was told to ask themselves.
  it("offers only Decline on a stale save, and speaks to the requester as the one to resubmit", () => {
    for (const kind of ["skill", "agent", "app"]) {
      const markup = put({ ...changedSkill, kind, isStale: true });
      expect(markup).toContain('data-testid="operation-call-stale"');
      expect(decisions(markup)).toEqual(["reject"]);
    }
    expect(put(changedSkill)).not.toContain('data-testid="operation-call-stale"');
    const own = render(
      createElement(
        ApprovalRevisionHostProvider,
        { value: host("user-elif") },
        createElement(InboxItemView, {
          state: {
            status: "ready",
            request: item({
              kind: "operation_call",
              summary: "assets.put",
              preview: { ...putPreview, asset: { ...changedSkill, isStale: true } }
            })
          },
          actions: idleActions
        })
      ),
      "en"
    );
    expect(own).toContain("Your request is out of date");
    expect(own).not.toContain("Elif Aydin can submit");
  });

  // ACCEPT-FIX-9 E7: approving an outdated request ended with the instance's English sentence,
  // also in German, and told the approver to submit a new change.
  it("says in the reader's language and role that an outdated approved request applied nothing", () => {
    const read = (locale: "de" | "en", reader: string) =>
      render(
        createElement(
          ApprovalRevisionHostProvider,
          { value: host(reader) },
          createElement(InboxItemView, {
            state: {
              status: "ready",
              request: item({
                kind: "operation_call",
                summary: "assets.put",
                status: "superseded",
                canDecide: false,
                applyResult: {
                  execution: "refused",
                  error: {
                    code: "APPROVAL_STALE",
                    message:
                      "The asset changed after this request was made. Submit a new change; nothing was applied."
                  }
                },
                payload: { runId: "opr_2", inputRemoved: true },
                preview: { ...putPreview, inputs: [], inputRemoved: true, asset: changedSkill }
              })
            },
            actions: idleActions
          })
        ),
        locale
      );
    const approver = read("de", "user-jonas");
    expect(approver).toContain("Elif Aydin kann eine neue Änderung einreichen.");
    expect(approver).not.toContain("Reiche eine neue Änderung ein");
    expect(approver).not.toContain("The asset changed");
    expect(read("de", "user-elif")).toContain("Reiche eine neue Änderung ein");
  });
});

describe("inbox items of further kinds", () => {
  // NL-10: a waiting Workflow step leads to its run and is approved or declined, never edited.
  it("leads a workflow step to its run, with two answers until it is decided", () => {
    const step = {
      kind: "workflow_step",
      summary: "Freigabe Mandantenmail",
      origin: undefined,
      requestedBy: { id: "sp_onboarding", displayLabel: "Mandantenaufnahme" },
      canDecide: true,
      preview: {
        workspaceId: "cws_team",
        workflow: { id: "onboarding", title: "Mandantenaufnahme" },
        runId: "wfr_1",
        step: { key: "check", title: "Vorcheck freigeben" },
        instruction: "Prüfe den Vorcheck.",
        inputs: [{ key: "rechtsform", value: "GmbH" }]
      }
    };
    const markup = renderItem(step);
    expect(markup).toContain("GmbH");
    expect(hrefs(markup)).toContain("/w/cws_team/workflows/onboarding/runs/wfr_1");
    expect(decisions(markup)).toEqual(["reject", "approve"]);
    expect(renderItem({ ...step, status: "approved", canDecide: false })).not.toContain(
      "data-decision="
    );
  });

  // REC-2: the notice of a Data Store whose records wait in review leads there, names no value.
  it("leads a Data Store review to the store and marks it handled", () => {
    const markup = renderItem({
      kind: "data_store_review",
      summary: "Fields of the Data Store 'findings' wait for review",
      origin: undefined,
      requestedBy: { id: "system", displayLabel: "System" },
      canDecide: true,
      preview: { store: "findings", title: "Objektdaten", flagged: 3 }
    });
    expect(hrefs(markup)).toContain("/build/data-stores/findings");
    expect(decisions(markup)).toEqual(["approve"]);
    expect(markup).not.toContain("<textarea");
  });

  // LU-4 / LU-6: feedback names what it is about, leads there, and is only marked handled.
  describe("feedback", () => {
    const feedback = (
      agent: string,
      preview: Record<string, unknown> = {}
    ): Partial<ApprovalRequestView> => ({
      id: `apr_${agent}`,
      kind: "feedback_review",
      summary: `Feedback on the agent '${agent}'`,
      origin: undefined,
      requestedBy: { id: "user-kai", displayLabel: "Kai" },
      canDecide: true,
      preview: {
        feedbackId: `fb_${agent}`,
        agent: { name: agent, displayName: `${agent} display`, revision: 4 },
        text: "The answer forgot the land register extract.",
        gone: false,
        ...preview
      }
    });

    it("leads to the agent, the App or the Workflow run it is about, with one answer", () => {
      const agent = renderItem(
        feedback("loans", { exchange: { question: "Which documents?", answer: "The payslips." } })
      );
      expect(agent).toContain("The answer forgot the land register extract.");
      expect(hrefs(agent)).toContain("/build/agents/loans");
      expect(decisions(agent)).toEqual(["approve"]);

      const app = renderItem({
        ...feedback("offers"),
        preview: {
          feedbackId: "fb_app",
          subjectKind: "app",
          about: {
            kind: "app",
            name: "offers",
            displayName: "Offers",
            revision: 2,
            workspaceId: "cws_team"
          },
          text: "The total leaves out the open offers.",
          gone: false
        }
      });
      expect(hrefs(app)).toContain("/w/cws_team/apps/offers");

      const runPreview = {
        feedbackId: "fb_run",
        subjectKind: "workflow_run",
        about: { kind: "workflow", name: "monthly-check", displayName: "Monatscheck" },
        workflowRunId: "wfr_1",
        workspaceId: "cws_team",
        text: "Der Kontoauszug war doch da.",
        gone: false
      };
      const run = renderItem({ ...feedback("monthly"), preview: runPreview });
      expect(hrefs(run)).toContain("/w/cws_team/workflows/monthly-check/runs/wfr_1");
      expect(
        kindOf("feedback_review")?.agentOf?.(item({ ...feedback("monthly"), preview: runPreview }))
      ).toBeUndefined();
    });

    it("is filtered by agent", () => {
      const agentOf = (entry: ApprovalRequestView) => kindOf("feedback_review")?.agentOf?.(entry);
      const items = [item(feedback("loans")), item(feedback("leases")), item()];
      expect(inboxFilterOptions(items, {}, () => undefined, agentOf).agents).toEqual([
        { name: "loans", label: "loans display" },
        { name: "leases", label: "leases display" }
      ]);
      expect(
        filterInboxItems(items, { agentName: "loans" }, () => undefined, agentOf).map(
          (entry) => entry.id
        )
      ).toEqual(["apr_loans"]);
    });
  });

  // NOTIFY-a: a notice leads to what it names and asks for nothing but "mark handled".
  describe("notice", () => {
    const notice = (preview: ApprovalRequestView["preview"]) => ({
      kind: "notice",
      summary: "Buchhaltungscheck 2026-09",
      origin: undefined,
      requestedBy: { id: "sp_monthly", displayLabel: "Monatscheck" },
      addresseeUserId: "user-ada",
      canDecide: true,
      preview
    });
    const appNotice = {
      title: "Buchhaltungscheck 2026-09",
      text: "12 Auffälligkeiten in 3 Mandanten.",
      link: { kind: "app", workspaceId: "cws_team", app: "findings" }
    };
    const runLink = {
      kind: "workflow_run",
      workspaceId: "cws_team",
      workflowId: "wf_1",
      runId: "wfr_1"
    };

    it("leads to the App, the run or the shared chat it names, with one answer", () => {
      const app = renderItem(notice(appNotice));
      expect(app).toContain("12 Auffälligkeiten in 3 Mandanten.");
      expect(hrefs(app)).toContain("/w/cws_team/apps/findings");
      expect(decisions(app)).toEqual(["approve"]);
      expect(app).not.toContain("<textarea");
      expect(hrefs(renderItem(notice({ ...appNotice, link: runLink })))).toContain(
        "/w/cws_team/workflows/wf_1/runs/wfr_1"
      );
      // CHAT-SHARE-2: the notice of a chat shared with the reader opens the chat.
      const shared = notice({
        ...appNotice,
        link: { kind: "conversation", workspaceId: "cws_team", conversationId: "conv_1" }
      });
      expect(hrefs(renderItem(shared))).toContain("/w/cws_team/c/conv_1");
    });

    it("offers no answer once handled, and no link where it names none", () => {
      const markup = renderItem({
        ...notice({ title: appNotice.title, text: appNotice.text }),
        status: "approved",
        canDecide: false
      });
      expect(markup).not.toContain("data-decision=");
      expect(markup).not.toContain("href=");
    });

    // LU-6: the reader of a run's notice may tell the Workflow's builders about the result, once.
    it("offers feedback on a run's result once none is known, only with the module on, and never shows it back", () => {
      const runNotice = { ...notice({ ...appNotice, link: runLink }), id: "apr_notice" };
      const withModule = (resultFeedback: boolean) => ({ ...host("user-ada"), resultFeedback });
      const read = (own: Record<string, unknown> | null) => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(["feedback", "result", INBOX_API_BASE_URL, "apr_notice"], own);
        return queryClient;
      };
      expect(renderItem(runNotice, { host: withModule(true), queryClient: read(null) })).toContain(
        'data-testid="result-feedback-action"'
      );
      expect(renderItem(runNotice, { host: withModule(true) })).not.toContain("result-feedback");
      expect(
        renderItem(runNotice, { host: withModule(false), queryClient: read(null) })
      ).not.toContain("result-feedback");
      expect(
        renderItem(
          { ...notice(appNotice), id: "apr_notice" },
          { host: withModule(true), queryClient: read(null) }
        )
      ).not.toContain("result-feedback");

      const sent = renderItem(runNotice, {
        host: withModule(true),
        queryClient: read({
          id: "fb_1",
          state: "handled",
          text: "Der Kontoauszug war doch da.",
          includesExchange: false,
          createdAt: "2026-10-29T10:00:00.000Z"
        })
      });
      expect(sent).toContain('data-feedback-state="handled"');
      expect(sent).not.toContain("result-feedback-action");
      expect(sent).not.toContain("Der Kontoauszug war doch da.");
    });
  });
});

// DAILY-WINS 4: an Inbox item leads to what it is about, for a reader who may open it there.
describe("inbox item places", () => {
  const workspaces = [
    { id: "cw_personal", kind: "personal" as const, name: "Personal", emoji: null },
    { id: "cw_1", kind: "shared" as const, name: "Vertrieb", emoji: null }
  ];
  const placesHost = (
    context: Parameters<typeof inboxPlaces>[0]["context"],
    open: { apps?: boolean; workflows?: boolean } = {},
    listed: typeof workspaces = workspaces
  ): ApprovalRevisionHost => ({
    ...host("user-anna"),
    places: inboxPlaces({
      context,
      workspaces: listed,
      ownerLabel: "Anna Beispiel",
      appsOpen: open.apps ?? true,
      workflowsOpen: open.workflows ?? true
    })
  });
  const call = {
    runId: "opr_1",
    operation: "assets.publish",
    effect: "changing",
    actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
    origin: { kind: "user" },
    workspaceId: "cw_1",
    inputs: []
  };
  const review = {
    name: "offers",
    title: "Offers",
    revision: 2,
    files: [],
    hostsAdded: [],
    connections: [],
    dataStores: []
  };
  const appPublish = (live: boolean) => ({
    kind: "app_publish",
    summary: "assets.publish",
    canDecide: true,
    preview: { ...call, review: { ...review, kind: "app", ...(live ? { liveRevision: 1 } : {}) } }
  });
  const workflowPublish = {
    kind: "workflow_publish",
    summary: "assets.publish",
    canDecide: true,
    preview: { ...call, review: { ...review, kind: "workflow", name: "nightly-import" } }
  };
  // A Workflow the instance owns is published without a workspace: the held call names none.
  const { workspaceId: _owner, ...instanceCall } = call;
  const instanceWorkflowPublish = {
    ...workflowPublish,
    preview: { ...instanceCall, review: workflowPublish.preview.review }
  };
  /** The href of the item's place link, or nothing. */
  const place = (markup: string) =>
    /<a[^>]*data-testid="inbox-item-place"[^>]*>/u.exec(markup)?.[0].match(/href="([^"]*)"/u)?.[1];

  it("leads who may write the App to its draft, and who may only read it to the live App", () => {
    const writer = placesHost(appsContext({ cw_1: ["app.read", "app.write"] }));
    expect(place(renderItem(appPublish(true), { host: writer }))).toBe("/w/cw_1/app-drafts/offers");
    const reader = placesHost(appsContext({ cw_1: ["app.read"] }));
    const live = place(renderItem(appPublish(true), { host: reader }));
    expect(live).toContain("offers");
    expect(live).not.toContain("app-drafts");
    expect(place(renderItem(appPublish(false), { host: reader }))).toBeUndefined();
  });

  it("draws no link the reader cannot open", () => {
    const stranger = placesHost(appsContext({ cw_2: ["app.read", "app.write"] }));
    expect(place(renderItem(appPublish(true), { host: stranger }))).toBeUndefined();
    const closed = placesHost(appsContext({ cw_1: ["app.read", "app.write"] }), { apps: false });
    expect(place(renderItem(appPublish(true), { host: closed }))).toBeUndefined();
    expect(place(renderItem(appPublish(true)))).toBeUndefined();
    const writer = placesHost(appsContext({ cw_1: ["app.read", "app.write"] }));
    expect(place(renderItem(item(), { host: writer }))).toBeUndefined();
  });

  it("leads who may read Workflows to the Workflow under review", () => {
    const reader = placesHost(workflowsContext(["workflow.read"]));
    expect(place(renderItem(workflowPublish, { host: reader }))).toContain("nightly-import");
    expect(
      place(renderItem(workflowPublish, { host: placesHost(workflowsContext([])) }))
    ).toBeUndefined();
    expect(
      place(
        renderItem(workflowPublish, {
          host: placesHost(workflowsContext(["workflow.read"]), { workflows: false })
        })
      )
    ).toBeUndefined();
  });

  it("leads who may read the instance's Workflows to one the instance owns, in their own workspace", () => {
    const reader = placesHost(workflowsContext(["workflow.read"]));
    expect(place(renderItem(instanceWorkflowPublish, { host: reader }))).toBe(
      "/w/cw_personal/workflows/nightly-import"
    );
    // A right in a workspace is never lent to what the instance owns.
    const inWorkspaces = placesHost(
      workflowsContext([], { cw_personal: ["workflow.read"], cw_1: ["workflow.read"] })
    );
    expect(place(renderItem(instanceWorkflowPublish, { host: inWorkspaces }))).toBeUndefined();
    const homeless = placesHost(
      workflowsContext(["workflow.read"]),
      {},
      workspaces.filter((workspace) => workspace.kind !== "personal")
    );
    expect(place(renderItem(instanceWorkflowPublish, { host: homeless }))).toBeUndefined();
  });
});

// OP-4b2: the confirmation a person answers in their own Inbox. It is addressed to them alone,
// offers Allow and Deny and nothing else, and says how it ended.
describe("a confirmation in its person's Inbox", () => {
  const API_BASE_URL = "http://127.0.0.1:1";
  const agentCall = {
    runId: "opr_c1",
    operation: "connections.crm.update_contact",
    effect: "changing",
    mode: "confirmation",
    actor: { kind: "user", id: "user-felix", label: "Felix Pahlke" },
    origin: { kind: "agent", agentName: "steuer-agent", toolName: "crm_update_contact" },
    inputs: [{ key: "email", value: "anna@example.com" }],
    expiresAt: "2026-10-12T08:00:00Z"
  };
  const publishCall = {
    runId: "opr_c2",
    operation: "assets.publish",
    effect: "changing",
    mode: "confirmation",
    actor: { kind: "user", id: "user-felix", label: "Felix Pahlke" },
    origin: { kind: "cli" },
    inputs: [{ key: "name", value: "offer-tool" }],
    review: {
      kind: "app",
      name: "offer-tool",
      title: "Angebotsrechner",
      revision: 4,
      liveRevision: 3,
      files: [{ path: "index.html", change: "changed" }],
      changing: [],
      hostsAdded: [],
      connections: [],
      dataStores: []
    }
  };
  const confirmation = (overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView =>
    item({
      id: "apr_c1",
      kind: "operation_call",
      summary: "connections.crm.update_contact",
      addresseeUserId: "user-felix",
      requestedBy: { id: "user-felix", displayLabel: "Felix Pahlke" },
      origin: {
        conversationId: "conv_1",
        agentRunId: "run_1",
        toolCallId: "call_1",
        agentName: "steuer-agent"
      },
      preview: agentCall,
      canDecide: true,
      ...overrides
    });
  const allowed = {
    status: "approved" as const,
    canDecide: false,
    decision: {
      approved: true,
      decidedBy: "user-felix",
      decidedByLabel: "Felix Pahlke",
      decidedAt: "2026-10-05T09:00:00Z"
    },
    applyResult: { runId: "opr_c1", execution: "done" }
  };
  const denied = {
    status: "rejected" as const,
    canDecide: false,
    decision: { ...allowed.decision, approved: false, comment: "Nicht diesen Kontakt." }
  };
  const expired = {
    status: "superseded" as const,
    canDecide: false,
    applyResult: { runId: "opr_c1", execution: "expired" }
  };
  const withdrawn = {
    status: "withdrawn" as const,
    canDecide: false,
    applyResult: {
      runId: "opr_c1",
      execution: "refused",
      error: { code: "CONFLICT", message: "run stopped" }
    }
  };
  const publish = (preview: Record<string, unknown> = publishCall) =>
    renderItem(confirmation({ summary: "assets.publish", origin: undefined, preview }));

  it("says only the addressee decides, and offers Allow and Deny alone", () => {
    const markup = renderItem(confirmation());
    expect(markup).toContain('data-testid="confirmation-only-you"');
    expect(markup).not.toContain("Angefragt von Felix Pahlke");
    expect(markup).toMatch(/data-input-key="email".*anna@example\.com/u);
    expect(decisions(markup)).toEqual(["reject", "approve"]);
    expect(markup).not.toContain("data-always-allow");
  });

  it("shows a CLI publish with its review, and first that another person decides where the reader may not approve", () => {
    const markup = publish();
    expect(markup).toContain('data-testid="publish-review"');
    // The approver's headline about another person is not shown to the person themselves.
    expect(markup).not.toContain("Felix Pahlke möchte");
    expect(decisions(markup)).toEqual(["reject", "approve"]);
    expect(markup).not.toContain('data-testid="confirmation-approval-follows"');
    expect(publish({ ...publishCall, approvalFollows: true })).toContain(
      'data-testid="confirmation-approval-follows"'
    );
  });

  it("says how it ended, keeps the run's own error out, and offers nothing to decide", () => {
    for (const state of [
      allowed,
      {
        ...allowed,
        applyResult: { runId: "opr_c1", execution: "held", approvalRequestId: "apr_p" }
      },
      denied,
      expired,
      withdrawn
    ]) {
      const markup = renderItem(confirmation(state));
      expect(markup).toContain('data-testid="operation-call-outcome"');
      expect(markup).not.toContain("data-decision=");
      expect(markup).not.toContain("run stopped");
    }
    expect(renderItem(confirmation(denied))).toMatch(/<blockquote[^>]*>Nicht diesen Kontakt\.</u);
  });

  it("says a publish a newer live version overtook can do nothing, without the server's words", () => {
    const markup = renderItem(
      confirmation({
        status: "superseded",
        canDecide: false,
        preview: publishCall,
        applyResult: {
          runId: "opr_c1",
          execution: "refused",
          error: {
            code: "PUBLISH_OVERTAKEN",
            message: "A newer version went live.",
            liveRevision: 5,
            alreadyLive: false
          }
        }
      })
    );
    expect(markup).toContain("Version 5");
    expect(markup).not.toContain("data-decision=");
    expect(markup).not.toContain("A newer version went live.");
  });

  // RECORDS-AGENT: a Data Store row write asks what it changes, from the frozen input.
  it("asks what a Data Store row write changes, lists every row and never names the store's id", () => {
    const rowWrite = (
      verb: string,
      input: Record<string, unknown>,
      state: Partial<ApprovalRequestView> = {},
      targetTitle = "Urlaubsanträge",
      mode = "confirmation"
    ) =>
      confirmation({
        summary: `data_store.ds_7f3a.${verb}`,
        preview: {
          ...agentCall,
          mode,
          operation: `data_store.ds_7f3a.${verb}`,
          ...(targetTitle ? { targetTitle } : {}),
          inputs: [{ key: "table", value: "holiday_requests" }]
        },
        payload: { input },
        ...state
      });
    const alex = { employee: "Alex", starts_on: "2026-11-02" };
    const summaryOf = (markup: string) =>
      /data-testid="operation-call-summary"[^>]*>([^<]*)</u.exec(markup)?.[1];

    const insert = renderItem(rowWrite("insert", { table: "holiday_requests", rows: [alex] }));
    expect(summaryOf(insert)).toContain("Urlaubsanträge");
    expect(insert).toMatch(/employee: Alex[\s\S]*starts_on: 2026-11-02/u);
    expect(insert).not.toContain("ds_7f3a");
    const untitled = renderItem(
      rowWrite("delete_rows", { table: "holiday_requests", keys: [{ id: 7 }] }, {}, "")
    );
    expect(summaryOf(untitled)).toContain("holiday_requests");
    expect(untitled).not.toContain("ds_7f3a");

    // Every row of the call is listed, up to the operation's own bound.
    const many = renderItem(
      rowWrite("insert", {
        table: "holiday_requests",
        rows: Array.from({ length: 1000 }, (_, index) => ({ ...alex, id: index }))
      })
    );
    expect(many).toMatch(/data-input-key="Datensatz 1000"[\s\S]*id: 999/u);
    expect(many).not.toContain('data-testid="operation-call-hidden-fields"');

    // Another shape is shown field by field, with no question; once decided, nothing is asked.
    const odd = renderItem(rowWrite("update", { table: "holiday_requests", rows: [{ id: 7 }] }));
    expect(odd).not.toContain('data-testid="operation-call-summary"');
    expect(odd).toContain('data-input-key="table"');
    expect(
      renderItem(
        rowWrite("insert", { table: "holiday_requests", rows: [alex] }, { ...allowed, payload: {} })
      )
    ).not.toContain('data-testid="operation-call-summary"');

    // The question stands once, in a person's own confirmation and in an approval for another.
    const update = { table: "holiday_requests", rows: [{ key: { id: 7 }, set: { ends_on: "x" } }] };
    for (const request of [
      rowWrite("update", update),
      rowWrite("update", update, { addresseeUserId: undefined }, "Urlaubsanträge", "approval")
    ]) {
      expect(renderItem(request).match(/data-testid="operation-call-summary"/gu)).toHaveLength(1);
    }
  });

  it("leads the waiting run's conversation to the item, without Allow or Deny", () => {
    const markup = render(
      createElement(ToolInboxWaitView, {
        decision: { expiresAt: "2026-10-12T08:00:00Z" },
        title: "Kontakt im CRM ändern",
        inboxItemId: "apr_c1"
      })
    );
    expect(hrefs(markup)).toContain("/inbox/apr_c1");
    expect(markup).not.toContain("Erlauben");
    expect(markup).not.toContain("Verweigern");
  });

  it("leaves Always allow out in an embedding host's session, which the server refuses it", () => {
    const call = confirmation({ preview: { ...agentCall, alwaysAllow: true } });
    expect(renderItem(call)).toContain("Immer erlauben");
    const embedded = renderItem(call, { embedded: true });
    expect(decisions(embedded)).toEqual(["reject", "approve"]);
    expect(embedded).not.toContain("Immer erlauben");
  });

  describe("deciding it", () => {
    const itemPath = apiOperations["approval_requests.get"].buildPath({
      params: { requestId: "apr_c1" }
    });
    const decidePath = apiOperations["approval_requests.decide"].buildPath({
      params: { requestId: "apr_c1" }
    });
    const decideBody = z.object({
      decision: z.string(),
      comment: z.string().optional(),
      alwaysAllow: z.literal(true).optional()
    });
    const notFound = () =>
      Response.json(
        { error: { code: "NOT_FOUND", message: "Approval request was not found" } },
        { status: 404 }
      );

    /** An instance that answers the item's reads and decisions as a test says. */
    function instance(initial: ApprovalRequestView | "not_found") {
      let current = initial;
      const sent: unknown[] = [];
      let answerDecision: (body: { decision: string; comment?: string }) => Response = (body) => {
        if (current === "not_found") return notFound();
        current =
          body.decision === "approve"
            ? { ...current, ...allowed }
            : { ...current, ...denied, decision: { ...denied.decision, comment: body.comment } };
        return Response.json(current);
      };
      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === decidePath) {
          const body = decideBody.parse(await request.json());
          sent.push(body);
          return answerDecision(body);
        }
        if (request.method === "GET" && path === itemPath) {
          return current === "not_found" ? notFound() : Response.json(current);
        }
        return notFound();
      };
      return {
        fetchImpl,
        decisions: sent,
        /** The item changes meanwhile, and a decision is refused as no longer open. */
        endsMeanwhile(next: ApprovalRequestView) {
          answerDecision = () => {
            current = next;
            return Response.json(
              { error: { code: "CONFLICT", message: "No longer waits." } },
              { status: 409 }
            );
          };
        }
      };
    }

    let unmount: (() => Promise<void>) | undefined;
    afterEach(async () => {
      await unmount?.();
      unmount = undefined;
      vi.unstubAllGlobals();
    });

    async function mountItem(fetchImpl: typeof fetch): Promise<HTMLElement> {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("fetch", fetchImpl);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const tree: ReactNode = createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: API_BASE_URL,
          children: createElement(WorkspaceDraftsProvider, {
            children: createElement(
              TranslationProvider,
              { locale: "de", children: null },
              createElement(
                UiRoot,
                { mode: "light", labels: uiLabelsDe },
                createElement(InboxItemPanel, { itemId: "apr_c1" })
              )
            )
          })
        })
      );
      await act(async () => root.render(tree));
      unmount = async () => {
        await act(async () => root.unmount());
        queryClient.clear();
        container.remove();
      };
      return container;
    }

    const waitFor = (assertion: () => void) =>
      vi.waitFor(async () => act(async () => assertion()), { timeout: CONDITION_WAIT_MS });
    const button = (container: HTMLElement, choice: string) => {
      const found = container.querySelector<HTMLButtonElement>(`[data-decision="${choice}"]`);
      if (!found) throw new Error(`No ${choice} button`);
      return found;
    };
    const outcome = (container: HTMLElement) =>
      container
        .querySelector('[data-testid="operation-call-outcome"]')
        ?.getAttribute("data-outcome");

    it("lets the addressee allow it, and then shows that the call ran", async () => {
      const server = instance(confirmation());
      const container = await mountItem(server.fetchImpl);
      await waitFor(() => expect(container.querySelector("[data-decision]")).not.toBeNull());
      await act(async () => button(container, "approve").click());
      await waitFor(() => expect(outcome(container)).toBe("done"));
      expect(server.decisions).toEqual([{ decision: "approve" }]);
      expect(container.querySelector("[data-decision]")).toBeNull();
    });

    it("offers Always allow where the call does, and sends it with Allow (OP-6)", async () => {
      const plain = await mountItem(instance(confirmation()).fetchImpl);
      await waitFor(() => expect(plain.querySelector('[data-decision="approve"]')).not.toBeNull());
      expect(plain.querySelector("[data-always-allow]")).toBeNull();
      await unmount?.();

      const server = instance(confirmation({ preview: { ...agentCall, alwaysAllow: true } }));
      const container = await mountItem(server.fetchImpl);
      await waitFor(() => expect(container.querySelector("[data-always-allow]")).not.toBeNull());
      await act(async () =>
        container.querySelector<HTMLButtonElement>("[data-always-allow]")?.click()
      );
      await waitFor(() => expect(server.decisions).toHaveLength(1));
      expect(server.decisions).toEqual([{ decision: "approve", alwaysAllow: true }]);
    });

    it("denies with one click and no reason, and passes a reason that was given", async () => {
      const server = instance(confirmation());
      const container = await mountItem(server.fetchImpl);
      await waitFor(() =>
        expect(container.querySelector('[data-decision="reject"]')).not.toBeNull()
      );
      await act(async () => button(container, "reject").click());
      await waitFor(() => expect(container.querySelector("[data-decision]")).toBeNull());
      expect(server.decisions).toEqual([{ decision: "reject" }]);

      await unmount?.();
      const withReason = instance(confirmation());
      const second = await mountItem(withReason.fetchImpl);
      await waitFor(() => expect(second.querySelector("textarea")).not.toBeNull());
      const textarea = second.querySelector("textarea");
      if (!textarea) throw new Error("No comment field");
      await act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        setValue?.call(textarea, "Nicht diesen Kontakt.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => button(second, "reject").click());
      await waitFor(() => expect(withReason.decisions).toHaveLength(1));
      expect(withReason.decisions).toEqual([
        { decision: "reject", comment: "Nicht diesen Kontakt." }
      ]);
    });

    it("shows a person who is not the addressee nothing of it, and nothing to decide", async () => {
      // The server answers anybody but the addressee that the item does not exist.
      const server = instance("not_found");
      const container = await mountItem(server.fetchImpl);
      await waitFor(() => expect(container.textContent).toContain("du darfst ihn nicht sehen"));
      expect(container.querySelector("[data-decision]")).toBeNull();
      expect(container.textContent).not.toContain("connections.crm.update_contact");
      expect(container.textContent).not.toContain("steuer-agent");
      expect(server.decisions).toEqual([]);
    });

    it("refuses an answer that comes after it expired, and then shows it expired", async () => {
      const server = instance(confirmation());
      server.endsMeanwhile(confirmation(expired));
      const container = await mountItem(server.fetchImpl);
      await waitFor(() =>
        expect(container.querySelector('[data-decision="approve"]')).not.toBeNull()
      );
      await act(async () => button(container, "approve").click());
      await waitFor(() => expect(outcome(container)).toBe("expired"));
      expect(container.textContent).toContain("Deine Entscheidung wurde nicht gespeichert");
      expect(container.querySelector("[data-decision]")).toBeNull();
      expect(server.decisions).toEqual([{ decision: "approve" }]);
    });
  });
});
