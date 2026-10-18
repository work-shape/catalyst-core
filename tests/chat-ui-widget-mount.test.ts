// @vitest-environment happy-dom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mountChatWidget } from "@work-shape/catalyst-chat-ui/widget";
import { CONDITION_WAIT_MS } from "./support/assertions";

// UI-FIX-1: the widget takes every prop of the shell, and the shell is given each of them.

describe("mountChatWidget", () => {
  it("hands the shell the props beside its container", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // The instance refuses every call: the shell shows its sign-in or session check.
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { code: "UNAUTHORIZED", message: "refused" } }, { status: 401 })
    );
    const container = document.createElement("div");
    document.body.append(container);
    const onThemeModeChange = vi.fn();
    let widget: ReturnType<typeof mountChatWidget> | undefined;
    try {
      await act(async () => {
        widget = mountChatWidget({
          container,
          apiBaseUrl: "https://chat.example.com",
          token: "token",
          onThemeModeChange
        });
      });
      await vi.waitFor(() => expect(onThemeModeChange).toHaveBeenCalled(), {
        timeout: CONDITION_WAIT_MS
      });
      expect(["light", "dark"]).toContain(onThemeModeChange.mock.calls[0]?.[0]);
    } finally {
      await act(async () => {
        widget?.unmount();
      });
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
