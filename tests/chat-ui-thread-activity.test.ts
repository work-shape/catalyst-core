import { describe, expect, it } from "vitest";
import {
  activeAssistantCursorPlacement,
  isComposerBlockedByActiveRun,
  isThreadBusy,
  pendingAssistantPresentation,
  shouldShowCancelAction,
  shouldShowPendingAssistantMessage
} from "../packages/chat-ui/src/thread-activity";

describe("chat UI thread activity", () => {
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
