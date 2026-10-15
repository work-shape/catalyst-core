import { createElement } from "react";
import type { AppAction } from "@work-shape/catalyst-api-client";
import {
  appActionLiveOnceOffered,
  AppActionsView,
  type AppActionsLiveOnce
} from "@work-shape/catalyst-chat-ui/apps";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// "Run live once" on the Actions side of a draft (ADR-0031, APP-4): the switch of a changing
// action in each of its states, and to whom and for which call it is offered. The instance
// answers the target each row shows; that is held in tests/app-draft-safe-mode.test.ts.

const noop = () => undefined;

/** `save` as a draft lists it to a writer whose call the policy lets run: simulated. */
const simulated: Extract<AppAction, { kind: "connection" }> = {
  name: "save",
  kind: "connection",
  effect: "changing",
  toolName: "app.orders.save",
  connection: { name: "crm", title: "Kundenkartei" },
  operation: "write_order",
  inputSchema: { type: "object", properties: {} },
  policy: "confirm",
  agentTool: false,
  target: "dry_run"
};
const switchOff: AppActionsLiveOnce = { switching: undefined, failed: undefined, switchOn: noop };

/** The row of `save` as a writer sees it on the Actions side of the draft. */
const rowOf = (action: AppAction, liveOnce: AppActionsLiveOnce = switchOff) =>
  renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale: "en",
      children: createElement(AppActionsView, {
        read: { status: "ready", view: "draft", revision: 4, actions: [action] },
        rights: { write: true },
        onTest: noop,
        liveOnce
      })
    })
  );

describe("Run live once on the Actions side of a draft", () => {
  it("is off while the call is simulated, on once switched, and waits while it switches", () => {
    const off = rowOf(simulated);
    expect(off).toContain('data-run-live-once="off"');
    expect(off).toContain('aria-label="Run save live once"');

    const on = rowOf({ ...simulated, target: "live" });
    expect(on).toContain('data-target="live"');
    expect(on).toContain('data-run-live-once="on"');
    expect(on).toContain("Your next call runs live.");

    expect(rowOf(simulated, { ...switchOff, switching: "save" })).toContain(
      'data-run-live-once="busy"'
    );
    const failed = { action: "save", message: "The draft changed." };
    expect(rowOf(simulated, { ...switchOff, failed })).toContain("The draft changed.");
  });

  it("is not offered where the call would wait for an approval, is refused, or reads", () => {
    for (const policy of ["approval", "deny"] as const) {
      expect(rowOf({ ...simulated, policy }), policy).not.toContain("data-run-live-once");
    }
    const writer = { write: true };
    expect(appActionLiveOnceOffered(simulated, "draft", writer)).toBe(true);
    expect(appActionLiveOnceOffered(simulated, "draft", { write: false })).toBe(false);
    expect(appActionLiveOnceOffered(simulated, "published", writer)).toBe(false);
    expect(appActionLiveOnceOffered({ ...simulated, effect: "reading" }, "draft", writer)).toBe(
      false
    );
    const gone = { ...simulated, unavailable: "connection_missing" as const };
    expect(appActionLiveOnceOffered(gone, "draft", writer)).toBe(false);
  });
});
