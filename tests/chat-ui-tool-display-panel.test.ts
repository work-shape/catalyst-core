import { describe, expect, it } from "vitest";
import { createToolDisplayPanelAutoShowTracker } from "../packages/chat-ui/src/tool-display-panel";

describe("chat UI tool display panel", () => {
  it("auto-opens each display key once", () => {
    const tracker = createToolDisplayPanelAutoShowTracker();

    expect(tracker.shouldAutoShow("review:call_1")).toBe(true);
    expect(tracker.shouldAutoShow("review:call_1")).toBe(false);
    expect(tracker.shouldAutoShow("review:call_2")).toBe(true);
  });
});
