import { createElement, type ReactNode } from "react";
import type { ApprovalRequestView } from "@vivd-catalyst/api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  formatInboxAge,
  InboxAreaView,
  inboxItemKinds,
  InboxItemKindsProvider,
  inboxItemSurface,
  InboxItemView,
  InboxList,
  inboxRailEntry,
  inboxTabCount,
  inboxTabOfItem,
  inboxTabs,
  orderInboxItems,
  type InboxCounts,
  type InboxItemActions,
  type InboxItemKind,
  type InboxTab
} from "../packages/chat-ui/src/inbox";
import { ToolDisplayPanelProvider } from "../packages/chat-ui/src/tool-display-panel";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Every test here fails without the Inbox frame: the modules it reads did not exist.

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
    }
  ]
};

function item(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return {
    id: "apr_1",
    clientInstanceId: "client-1",
    kind: "skill_change",
    summary: "Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.",
    payload: {},
    requestedBy: { id: "user-anna", displayLabel: "Anna Beispiel" },
    origin: {
      conversationId: "conv_1",
      agentRunId: "run_1",
      toolCallId: "call_1",
      agentName: "payroll-agent"
    },
    status: "pending",
    checks: [],
    createdAt: "2026-10-05T08:00:00Z",
    updatedAt: "2026-10-05T08:00:00Z",
    preview: skillChangePreview,
    canDecide: false,
    canWithdraw: false,
    canRevert: false,
    ...overrides
  };
}

const decision = {
  approved: false,
  decidedBy: "user-felix",
  decidedByLabel: "Felix Pahlke",
  decidedAt: "2026-10-05T09:00:00Z",
  comment: "Bitte ohne Kundennamen."
};

const idleActions: InboxItemActions = {
  pending: false,
  decide: () => undefined,
  withdraw: () => undefined,
  revert: () => undefined
};

const now = new Date("2026-10-05T11:00:00Z");

function render(node: ReactNode, locale: "de" | "en" = "de"): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { children: null, locale }, node));
}

function renderItem(
  overrides: Partial<ApprovalRequestView> = {},
  options: {
    actions?: InboxItemActions;
    locale?: "de" | "en";
    kinds?: readonly InboxItemKind[];
  } = {}
): string {
  const view = createElement(InboxItemView, {
    state: { status: "ready", request: item(overrides) },
    actions: options.actions ?? idleActions
  });
  return render(
    options.kinds ? createElement(InboxItemKindsProvider, { value: options.kinds }, view) : view,
    options.locale
  );
}

/** A kind the platform does not have: its own words, its own body, two of the three decisions. */
const [platformKind] = inboxItemKinds;
if (!platformKind) {
  throw new Error("The platform registers no item kind.");
}
const expenseKind: InboxItemKind = {
  kind: "expense_claim",
  label: "nav.inbox",
  icon: platformKind.icon,
  subject: () => "Reise nach Hamburg",
  Body: ({ item: claim }) => createElement("p", { "data-testid": "expense-body" }, claim.summary),
  decisions: [
    { decision: "reject", label: "approvalWithdraw" },
    { decision: "approve", label: "approvalRevert" }
  ]
};

describe("inbox model", () => {
  const reviewer: InboxCounts = { count: 2, canReview: true, mine: { pending: 1, total: 4 } };
  const member: InboxCounts = { count: 0, canReview: false, mine: { pending: 1, total: 1 } };
  const stranger: InboxCounts = { count: 0, canReview: false, mine: { pending: 0, total: 0 } };

  it("gives a reviewer three lists and everyone else their own requests alone", () => {
    expect(inboxTabs(true)).toEqual(["to_decide", "mine", "decided"]);
    expect(inboxTabs(false)).toEqual(["mine"]);
  });

  it("puts the Inbox in the rail for a reviewer and for a person who has asked", () => {
    expect(inboxRailEntry(reviewer)).toEqual({ toDecide: 2 });
    expect(inboxRailEntry({ ...reviewer, count: 0 })).toEqual({ toDecide: 0 });
    expect(inboxRailEntry(member)).toEqual({ toDecide: 0 });
    expect(inboxRailEntry(stranger)).toBeUndefined();
    expect(inboxRailEntry(undefined)).toBeUndefined();
  });

  it("counts what waits in a list and nothing in the decided one", () => {
    expect(inboxTabCount("to_decide", reviewer)).toBe(2);
    expect(inboxTabCount("mine", reviewer)).toBe(1);
    expect(inboxTabCount("decided", reviewer)).toBeUndefined();
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

  it("says how long ago in the reader's language", () => {
    expect(formatInboxAge("2026-10-05T08:00:00Z", "en", now)).toBe("3 hr. ago");
    expect(formatInboxAge("2026-10-02T08:00:00Z", "de", now)).toBe("vor 3 Tagen");
    expect(formatInboxAge("2026-10-05T10:59:50Z", "en", now)).toBe("now");
    expect(formatInboxAge("no date", "en", now)).toBe("no date");
  });

  it("names the surface of an item by its kind and what it concerns", () => {
    const kindOf = (kind: string) => inboxItemKinds.find((entry) => entry.kind === kind);
    const { t } = createTranslationContext("de");

    expect(inboxItemSurface("apr_1", item(), kindOf, t)).toEqual({
      kind: "inbox_item",
      key: "inbox-item:apr_1",
      title: "Änderung einer Fähigkeit",
      subtitle: "Fähigkeit: Gehaltsabrechnungen prüfen",
      itemId: "apr_1"
    });
    expect(inboxItemSurface("apr_1", undefined, kindOf, t).title).toBe("Anfrage");
    expect(inboxItemSurface("apr_1", item({ kind: "future_kind" }), kindOf, t).title).toBe(
      "Anfrage"
    );
  });
});

describe("inbox list", () => {
  function renderList(
    tab: InboxTab,
    items: readonly ApprovalRequestView[] | "loading" | "error",
    locale: "de" | "en" = "de",
    selectedItemId?: string
  ): string {
    return render(
      createElement(InboxList, {
        tab,
        state:
          items === "loading"
            ? { status: "loading" }
            : items === "error"
              ? { status: "error", onRetry: () => undefined }
              : { status: "ready", items },
        selectedItemId,
        now,
        agentDisplayName: (agentName) => (agentName === "payroll-agent" ? "Lohnbüro" : undefined),
        onOpenItem: () => undefined
      }),
      locale
    );
  }

  it("says in a row what is asked, who asked through which agent, and how long ago", () => {
    const markup = renderList("to_decide", [item()]);

    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
    expect(markup).toContain("Anna Beispiel über Lohnbüro");
    expect(markup).toContain('<time dateTime="2026-10-05T08:00:00Z">vor 3 Std.</time>');
    expect(markup).toContain("lucide-file-text");
    expect(markup).toContain('data-kind="person"');
    // Every row of To decide is pending, so the row does not say so.
    expect(markup).not.toContain("Wartet auf Freigabe");
    expect(renderList("to_decide", [item()], "en")).toContain("Anna Beispiel via Lohnbüro");
  });

  it("shows the state where a list mixes states, and counts the decided list from the decision", () => {
    const decided = item({ status: "approved", updatedAt: "2026-10-05T10:00:00Z" });

    expect(renderList("mine", [item()])).toContain("Wartet auf Freigabe");
    const markup = renderList("decided", [decided]);
    expect(markup).toContain("Übernommen");
    expect(markup).toContain('dateTime="2026-10-05T10:00:00Z"');
  });

  it("marks the open item and decides nothing from the row", () => {
    const markup = renderList("to_decide", [item({ canDecide: true })], "de", "apr_1");

    expect(markup).toMatch(/<button[^>]*aria-current="true"/u);
    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).not.toContain("Übernehmen");
  });

  it("lists an item of a kind the client does not know, by its summary", () => {
    const markup = renderList("to_decide", [item({ kind: "future_kind", origin: undefined })]);

    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
    expect(markup).toContain("lucide-circle-question-mark");
    expect(markup).not.toContain("über");
  });

  it("has a sentence for each empty list in both languages", () => {
    expect(renderList("to_decide", [])).toContain("Nichts zu entscheiden.");
    expect(renderList("decided", [])).toContain(
      "In den letzten 30 Tagen wurde nichts entschieden."
    );
    expect(renderList("mine", [])).toContain("Du hast nichts angefragt");
    expect(renderList("to_decide", [], "en")).toContain("Nothing to decide.");
    expect(renderList("mine", [], "en")).toContain("You have not requested anything");
  });

  it("shows a loading layout and a failure with a way out", () => {
    expect(renderList("mine", "loading")).toContain('aria-busy="true"');
    const failed = renderList("mine", "error");
    expect(failed).toContain("Die Anfragen konnten nicht geladen werden.");
    expect(failed).toContain(">Erneut versuchen</button>");
  });
});

describe("inbox item", () => {
  it("shows the head, the kind's body and nothing to do for a reader who can do nothing", () => {
    const markup = renderItem();

    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
    expect(markup).toContain("Wartet auf Freigabe");
    expect(markup).toMatch(/Angefragt von Anna Beispiel, [^<]+ · über payroll-agent/u);
    expect(markup).toContain("Prüfe den Bruttolohn und die Steuerklasse.");
    expect(markup).not.toContain("inbox-item-foot");
    expect(markup).not.toContain("<button");
  });

  it("offers a person who can decide a comment and the three decisions, below the proposal", () => {
    const markup = renderItem({ canDecide: true, canWithdraw: true });

    expect(markup).toContain("sticky bottom-0");
    expect(markup).toContain("Kommentar");
    expect(markup).toContain("<textarea");
    expect(markup).toContain(">Übernehmen</button>");
    expect(markup).toContain(">Änderung anfragen</button>");
    expect(markup).toContain(">Ablehnen</button>");
    // A requester who may decide rejects; a second button with the same effect is left out.
    expect(markup).not.toContain("Zurückziehen");
    expect(markup.indexOf("Prüfe den Bruttolohn")).toBeLessThan(markup.indexOf("Übernehmen"));
    const english = renderItem({ canDecide: true }, { locale: "en" });
    expect(english).toContain(">Accept</button>");
    expect(english).toContain(">Request changes</button>");
    expect(english).toContain("Comment");
  });

  it("offers the requester who cannot decide withdraw alone", () => {
    const markup = renderItem({ canWithdraw: true });

    expect(markup).toContain(">Zurückziehen</button>");
    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).not.toContain("<textarea");
  });

  it("shows who decided, the comment and who undid it once it is decided", () => {
    const markup = renderItem({
      status: "reverted",
      decision: { ...decision, approved: true },
      reversion: {
        revertedBy: "user-felix",
        revertedByLabel: "Felix Pahlke",
        revertedAt: "2026-10-06T09:00:00Z"
      }
    });

    expect(markup).toContain("Rückgängig gemacht</span>");
    expect(markup).toContain("Entscheidung von Felix Pahlke");
    expect(markup).toContain("Bitte ohne Kundennamen.");
    expect(markup).toContain("Rückgängig gemacht von Felix Pahlke");
    expect(markup).not.toContain("<button");
  });

  it("offers undo on an accepted item only when the server allows it", () => {
    expect(renderItem({ status: "approved", canRevert: true })).toContain(
      ">Rückgängig machen</button>"
    );
    expect(renderItem({ status: "approved" })).not.toContain("Rückgängig machen");
  });

  it("explains an undo that newer changes made impossible", () => {
    const markup = renderItem(
      { status: "approved", canRevert: true },
      { actions: { ...idleActions, failure: "revert_conflict" } }
    );

    expect(markup).toContain("weil es inzwischen neuere Änderungen gibt");
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
    expect(markup).toContain("Die automatische Prüfung konnte nicht ausgeführt werden.");
    expect(markup).not.toContain("Format in Ordnung.");
    expect(markup.match(/role="note"/gu)).toHaveLength(2);
  });

  it("opens an item of an unknown kind with a sentence and no way to decide it", () => {
    const markup = renderItem({
      kind: "future_kind",
      canDecide: true,
      canRevert: true,
      canWithdraw: false
    });

    expect(markup).toContain("Bei Gehaltsabrechnungen auch die Steuerklasse prüfen.");
    expect(markup).toContain("Dieser Eintrag kann hier noch nicht angezeigt werden.");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<textarea");
    expect(renderItem({ kind: "future_kind" }, { locale: "en" })).toContain(
      "This item cannot be shown here yet."
    );
    // Taking one's own request back needs no knowledge of the kind.
    expect(renderItem({ kind: "future_kind", canWithdraw: true })).toContain(
      ">Zurückziehen</button>"
    );
  });

  it("renders a planted kind through the same frame, with its body and its own decisions", () => {
    const markup = renderItem(
      { kind: "expense_claim", canDecide: true, preview: { amount: 120 } },
      { kinds: [...inboxItemKinds, expenseKind] }
    );

    expect(markup).toContain('data-testid="expense-body"');
    expect(markup).toContain("Wartet auf Freigabe");
    expect(markup).toContain("Angefragt von Anna Beispiel");
    expect(markup).toMatch(/data-decision="reject"[^>]*>Zurückziehen<\/button>/u);
    expect(markup).toMatch(/data-decision="approve"[^>]*>Rückgängig machen<\/button>/u);
    expect(markup).not.toContain('data-decision="request_changes"');
    expect(markup).not.toContain("noch nicht angezeigt");
    // Without the entry the same item is one the frame cannot decide.
    expect(renderItem({ kind: "expense_claim", canDecide: true })).not.toContain("<button");
  });

  it("renders loading, not-found and failure as states of their own", () => {
    const state = (value: Parameters<typeof InboxItemView>[0]["state"]) =>
      render(createElement(InboxItemView, { state: value, actions: idleActions }));

    expect(state({ status: "loading" })).toContain('aria-busy="true"');
    expect(state({ status: "not-found" })).toContain("du darfst ihn nicht sehen");
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
    locale: "de" | "en" = "de"
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
          onTabChange: () => undefined,
          onOpenItem: () => undefined,
          onCloseItem: () => undefined
        })
      ),
      locale
    );
  }

  it("gives a reviewer three tabs with what waits in each", () => {
    const markup = renderArea(
      { count: 2, canReview: true, mine: { pending: 0, total: 3 } },
      "to_decide",
      [item({ canDecide: true })]
    );

    expect(markup).toContain(">Eingang</h1>");
    expect(markup.match(/role="tab"/gu)).toHaveLength(3);
    expect(markup).toMatch(/aria-selected="true"[^>]*>Zu entscheiden<span[^>]*>2<\/span>/u);
    expect(markup).toContain("Meine Anfragen");
    expect(markup).toContain("Entschieden");
    expect(markup).toContain('data-testid="inbox-row"');
  });

  it("shows a plain member their own requests without a tab bar", () => {
    const markup = renderArea(
      { count: 0, canReview: false, mine: { pending: 1, total: 1 } },
      "mine",
      [item({ canWithdraw: true })],
      "en"
    );

    expect(markup).toContain(">Inbox</h1>");
    expect(markup).not.toContain('role="tab"');
    expect(markup).not.toContain("To decide");
    expect(markup).toContain("Awaiting approval");
  });

  it("tells a reviewer with an empty queue that nothing waits", () => {
    const markup = renderArea(
      { count: 0, canReview: true, mine: { pending: 0, total: 0 } },
      "to_decide",
      []
    );

    expect(markup).toContain("Nichts zu entscheiden.");
    expect(markup).toMatch(/aria-selected="true"[^>]*>Zu entscheiden<\/button>/u);
  });
});
