import { describe, expect, it } from "vitest";
import {
  formatElapsedSeconds,
  formatWorkHistoryLabel
} from "../packages/chat-ui/src/elapsed-time";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { AssistantActivityStatus } from "../packages/chat-ui/src/assistant-activity-status";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { ToolActivityLabelsProvider } from "../packages/chat-ui/src/tool-activity";
import {
  findRunActivity,
  isComposerBlockedByActiveRun,
  isThreadBusy,
  shouldShowCancelAction,
  shouldShowRunActivity
} from "../packages/chat-ui/src/thread-activity";

describe("chat UI thread activity", () => {
  it("shows the activity row for the whole busy window, whatever the parts look like", () => {
    expect(shouldShowRunActivity({ conversationRunning: true })).toBe(true);
    expect(shouldShowRunActivity({ optimisticPending: true })).toBe(true);
    expect(shouldShowRunActivity({ threadRunning: true })).toBe(true);
  });

  it("hides the activity row only when the thread is idle", () => {
    expect(shouldShowRunActivity({})).toBe(false);
    expect(
      shouldShowRunActivity({
        conversationRunning: false,
        optimisticPending: false,
        threadRunning: false
      })
    ).toBe(false);
  });

  it("reports the tool that is currently executing", () => {
    expect(
      findRunActivity([
        { type: "text", text: "Ich sehe mir das an" },
        { type: "tool-call", toolName: "documents.check", status: { type: "complete" } },
        { type: "tool-call", toolName: "structured_data.publish", status: { type: "running" } }
      ])
    ).toEqual({ kind: "tool", toolName: "structured_data.publish" });
  });

  it("reports the executing tool from thread-level parts, which carry no status", () => {
    expect(
      findRunActivity([
        { type: "tool-call", toolName: "documents.check", result: { ok: true } },
        { type: "tool-call", toolName: "structured_data.publish" }
      ])
    ).toEqual({ kind: "tool", toolName: "structured_data.publish" });
  });

  it("keeps naming a trailing tool call even when it already carries a result", () => {
    expect(
      findRunActivity([
        { type: "text", text: "Ich prüfe das" },
        { type: "tool-call", toolName: "documents.check", result: { ok: true } }
      ])
    ).toEqual({ kind: "tool", toolName: "documents.check" });
  });

  it("reports no tool once the run has moved past its tool calls", () => {
    expect(
      findRunActivity([
        { type: "tool-call", toolName: "documents.check", status: { type: "complete" } },
        { type: "text", text: "Die Dokumente sind lesbar" },
        { type: "indicator" },
        { type: "step-start" }
      ])
    ).toBeUndefined();
  });

  it("reports reasoning when the run is thinking rather than calling a tool", () => {
    expect(
      findRunActivity([
        { type: "tool-call", toolName: "documents.check", status: { type: "complete" } },
        { type: "reasoning", text: "…" },
        { type: "step-start" }
      ])
    ).toEqual({ kind: "reasoning" });
  });

  it("renders one localized row for the tool being prepared", () => {
    const markup = renderActivityStatus({ preparingToolName: "structured_data.publish" });

    expect(markup).toContain("Bereite Kundendaten vor…");
    expect(markup).toContain("animate-spin");
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
  });

  it("prefers the tool that is actually running over the announced next tool", () => {
    const markup = renderActivityStatus({
      activity: { kind: "tool", toolName: "documents.check" },
      preparingToolName: "structured_data.publish"
    });

    expect(markup).toContain("Bearbeite Unterlagenprüfung…");
    expect(markup).not.toContain("Bereite Kundendaten vor…");
  });

  it("uses neutral wording when the next tool is not known", () => {
    expect(renderActivityStatus({})).toContain("Ich arbeite daran…");
  });

  it("never puts a raw tool name into a localized sentence", () => {
    const markup = renderActivityStatus({
      activity: { kind: "tool", toolName: "workspace.view_document_page" }
    });

    expect(markup).not.toContain("view_document_page");
    expect(markup).not.toContain("View document page");
    expect(markup).toContain("Ich arbeite daran…");
  });

  it("keeps a varied fallback phrase stable for the run", () => {
    const render = () => renderActivityStatus({ variationSeed: "run_42" });

    expect(render()).toBe(render());
    expect(render()).toMatch(
      /Ich arbeite daran|Ich gehe alles durch|Ich schaue es mir an|Es geht voran|Ich bleibe dran|Ich kümmere mich darum|Ich arbeite mich durch|Ich sortiere die Details|Ich mache weiter|Einen Moment noch/u
    );
  });

  it("shows the elapsed run time next to the phrase", () => {
    expect(renderActivityStatus({})).toContain(">0s<");
  });

  it("formats elapsed time consistently for active and completed runs", () => {
    expect(formatElapsedSeconds(42)).toBe("42s");
    expect(formatElapsedSeconds(102)).toBe("1m 42s");
    expect(formatWorkHistoryLabel("Arbeitsverlauf", 102_000)).toBe("Arbeitsverlauf · 1m 42s");
  });

  it("blocks sending whenever the durable conversation run is active", () => {
    expect(isComposerBlockedByActiveRun({ conversationRunning: true })).toBe(true);
    expect(isComposerBlockedByActiveRun({ conversationRunning: false })).toBe(false);
  });

  it("shows cancel for durable runs and pending starts, but not stale local state", () => {
    expect(shouldShowCancelAction({ conversationRunning: true })).toBe(true);
    expect(
      shouldShowCancelAction({
        conversationRunning: false,
        optimisticPending: true,
        threadRunning: true
      })
    ).toBe(true);
    expect(
      shouldShowCancelAction({
        conversationRunning: false,
        optimisticPending: false,
        threadRunning: true
      })
    ).toBe(false);
  });

  it("combines local stream, optimistic send, and persisted conversation activity as one busy signal", () => {
    expect(isThreadBusy({ conversationRunning: true })).toBe(true);
    expect(isThreadBusy({ optimisticPending: true })).toBe(true);
    expect(isThreadBusy({ threadRunning: true })).toBe(true);
    expect(isThreadBusy({})).toBe(false);
  });
});

function renderActivityStatus(props: Parameters<typeof AssistantActivityStatus>[0]): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { locale: "de" },
      createElement(
        ToolActivityLabelsProvider,
        {
          labels: {
            "documents.check": { de: "Unterlagenprüfung", en: "document check" },
            "structured_data.publish": { de: "Kundendaten", en: "customer data" }
          }
        },
        createElement(AssistantActivityStatus, props)
      )
    )
  );
}
