// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"enableIframePageLoading":true,"disableIframePageLoading":false}}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_BRIDGE_MARK, APP_BRIDGE_VERSION } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { PageHostProvider } from "@work-shape/catalyst-chat-ui/pages";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { inboxListQueryKey, LivePagePreview, WorkspaceApiClientProvider } from "./support/chat-ui";

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

const theme = {
  surfaceColor: "#ffffff",
  backgroundColor: "#f6f6f4",
  textColor: "#1b1b1a",
  mutedTextColor: "#6b6b68",
  borderColor: "#e3e3df",
  accentColor: "#2f6fed",
  accentStrongColor: "#1f4fb8"
};

it("the mounted preview turns a held action into an overlay, blocks its iframe, and restores access on Close", async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          runId: "opr_held",
          status: "pending_approval"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
  );
  vi.stubGlobal("fetch", fetch);
  const queries = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } }
  });
  queries.setQueryData(inboxListQueryKey(API, "standalone", "mine"), []);
  await act(async () =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(
            QueryClientProvider,
            { client: queries },
            createElement(
              WorkspaceApiClientProvider,
              { apiBaseUrl: API, children: null },
              createElement(
                PageHostProvider,
                {
                  viewer: { kind: "member", id: "anna", displayName: "Anna" },
                  workspace: null,
                  theme,
                  mode: "light",
                  conversationId: undefined,
                  children: null
                },
                createElement(LivePagePreview, {
                  title: "Preview",
                  pageId: "app-one",
                  number: 1,
                  session: "session-one",
                  url: "about:blank",
                  address: {
                    url: `${API}/content/files-one/token/`,
                    fileSetId: "files-one",
                    pageSessionId: "session-one"
                  }
                })
              )
            )
          )
        )
      )
    )
  );
  const iframe = host.querySelector("iframe");
  expect(iframe).not.toBeNull();
  expect(iframe?.parentElement?.hasAttribute("inert")).toBe(false);
  const page = { postMessage: vi.fn() };
  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: { length: 1, 0: page }
  });
  const message = new MessageEvent("message", {
    origin: "null",
    data: {
      [APP_BRIDGE_MARK]: APP_BRIDGE_VERSION,
      type: "action",
      session: "session-one",
      requestId: "r1",
      name: "send",
      input: {}
    }
  });
  Object.defineProperty(message, "source", { value: page });
  await act(async () => {
    window.dispatchEvent(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-testid="frame-approval-wait"]')).not.toBeNull();
  expect(iframe?.parentElement?.hasAttribute("inert")).toBe(true);
  expect(iframe?.isConnected).toBe(true);
  const close = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Close"
  );
  expect(close).toBeDefined();
  await act(async () => close?.click());
  expect(host.querySelector('[data-testid="frame-approval-wait"]')).toBeNull();
  expect(iframe?.parentElement?.hasAttribute("inert")).toBe(false);
});
