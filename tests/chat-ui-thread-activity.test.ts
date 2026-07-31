import { describe, expect, it } from "vitest";
import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { AssistantActivityStatus } from "../packages/chat-ui/src/assistant-activity-status";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import { ToolActivityLabelsProvider } from "../packages/chat-ui/src/tool-activity";
import {
  activeAssistantCursorPlacement,
  findLastVisibleAssistantPartIndex,
  isComposerBlockedByActiveRun,
  isThreadBusy,
  pendingAssistantPresentation,
  shouldShowToolGroupActivity,
  shouldShowCancelAction,
  shouldShowPendingAssistantMessage
} from "../packages/chat-ui/src/thread-activity";

describe("chat UI thread activity", () => {
  it("shows activity on the current group while one of its tools is unfinished", () => {
    expect(
      shouldShowToolGroupActivity({
        activeRunMessage: true,
        containsActivePart: true
      })
    ).toBe(true);
  });

  it("keeps the current tool group active between consecutive tool calls", () => {
    expect(
      shouldShowToolGroupActivity({
        activeRunMessage: true,
        containsActivePart: true
      })
    ).toBe(true);
  });

  it("stops the tool-group activity when the run moves on", () => {
    expect(
      shouldShowToolGroupActivity({
        activeRunMessage: true,
        containsActivePart: false
      })
    ).toBe(false);
  });

  it("ignores invisible bookkeeping after the current tool call", () => {
    expect(
      findLastVisibleAssistantPartIndex([
        { type: "tool-call" },
        { type: "indicator" },
        { type: "step-start" }
      ])
    ).toBe(0);
  });

  it("does not animate a historical tool group for the current run", () => {
    expect(
      shouldShowToolGroupActivity({
        activeRunMessage: false,
        containsActivePart: true
      })
    ).toBe(false);
  });

  it("renders one localized spinner label for the tool being prepared", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(
          ToolActivityLabelsProvider,
          {
            labels: {
              "structured_data.publish": {
                de: "Kundendaten",
                en: "customer data"
              }
            }
          },
          createElement(AssistantActivityStatus, { toolName: "structured_data.publish" })
        )
      )
    );

    expect(markup).toContain("Bereite Kundendaten vor…");
    expect(markup).toContain("animate-spin");
    expect(markup.match(/role="status"/gu)).toHaveLength(1);
  });

  it("uses neutral wording when the next tool is not known", () => {
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "de" },
        createElement(AssistantActivityStatus)
      )
    );

    expect(markup).toContain("Ich arbeite daran…");
    expect(markup).not.toContain("Wird vorbereitet…");
  });

  it("keeps a varied fallback phrase stable for the run", () => {
    const render = () =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { locale: "de" },
          createElement(AssistantActivityStatus, { variationSeed: "run_42" })
        )
      );

    expect(render()).toBe(render());
    expect(render()).toMatch(
      /Ich arbeite daran|Ich denke es durch|Ich setze alles zusammen|Ich prüfe die nächsten Schritte|Ich komme voran/u
    );
  });

  it("keeps progress visible after a completed tool surface while the run continues", () => {
    expect(
      activeAssistantCursorPlacement({
        running: true,
        parts: [{ type: "dynamic-tool", status: { type: "complete" } }]
      })
    ).toBe("after");
  });

  it("does not add a second cursor when the current part already shows activity", () => {
    expect(
      activeAssistantCursorPlacement({
        running: true,
        parts: [{ type: "text", text: "Writing now", status: { type: "running" } }]
      })
    ).toBe("hidden");
  });

  it("lets the active tool group own activity without a second status row", () => {
    expect(
      activeAssistantCursorPlacement({
        running: true,
        toolActivityRunning: true,
        parts: [{ type: "dynamic-tool", status: { type: "requires-action" } }]
      })
    ).toBe("hidden");
  });

  it("falls back to one status row when no tool group accepts active tool state", () => {
    expect(
      activeAssistantCursorPlacement({
        activeLastPart: true,
        running: true,
        toolActivityRunning: false,
        parts: [{ type: "tool-call", status: { type: "running" } }]
      })
    ).toBe("after");
  });

  it("does not add a second cursor when the active run keeps its last completed text cursor visible", () => {
    expect(
      activeAssistantCursorPlacement({
        activeLastPart: true,
        running: true,
        parts: [{ type: "text", text: "Writing now", status: { type: "complete" } }]
      })
    ).toBe("hidden");
  });

  it("shows the activity cursor before the first visible assistant part", () => {
    expect(
      activeAssistantCursorPlacement({
        running: true,
        parts: [{ type: "text", text: "", status: { type: "running" } }]
      })
    ).toBe("before");
  });

  it("does not render a fallback cursor after visible assistant content", () => {
    const lastMessage = {
      id: "assistant_1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          status: {
            type: "complete"
          }
        }
      ]
    };

    expect(
      pendingAssistantPresentation({
        conversationRunning: true,
        lastMessage
      })
    ).toBe("hidden");
    expect(shouldShowPendingAssistantMessage({ conversationRunning: true, lastMessage })).toBe(false);
  });

  it("does not render a second pending indicator while the last assistant text part is streaming", () => {
    expect(
      pendingAssistantPresentation({
        conversationRunning: true,
        threadRunning: true,
        lastMessage: {
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Writing now",
              status: {
                type: "running"
              }
            }
          ]
        }
      })
    ).toBe("hidden");
    expect(
      shouldShowPendingAssistantMessage({
        conversationRunning: true,
        threadRunning: true,
        lastMessage: {
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Writing now",
              status: {
                type: "running"
              }
            }
          ]
        }
      })
    ).toBe(false);
  });

  it("shows the initial pending indicator before the first assistant message exists", () => {
    expect(
      shouldShowPendingAssistantMessage({
        optimisticPending: true,
        lastMessage: {
          role: "user",
          parts: [{ type: "text", text: "please check this" }]
        }
      })
    ).toBe(true);
  });

  it("hides the separate pending indicator once the running assistant message owns activity", () => {
    expect(
      pendingAssistantPresentation({
        conversationRunning: true,
        threadRunning: true,
        lastMessage: {
          role: "assistant",
          status: {
            type: "running"
          },
          parts: [{ type: "step-start" }]
        }
      })
    ).toBe("hidden");
  });

  it("hides the separate pending indicator while the assistant-ui thread is running", () => {
    expect(
      pendingAssistantPresentation({
        conversationRunning: true,
        threadRunning: true,
        lastMessage: {
          role: "user",
          parts: [{ type: "text", text: "please check this" }]
        }
      })
    ).toBe("hidden");
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
