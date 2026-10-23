// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  readLastDockConversation,
  storeLastDockConversation,
  useUnreadableDockConversation,
  useWorkspaceDock
} from "./support/chat-ui";

it("replaces an unreadable conversation with an empty open dock and forgets its identity", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const keepDraft = vi.fn();
  const routes = vi.fn();
  const gone = Object.assign(new Error("Not found"), { status: 404 });
  storeLastDockConversation("conv_foreign");
  let seen: ReturnType<typeof useWorkspaceDock>["dock"] | undefined;
  function Shell() {
    const [chat, setChat] = useState<string | undefined>("conv_foreign");
    const { dock } = useWorkspaceDock({
      route: { kind: "build-kind", assetKind: "agents" },
      chat,
      onRouteChange: (route, options) => {
        routes(route, options);
        setChat(options?.chat);
      }
    });
    useUnreadableDockConversation({ dock, docked: true, error: gone, keepDraft });
    seen = dock;
    return createElement("div", { "data-open": dock.open }, dock.conversationId ?? "New chat");
  }
  try {
    act(() => root.render(createElement(Shell)));
    expect(seen?.open).toBe(true);
    expect(seen?.conversationId).toBeUndefined();
    expect(seen?.last).toBeUndefined();
    expect(readLastDockConversation()).toBeUndefined();
    expect(host.textContent).toBe("New chat");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(keepDraft).toHaveBeenCalledExactlyOnceWith("conv_foreign");
    expect(routes).toHaveBeenCalledExactlyOnceWith(
      { kind: "build-kind", assetKind: "agents" },
      { chat: undefined, replace: true }
    );
  } finally {
    act(() => root.unmount());
    storeLastDockConversation(undefined);
    vi.unstubAllGlobals();
  }
});
