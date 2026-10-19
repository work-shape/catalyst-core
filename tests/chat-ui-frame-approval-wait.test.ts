// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { item } from "./chat-ui-inbox-harness";
import {
  ApprovalRevisionHostProvider,
  FrameApprovalWait,
  inboxListQueryKey,
  WorkspaceApiClientProvider
} from "./support/chat-ui";

// DAILY-WINS 9: an App's call that waits for an approval is said over the frame, with the way
// to the request, until the request is decided or the person closes the notice. The bridge's
// side, that a held call reaches the host, is in `chat-ui-frame-calls.test.ts`.

const API = "https://api.example.test";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const held = (status: ApprovalRequestView["status"], runId = "opr_held") =>
  item({
    id: "apr_held",
    kind: "operation_call",
    status,
    preview: {
      runId,
      operation: "app.action",
      effect: "changing",
      actor: { kind: "user", id: "user-anna", label: "Anna Beispiel" },
      origin: { kind: "user" },
      inputs: []
    }
  });

/** The page's side: it holds the wait as the frame does and lets it end. */
function Page({ onEnd }: { onEnd(): void }) {
  const [waiting, setWaiting] = useState(true);
  const end = useCallback(() => {
    setWaiting(false);
    onEnd();
  }, [onEnd]);
  return waiting ? createElement(FrameApprovalWait, { runId: "opr_held", onEnd: end }) : null;
}

async function show(requests: ApprovalRequestView[] | undefined, locale: "en" | "de" = "en") {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } }
  });
  if (requests) client.setQueryData(inboxListQueryKey(API, "standalone", "mine"), requests);
  const onEnd = vi.fn();
  const openRoute = vi.fn();
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale, children: null },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: API, children: null },
              createElement(
                ApprovalRevisionHostProvider,
                {
                  value: {
                    currentUserId: "user-anna",
                    personalWorkspaceAgentName: () => undefined,
                    startRevision: () => undefined,
                    agentDisplayName: () => undefined,
                    openConversation: () => undefined,
                    openRoute
                  }
                },
                createElement(Page, { onEnd })
              )
            )
          )
        )
      )
    )
  );
  return { client, onEnd, openRoute };
}

const overlay = () => host.querySelector('[data-testid="frame-approval-wait"]');

describe("the notice over a frame whose call waits", () => {
  it("says the call waits and leads to its request in the Inbox", async () => {
    const { openRoute } = await show([held("pending")]);
    expect(overlay()?.getAttribute("role")).toBe("status");
    expect(overlay()?.textContent).toContain("This action is waiting for an approval.");
    const link = [...(overlay()?.querySelectorAll("a") ?? [])].find(
      (anchor) => anchor.textContent === "Open in Inbox"
    );
    expect(link?.getAttribute("href")).toContain("apr_held");
    await act(async () => link?.click());
    expect(openRoute).toHaveBeenCalledWith({ kind: "inbox-item", itemId: "apr_held" });
  });

  it("leads to the Inbox while the person's list does not name the request yet", async () => {
    await show([held("pending", "opr_other")], "de");
    expect(overlay()?.textContent).toContain("Diese Aktion wartet auf eine Freigabe.");
    const link = [...(overlay()?.querySelectorAll("a") ?? [])].find(
      (anchor) => anchor.textContent === "Im Eingang öffnen"
    );
    expect(link?.getAttribute("href")).not.toContain("apr_held");
  });

  it("goes once the request is decided", async () => {
    const decided = await show([held("pending")]);
    expect(overlay()).not.toBeNull();
    await act(async () => {
      decided.client.setQueryData(inboxListQueryKey(API, "standalone", "mine"), [held("rejected")]);
      // The query tells its readers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(overlay()).toBeNull();
    expect(decided.onEnd).toHaveBeenCalledTimes(1);
  });

  it("goes when the person closes it", async () => {
    const closed = await show([held("pending")]);
    const close = [...(overlay()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Close"
    );
    await act(async () => close?.click());
    expect(overlay()).toBeNull();
    expect(closed.onEnd).toHaveBeenCalledTimes(1);
  });
});
