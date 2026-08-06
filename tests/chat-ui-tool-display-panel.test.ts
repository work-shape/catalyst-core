import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import { TranslationProvider } from "../packages/chat-ui/src/i18n";
import {
  createToolDisplayPanelAutoShowTracker,
  ToolDisplayPanelFrame
} from "../packages/chat-ui/src/tool-display-panel";

describe("chat UI tool display panel", () => {
  it("auto-opens each display key once", () => {
    const tracker = createToolDisplayPanelAutoShowTracker();

    expect(tracker.shouldAutoShow("review:call_1")).toBe(true);
    expect(tracker.shouldAutoShow("review:call_1")).toBe(false);
    expect(tracker.shouldAutoShow("review:call_2")).toBe(true);
  });

  it("renders localized fullscreen and restore controls", () => {
    const entry = {
      key: "preview:1",
      title: "Preview",
      node: createElement("div")
    };
    const renderFrame = (fullscreen: boolean) =>
      renderToStaticMarkup(
        createElement(
          TranslationProvider,
          { locale: "de" },
          createElement(ToolDisplayPanelFrame, {
            entry,
            fullscreen,
            onClose() {},
            onToggleFullscreen() {}
          })
        )
      );

    expect(renderFrame(false)).toContain('aria-label="Im Vollbild anzeigen"');
    expect(renderFrame(true)).toContain('aria-label="Vollbild schließen"');
  });
});
