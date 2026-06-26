import { describe, expect, it } from "vitest";
import {
  isComposerBlockedByBackgroundRun,
  isThreadBusy,
  pendingAssistantPresentation,
  shouldShowPendingAssistantMessage
} from "../packages/chat-ui/src/thread-activity";

describe("chat UI thread activity", () => {
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

  it("blocks sending only when the conversation is running outside the local assistant stream", () => {
    expect(isComposerBlockedByBackgroundRun({ conversationRunning: true, threadRunning: false })).toBe(true);
    expect(isComposerBlockedByBackgroundRun({ conversationRunning: true, threadRunning: true })).toBe(false);
    expect(isComposerBlockedByBackgroundRun({ conversationRunning: false, threadRunning: false })).toBe(false);
  });

  it("combines local stream, optimistic send, and persisted conversation activity as one busy signal", () => {
    expect(isThreadBusy({ conversationRunning: true })).toBe(true);
    expect(isThreadBusy({ optimisticPending: true })).toBe(true);
    expect(isThreadBusy({ threadRunning: true })).toBe(true);
    expect(isThreadBusy({})).toBe(false);
  });
});
