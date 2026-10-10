import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import { SurfaceSlotFrame } from "../packages/chat-ui/src/surface/surface-slot";
import { renderToStaticMarkup } from "./chat-ui-render-harness";

type FrameProps = Parameters<typeof SurfaceSlotFrame>[0];
type Surface = FrameProps["surface"];

/** Every kind of the union. A kind added or removed there does not compile here. */
const rendered: Record<Surface["kind"], boolean> = {
  tool_display: true,
  file_preview: true,
  page: false,
  app_view: false,
  app_edit: false,
  workflow_canvas: false,
  inbox_item: true
};

function renderFrame(surface: Surface, mode: FrameProps["mode"] = "beside"): string {
  return renderToStaticMarkup(
    createElement(SurfaceSlotFrame, {
      surface,
      mode,
      onClose() {},
      onShowChat() {},
      onToggleFullscreen() {}
    })
  );
}

const toolDisplay: Surface = {
  kind: "tool_display",
  key: "display:1",
  title: "Forecast",
  subtitle: "Weather",
  headerActions: createElement("span", null, "kind action"),
  node: createElement("p", null, "display content")
};

/** A surface of a kind that carries no source fields yet. */
function bareSurface(kind: string): Surface | undefined {
  const base = { key: `${kind}:1`, title: "Brutto-Netto-Rechner" };
  switch (kind) {
    case "page":
    case "app_view":
    case "app_edit":
    case "workflow_canvas":
      return { kind, ...base };
    default:
      return undefined;
  }
}

describe("surface slot frame", () => {
  it("declares seven kinds and renders three of them", () => {
    expect(Object.keys(rendered)).toHaveLength(7);
    expect(
      Object.entries(rendered)
        .filter(([, hasRenderer]) => hasRenderer)
        .map(([kind]) => kind)
    ).toEqual(["tool_display", "file_preview", "inbox_item"]);
  });

  it("renders a tool display and a file preview with their own actions", () => {
    const filePreview: Surface = { ...toolDisplay, kind: "file_preview", title: "report.pdf" };

    for (const surface of [toolDisplay, filePreview]) {
      const markup = renderFrame(surface);
      expect(markup).toContain(surface.title);
      expect(markup).toContain("Weather");
      expect(markup).toContain("kind action");
      expect(markup).toContain("display content");
      expect(markup).not.toContain("This content cannot be shown yet.");
    }
  });

  it.each(["page", "app_view", "app_edit", "workflow_canvas"])(
    "shows the frame with a sentence for %s, which has no renderer",
    (kind) => {
      const surface = bareSurface(kind);
      if (!surface) {
        throw new Error(`${kind} is not a kind without source fields`);
      }
      const markup = renderFrame(surface);

      expect(markup).toContain("Brutto-Netto-Rechner");
      expect(markup).toContain("This content cannot be shown yet.");
      expect(markup).toContain('aria-label="Close display panel"');
    }
  );

  it("offers fullscreen and close beside the conversation, and no Show chat", () => {
    const markup = renderFrame(toolDisplay, "beside");

    expect(markup).toContain('aria-label="View fullscreen"');
    expect(markup).toContain('aria-label="Close display panel"');
    expect(markup).not.toContain("Show chat");
  });

  it("adds Show chat in fullscreen", () => {
    const markup = renderFrame(toolDisplay, "fullscreen");

    expect(markup).toContain("Show chat");
    expect(markup).toContain('aria-label="Exit fullscreen"');
    expect(markup).toContain('aria-label="Close display panel"');
  });

  it("offers Show chat alone while it covers the main area", () => {
    const markup = renderFrame(toolDisplay, "covering");

    expect(markup).toContain("Show chat");
    expect(markup).not.toContain("fullscreen");
    expect(markup).not.toContain("Close display panel");
  });

  // Fails without `under`: the frame knew the chat as the only thing a surface covers.
  it("names what an area's surface covers when that is not the chat", () => {
    const markup = renderToStaticMarkup(
      createElement(SurfaceSlotFrame, {
        surface: toolDisplay,
        mode: "covering",
        under: { label: "Show list", icon: createElement("i", { "data-under-icon": "" }) },
        onClose() {},
        onShowChat() {},
        onToggleFullscreen() {}
      })
    );

    expect(markup).toContain("Show list");
    expect(markup).toContain("data-under-icon");
    expect(markup).not.toContain("Show chat");
    expect(markup).not.toContain("lucide-message-square");
  });

  it("puts the header slots in one order", () => {
    const markup = renderFrame(toolDisplay, "fullscreen");
    const order = ["Show chat", "Forecast", "Weather", "kind action", "Exit fullscreen", "Close"];
    const positions = order.map((text) => markup.indexOf(text));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("has its two texts and the controls' labels in German", () => {
    const de = createTranslationContext("de");

    expect(de.t("nav.showChat")).toBe("Chat anzeigen");
    expect(de.t("nav.surfaceNoRenderer")).toBe("Dieser Inhalt kann noch nicht angezeigt werden.");
    expect(de.t("viewFullscreen")).toBe("Im Vollbild anzeigen");
    expect(de.t("exitFullscreen")).toBe("Vollbild schließen");
  });
});
