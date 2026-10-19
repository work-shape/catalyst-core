// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { ToolDecision } from "@work-shape/catalyst-chat-ui/tool-decision-model";
import { ToolDecisionCardView } from "@work-shape/catalyst-chat-ui/tool-decision-card";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { idleActions, INBOX_API_BASE_URL, InboxItemView, item } from "./chat-ui-inbox-harness";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";

// ACCEPT-2d C-8: a held change of a Data Store row named it by its id alone, so the person who
// confirmed could not tell which row it was. The card now reads exactly the keyed rows through
// the store's ordinary query, with the reader's own rights, and shows them as they are now. A
// read the instance refuses says so instead of showing nothing.

const queryPath = apiOperations["data_stores.query"].path.replace(":store", "holidays");
const input = {
  table: "holiday_requests",
  rows: [
    { key: { id: 7 }, set: { ends_on: "2026-11-05" } },
    { key: { id: 8 }, set: { approved: true } }
  ]
};
const alex = { id: "7", employee: "Alex Weber", ends_on: "2026-11-06", approved: false };

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

/** The instance: answers the query with `rows`, or refuses it. Records every query. */
function stubInstance(
  answer: { rows: Record<string, unknown>[]; truncated?: boolean } | "refused"
) {
  const queries: unknown[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Request(request, init);
    if (sent.method === "POST" && new URL(sent.url).pathname === queryPath) {
      queries.push(await sent.json());
      return answer === "refused"
        ? Response.json(
            { error: { code: "FORBIDDEN", message: "No right to read these rows." } },
            { status: 403 }
          )
        : Response.json({ columns: [], rows: answer.rows, truncated: answer.truncated ?? false });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  });
  return queries;
}

async function mount(node: ReactNode, locale: "en" | "de") {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(WorkspaceApiClientProvider, {
          apiBaseUrl: INBOX_API_BASE_URL,
          children: createElement(
            UiRoot,
            { mode: "light", labels: locale === "de" ? uiLabelsDe : uiLabelsEn },
            createElement(TranslationProvider, { locale, children: null }, node)
          )
        })
      )
    );
  });
}

const decision: ToolDecision = {
  operationRunId: "oprun_1",
  operationId: "data_store.holidays.update",
  mode: "confirm",
  targetTitle: "Holiday requests",
  inputPreview: input,
  expiresAt: "2026-10-19T18:30:00Z",
  toolCallId: "call_1"
};

/** The confirmation in the conversation. */
const inChat = () =>
  createElement(ToolDecisionCardView, {
    decision,
    title: "Change rows",
    toolName: "data_store_holidays_update",
    answer: { decide: () => undefined, pending: false, decided: undefined, failure: undefined }
  });

/** The same call waiting in the Inbox of the person who confirms it. */
const inInbox = () =>
  createElement(InboxItemView, {
    state: {
      status: "ready",
      request: item({
        kind: "operation_call",
        summary: "data_store.holidays.update",
        canDecide: true,
        payload: { runId: "opr_1", input },
        preview: {
          runId: "opr_1",
          operation: "data_store.holidays.update",
          effect: "changing",
          targetTitle: "Holiday requests",
          actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
          origin: { kind: "agent", agentName: "hr-agent" },
          inputs: [{ key: "table", value: "holiday_requests" }]
        }
      })
    },
    actions: idleActions
  });

const block = (label: string) =>
  document.querySelector(`[data-input-key="${label}"]`)?.textContent ?? undefined;

describe.each([
  ["the confirmation in the conversation", inChat],
  ["the Inbox item", inInbox]
])("a held change of Data Store rows, in %s", (_where, card) => {
  it("reads exactly the keyed rows, bound and quoted, and shows each as it is now", async () => {
    const queries = stubInstance({ rows: [alex] });
    await mount(card(), "en");

    await vi.waitFor(() => expect(block("Row 1, as it is now")).toContain("Alex Weber"), {
      timeout: CONDITION_WAIT_MS
    });
    expect(queries).toEqual([
      {
        sql: 'select * from "holiday_requests" where ("id" = $1) or ("id" = $2)',
        parameters: [7, 8]
      }
    ]);
    const now = block("Row 1, as it is now");
    expect(now).toContain("ends_on: 2026-11-06");
    expect(now).toContain("approved: No");
    expect(block("Row 1, new values")).toContain("ends_on: 2026-11-05");
    // The second row is no longer there: the card says so rather than leave its block out unsaid.
    expect(block("Row 2, as it is now")).toBeUndefined();
    expect(document.querySelector('[data-testid="row-change-gone"]')?.textContent).toBe(
      "Row 2 is no longer in the table."
    );
    expect(document.querySelector('[data-testid="row-change-unavailable"]')).toBeNull();
  });

  it("says in the reader's language that the rows could not be read when the instance refuses", async () => {
    stubInstance("refused");
    await mount(card(), "de");

    const said = await vi.waitFor(
      () => {
        const found = document.querySelector('[data-testid="row-change-unavailable"]');
        if (!found) throw new Error("no notice yet");
        return found.textContent;
      },
      { timeout: CONDITION_WAIT_MS }
    );
    expect(said).toBe(
      "Die Datensätze ließen sich gerade nicht lesen. Der Schlüssel zeigt, um welchen Datensatz es geht."
    );
    // The key still shows which row the call is about; nothing claims what the row holds.
    expect(block("Datensatz 1, Schlüssel")).toContain("id: 7");
    expect(block("Datensatz 1, wie er jetzt ist")).toBeUndefined();
  });

  // A cap may have left out a keyed row: the card never calls a row gone on such an answer.
  it("says the rows could not be read when a cap ended the answer, and calls no row gone", async () => {
    stubInstance({ rows: [alex], truncated: true });
    await mount(card(), "en");

    await vi.waitFor(
      () => expect(document.querySelector('[data-testid="row-change-unavailable"]')).not.toBeNull(),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(document.querySelector('[data-testid="row-change-gone"]')).toBeNull();
    expect(block("Row 1, as it is now")).toBeUndefined();
    expect(block("Row 1, key")).toContain("id: 7");
  });
});

it("keeps a key it cannot bind out of any statement, and reads nothing for it", async () => {
  const queries = stubInstance({ rows: [alex] });
  await mount(
    createElement(ToolDecisionCardView, {
      decision: {
        ...decision,
        inputPreview: {
          table: "holiday_requests",
          rows: [{ key: { id: { $gt: 0 } }, set: { approved: true } }]
        }
      },
      title: "Change rows",
      toolName: "data_store_holidays_update",
      answer: { decide: () => undefined, pending: false, decided: undefined, failure: undefined }
    }),
    "en"
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  expect(queries).toEqual([]);
  expect(block("Row 1, key")).toContain('id: {"$gt":0}');
  // Nothing was asked, so nothing claims a read failed.
  expect(document.querySelector('[data-testid="row-change-unavailable"]')).toBeNull();
});
