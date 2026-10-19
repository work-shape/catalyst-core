// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { ToolInboxWaitView } from "@work-shape/catalyst-chat-ui/tool-decision-card";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { InboxItemPanel, WorkspaceDraftsProvider } from "./support/chat-ui";
import { InboxList, item, now, render, renderItem } from "./chat-ui-inbox-harness";

// OP-4b2: the confirmation a person answers in their own Inbox, for an agent run nobody
// watched or for `catalyst <kind> publish --yes`. It is addressed to them alone: it says who
// asks on their behalf and that nobody else decides it, offers Allow and Deny and nothing
// else, and says how it ended.

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

function confirmation(overrides: Partial<ApprovalRequestView> = {}): ApprovalRequestView {
  return item({
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
}

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

const decisionButtons = (markup: string) =>
  [...markup.matchAll(/data-decision="([a-z_]+)"[^>]*>([^<]+)</gu)].map((match) => [
    match[1],
    match[2]
  ]);

describe("a confirmation waiting in its person's Inbox", () => {
  it("says who asks for what, that it waits, and that only the addressee decides", () => {
    const markup = renderItem(confirmation());

    expect(markup).toMatch(/>Aktion bestätigen<\/h3>/u);
    expect(markup).toContain('data-status="pending"');
    expect(markup).toContain(">Wartet auf dich<");
    expect(markup).toMatch(
      /data-testid="inbox-item-asked"[^>]*>Von steuer-agent für dich angefragt, /u
    );
    expect(markup).not.toContain("Angefragt von Felix Pahlke");
    expect(markup).toContain("steuer-agent möchte für dich eine ändernde Aktion ausführen.");
    expect(markup).toMatch(
      /data-testid="confirmation-waits"[^>]*>Der Lauf wartet, bis du entscheidest\.</u
    );
    expect(markup).toMatch(
      /data-testid="confirmation-only-you"[\s\S]*Nur du kannst das entscheiden\. Es liegt in keinem anderen Eingang, auch nicht bei Admins\./u
    );
    // The frozen call: its operation and its input, as for an approval.
    expect(markup).toMatch(/data-field="operation".*connections\.crm\.update_contact/u);
    expect(markup).toMatch(/data-input-key="email".*anna@example\.com/u);
    // Allow and Deny, and nothing else: no Always allow before OP-6, no request for changes.
    expect(decisionButtons(markup)).toEqual([
      ["reject", "Verweigern"],
      ["approve", "Erlauben"]
    ]);
    expect(markup).not.toContain("Immer erlauben");
    expect(markup).not.toContain("Freigeben");

    const english = renderItem(confirmation(), { locale: "en" });
    expect(english).toMatch(/>Confirm an action<\/h3>/u);
    expect(english).toContain("Asked by steuer-agent for you, ");
    expect(english).toContain("steuer-agent wants to run a changing action for you.");
    expect(english).toContain("The run waits until you decide.");
    expect(english).toContain(
      "Only you can decide this. It is in nobody else&#x27;s Inbox, an admin&#x27;s included."
    );
    expect(decisionButtons(english)).toEqual([
      ["reject", "Deny"],
      ["approve", "Allow"]
    ]);
    expect(english).not.toContain("Always allow");
  });

  it("shows a CLI publish with its review and that nothing is published until the person decides", () => {
    const markup = renderItem(
      confirmation({ summary: "assets.publish", origin: undefined, preview: publishCall })
    );

    expect(markup).toMatch(/>Veröffentlichung von „Angebotsrechner“ bestätigen<\/h3>/u);
    expect(markup).toMatch(
      /data-testid="inbox-item-asked"[^>]*>Von deiner Kommandozeile gesendet, /u
    );
    expect(markup).toContain(
      "Du hast über die Kommandozeile angefragt, eine neue Version der App „Angebotsrechner“ zu veröffentlichen."
    );
    expect(markup).toContain("Nichts wird veröffentlicht, bis du entscheidest.");
    expect(markup).toContain("Erlauben zählt wie dein eigener Klick auf Veröffentlichen");
    expect(markup).toContain('data-testid="publish-review"');
    expect(markup).toContain("Version 4, statt Version 3");
    // The approver's headline about another person is not shown to the person themselves.
    expect(markup).not.toContain("Felix Pahlke möchte");
    expect(decisionButtons(markup)).toEqual([
      ["reject", "Verweigern"],
      ["approve", "Erlauben"]
    ]);

    const english = renderItem(
      confirmation({ summary: "assets.publish", origin: undefined, preview: publishCall }),
      { locale: "en" }
    );
    expect(english).toContain("Confirm publishing “Angebotsrechner”");
    expect(english).toContain("Nothing is published until you decide.");
  });

  it("says how it ended once allowed, denied, expired or withdrawn, and offers nothing to decide", () => {
    const states: [Partial<ApprovalRequestView>, string, string][] = [
      [allowed, "Erlaubt", "Erlaubt. Der Aufruf lief einmal."],
      [
        {
          ...allowed,
          applyResult: { runId: "opr_c1", execution: "held", approvalRequestId: "apr_p" }
        },
        "Erlaubt, wartet auf Freigabe",
        "Erlaubt. Der Aufruf wartet jetzt auf eine Freigabe; noch wurde nichts ausgeführt."
      ],
      [denied, "Verweigert", "Verweigert. Nichts wurde ausgeführt."],
      [
        expired,
        "Abgelaufen",
        "Nach 7 Tagen ohne deine Antwort abgelaufen. Nichts wurde ausgeführt."
      ],
      [
        withdrawn,
        "Zurückgezogen",
        "Zurückgezogen: Der Lauf wurde gestoppt, bevor du entschieden hast. Nichts wurde ausgeführt."
      ]
    ];
    for (const [state, badge, outcome] of states) {
      const markup = renderItem(confirmation(state));
      expect(markup).toContain(`>${badge}<`);
      const banner = markup.indexOf('data-testid="operation-call-outcome"');
      expect(banner).toBeGreaterThan(-1);
      expect(markup.indexOf(outcome, banner)).toBeGreaterThan(banner);
      expect(markup).not.toContain("data-decision=");
      expect(markup).not.toContain('data-testid="confirmation-lead"');
      // The run's own words for why it ended stay in the record, not on the item.
      expect(markup).not.toContain("run stopped");
    }
    // The reason given with a denial stands under the decision.
    expect(renderItem(confirmation(denied))).toMatch(/<blockquote[^>]*>Nicht diesen Kontakt\.</u);
    expect(renderItem(confirmation(expired), { locale: "en" })).toContain(
      "Expired after 7 days without your answer. Nothing ran."
    );
  });

  it("asks what a Data Store row write changes and lists every row from the frozen input (RECORDS-AGENT)", () => {
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
    const alex = { employee: "Alex", starts_on: "2026-11-02", ends_on: "2026-11-06" };
    const summaryOf = (markup: string) =>
      /data-testid="operation-call-summary"[^>]*>([^<]*)</u.exec(markup)?.[1];

    const insert = renderItem(rowWrite("insert", { table: "holiday_requests", rows: [alex] }));
    // Who asks stays the headline; the question names the store by its title, never its id.
    expect(insert).toContain("steuer-agent möchte für dich eine ändernde Aktion ausführen.");
    expect(summaryOf(insert)).toBe("1 Datensatz zu Urlaubsanträge hinzufügen?");
    expect(insert).toMatch(/data-input-key="Tabelle"[\s\S]*?holiday_requests/u);
    expect(insert).toContain('data-input-key="Datensatz 1"');
    expect(insert).toMatch(/employee: Alex[\s\S]*starts_on: 2026-11-02[\s\S]*ends_on: 2026-11-06/u);
    // The operation, which names the store's id, is only in the folded technical details.
    expect(insert).not.toContain("ds_7f3a");
    expect(insert).not.toContain('data-input-key="table"');

    const english = renderItem(
      rowWrite(
        "update",
        {
          table: "holiday_requests",
          rows: [
            { key: { id: 7 }, set: { ends_on: "2026-11-05" } },
            { key: { id: 8 }, set: { ends_on: "2026-11-07" } }
          ]
        },
        {},
        "Holiday requests"
      ),
      { locale: "en" }
    );
    expect(summaryOf(english)).toBe("Change 2 rows in Holiday requests?");
    expect(english).toMatch(/data-input-key="Table"[\s\S]*?holiday_requests/u);
    expect(english).toMatch(/data-input-key="Row 1, key"[\s\S]*id: 7/u);
    expect(english).toMatch(/data-input-key="Row 1, new values"[\s\S]*ends_on: 2026-11-05/u);
    expect(english).toContain('data-input-key="Row 2, key"');

    const removal = rowWrite("delete_rows", { table: "holiday_requests", keys: [{ id: 7 }] });
    expect(summaryOf(renderItem(removal))).toBe("1 Datensatz aus Urlaubsanträge löschen?");
    expect(renderItem(removal)).toMatch(/data-input-key="Datensatz 1, Schlüssel"[\s\S]*id: 7/u);
    // Without the store's title the question names the table, and still not the id.
    const untitled = renderItem(
      rowWrite("delete_rows", { table: "holiday_requests", keys: [{ id: 7 }] }, {}, ""),
      { locale: "en" }
    );
    expect(summaryOf(untitled)).toBe("Delete 1 row from holiday_requests?");
    expect(untitled).not.toContain("ds_7f3a");

    // Every row of the call is listed, up to the operation's own bound, with no count of the rest.
    const many = renderItem(
      rowWrite("insert", {
        table: "holiday_requests",
        rows: Array.from({ length: 1000 }, (_, index) => ({ ...alex, id: index }))
      })
    );
    expect(summaryOf(many)).toBe("1.000 Datensätze zu Urlaubsanträge hinzufügen?");
    expect(many).toContain('data-input-key="Datensatz 1000"');
    expect(many).toMatch(/data-input-key="Datensatz 1000"[\s\S]*id: 999/u);
    expect(many).not.toContain('data-testid="operation-call-hidden-fields"');
    // The whole input stays under the technical details, folded.
    expect(many).toContain('data-testid="operation-call-details"');
    expect(many).not.toContain('data-testid="operation-call-full-input"');

    // An input of another shape is shown field by field, as every call is, with no question.
    const odd = renderItem(rowWrite("update", { table: "holiday_requests", rows: [{ id: 7 }] }));
    expect(odd).not.toContain('data-testid="operation-call-summary"');
    expect(odd).toContain('data-input-key="table"');

    // Once decided, the item says what became of the call, and asks nothing.
    const done = renderItem(
      rowWrite("insert", { table: "holiday_requests", rows: [alex] }, { ...allowed, payload: {} })
    );
    expect(done).not.toContain('data-testid="operation-call-summary"');
    expect(done).toContain("Erlaubt. Der Aufruf lief einmal.");

    // The question stands once, in a person's own confirmation and in an approval for another.
    const writes: Record<string, Record<string, unknown>> = {
      insert: { table: "holiday_requests", rows: [alex] },
      update: { table: "holiday_requests", rows: [{ key: { id: 7 }, set: { ends_on: "x" } }] },
      delete_rows: { table: "holiday_requests", keys: [{ id: 7 }] }
    };
    for (const [verb, input] of Object.entries(writes)) {
      const own = rowWrite(verb, input);
      const others = rowWrite(
        verb,
        input,
        { addresseeUserId: undefined },
        "Urlaubsanträge",
        "approval"
      );
      for (const request of [own, others]) {
        for (const locale of ["en", "de"] as const) {
          const markup = renderItem(request, { locale });
          expect(markup.match(/data-testid="operation-call-summary"/gu)).toHaveLength(1);
        }
      }
    }
  });

  it("is listed in To decide as a confirmation asked for the person", () => {
    const markup = render(
      createElement(InboxList, {
        tab: "to_decide",
        state: { status: "ready", items: [confirmation()] },
        now,
        onOpenItem: () => undefined
      })
    );
    expect(markup).toContain("Aktion bestätigen");
    expect(markup).toContain(
      "Von steuer-agent für dich angefragt · connections.crm.update_contact"
    );

    const decided = render(
      createElement(InboxList, {
        tab: "decided",
        state: { status: "ready", items: [confirmation(denied), confirmation(expired)] },
        now,
        onOpenItem: () => undefined
      })
    );
    expect(decided).toContain(">Verweigert<");
    expect(decided).toContain(">Abgelaufen<");
  });
});

describe("the conversation of a run whose confirmation waits in the Inbox", () => {
  it("shows that it waits there and leads to the item, without Allow or Deny", () => {
    const markup = render(
      createElement(ToolInboxWaitView, {
        decision: { expiresAt: "2026-10-12T08:00:00Z" },
        title: "Kontakt im CRM ändern",
        inboxItemId: "apr_c1"
      })
    );
    expect(markup).toContain('data-mode="inbox"');
    expect(markup).toContain(
      "Wartet in deinem Eingang auf dich. Nur du kannst antworten, und nur dort."
    );
    expect(markup).toMatch(/href="\/inbox\/apr_c1"[^>]*>.*Im Eingang öffnen/u);
    expect(markup).not.toContain("Erlauben");
    expect(markup).not.toContain("Verweigern");
  });
});

const itemPath = apiOperations["approval_requests.get"].buildPath({
  params: { requestId: "apr_c1" }
});
const decidePath = apiOperations["approval_requests.decide"].buildPath({
  params: { requestId: "apr_c1" }
});
const decideBody = z.object({ decision: z.string(), comment: z.string().optional() });

/** An instance that answers the item's reads and decisions as a test says. */
function instance(initial: ApprovalRequestView | "not_found") {
  let current = initial;
  const decisions: unknown[] = [];
  let answerDecision: (body: { decision: string; comment?: string }) => Response = (body) => {
    if (current === "not_found") return notFound();
    current =
      body.decision === "approve"
        ? { ...current, ...allowed }
        : {
            ...current,
            ...denied,
            decision: {
              ...denied.decision,
              ...(body.comment ? { comment: body.comment } : { comment: undefined })
            }
          };
    return Response.json(current);
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === decidePath) {
      const body = decideBody.parse(await request.json());
      decisions.push(body);
      return answerDecision(body);
    }
    if (request.method === "GET" && path === itemPath) {
      return current === "not_found" ? notFound() : Response.json(current);
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  };
  return {
    fetchImpl,
    decisions,
    /** The item changes meanwhile, and a decision is refused as no longer open. */
    endsMeanwhile(next: ApprovalRequestView) {
      answerDecision = () => {
        current = next;
        return Response.json(
          {
            error: { code: "CONFLICT", message: "This call no longer waits for your confirmation." }
          },
          { status: 409 }
        );
      };
    }
  };
}

function notFound(): Response {
  return Response.json(
    { error: { code: "NOT_FOUND", message: "Approval request was not found" } },
    { status: 404 }
  );
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
  await act(async () => {
    root.render(
      createElement(
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
      )
    );
  });
  unmount = async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
  };
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => assertion());
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

function button(container: HTMLElement, decision: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[data-decision="${decision}"]`);
  if (!found) throw new Error(`No ${decision} button`);
  return found;
}

describe("deciding a confirmation in the Inbox", () => {
  it("lets the addressee allow it, and then says that the call ran", async () => {
    const server = instance(confirmation());
    const container = await mountItem(server.fetchImpl);
    await waitFor(() => expect(container.textContent).toContain("Der Lauf wartet"));

    await act(async () => button(container, "approve").click());

    await waitFor(() =>
      expect(container.textContent).toContain("Erlaubt. Der Aufruf lief einmal.")
    );
    expect(server.decisions).toEqual([{ decision: "approve" }]);
    expect(container.querySelector("[data-decision]")).toBeNull();
  });

  it("denies with one click and no reason, and passes a reason that was given", async () => {
    const server = instance(confirmation());
    const container = await mountItem(server.fetchImpl);
    await waitFor(() => expect(container.querySelector('[data-decision="reject"]')).not.toBeNull());

    await act(async () => button(container, "reject").click());
    await waitFor(() =>
      expect(container.textContent).toContain("Verweigert. Nichts wurde ausgeführt.")
    );
    expect(server.decisions).toEqual([{ decision: "reject" }]);

    await unmount?.();
    const withReason = instance(confirmation());
    const second = await mountItem(withReason.fetchImpl);
    await waitFor(() => expect(second.querySelector("textarea")).not.toBeNull());
    const textarea = second.querySelector("textarea");
    if (!textarea) throw new Error("No comment field");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
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
    // The server answers anybody but the addressee that the item does not exist, an instance
    // admin and a holder of `operations.approve` included.
    const server = instance("not_found");
    const container = await mountItem(server.fetchImpl);

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Diesen Vorschlag gibt es nicht mehr oder du darfst ihn nicht sehen."
      )
    );
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

    await waitFor(() =>
      expect(container.textContent).toContain(
        "Nach 7 Tagen ohne deine Antwort abgelaufen. Nichts wurde ausgeführt."
      )
    );
    expect(container.textContent).toContain("Deine Entscheidung wurde nicht gespeichert");
    expect(container.querySelector("[data-decision]")).toBeNull();
    expect(server.decisions).toEqual([{ decision: "approve" }]);
  });
});
