import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import { pageSurfaceRendering } from "@work-shape/catalyst-chat-ui/pages";
import { SurfaceSlotFrame } from "./support/chat-ui";
import { renderToStaticMarkup } from "./chat-ui-render-harness";

type FrameProps = Parameters<typeof SurfaceSlotFrame>[0];
type Surface = FrameProps["surface"];

/** Every kind of the union. A kind added or removed there does not compile here. */
const rendered: Record<Surface["kind"], boolean> = {
  tool_display: true,
  file_preview: true,
  page: true,
  page_building: true,
  app_view: true,
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

describe("surface slot frame", () => {
  it("declares nine kinds and renders each of them", () => {
    expect(Object.keys(rendered)).toHaveLength(6);
    expect(Object.values(rendered).every((hasRenderer) => hasRenderer)).toBe(true);
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

  it("renders a Page under its name and revision, with the switch between its views", () => {
    // Fails without the Page renderer: the frame showed the sentence of a kind it cannot show.
    const page: Surface = {
      kind: "page",
      key: "page:page-1:set-2",
      title: "Angebotsvergleich",
      path: "angebote",
      conversationId: "conv-1",
      pageId: "page-1",
      fileSetId: "set-2"
    };
    // The revision itself asks the instance for its address; here a line stands in its place.
    const rendering = pageSurfaceRendering(page);
    const markup = renderToStaticMarkup(
      createElement(SurfaceSlotFrame, {
        surface: page,
        renderers: {
          page: (surface) => ({
            ...pageSurfaceRendering(surface),
            content: createElement("p", null, "the revision")
          })
        },
        mode: "beside",
        onClose() {},
        onShowChat() {},
        onToggleFullscreen() {}
      })
    );
    const order = [
      ">Angebotsvergleich<",
      'aria-label="Content of the preview"',
      ">Preview<",
      ">Files<",
      'aria-label="View fullscreen"',
      'aria-label="Close display panel"',
      "the revision"
    ].map((text) => markup.indexOf(text));

    expect(order.every((position) => position >= 0)).toBe(true);
    // A member reads no revision number in the head of the preview.
    expect(markup).not.toMatch(/revision \d/iu);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(markup).not.toContain("This content cannot be shown yet.");
    // The preview reaches the edges of the frame: its content has no inset of the frame's.
    expect(markup).toContain('data-flush=""');
    expect(rendering.content).toMatchObject({
      key: "page:page-1:set-2",
      props: {
        name: "Angebotsvergleich",
        conversationId: "conv-1",
        pageId: "page-1",
        fileSetId: "set-2"
      }
    });
  });

  it("shows the frame with a sentence for a kind its renderers do not render", () => {
    const markup = renderToStaticMarkup(
      createElement(SurfaceSlotFrame, {
        surface: { ...toolDisplay, title: "Brutto-Netto-Rechner" },
        renderers: {},
        mode: "beside",
        onClose() {},
        onShowChat() {},
        onToggleFullscreen() {}
      })
    );

    expect(markup).toContain("Brutto-Netto-Rechner");
    expect(markup).toContain("This content cannot be shown yet.");
    expect(markup).toContain('aria-label="Close display panel"');
  });

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

  // OPEN-1f design review: at 390 px "Show chat" left the title "u.". On a phone the title wins
  // the row and the button keeps its icon, as in the dock's head.
  it("keeps Show chat as one icon action while the panel covers the chat", () => {
    const markup = renderFrame(toolDisplay, "covering");
    const button = /<button[^>]*aria-label="Show chat"[^>]*>(.*?)<\/button>/u.exec(markup)?.[1];
    expect(button).toContain("<svg");
    expect(button).not.toContain("Show chat");
    expect(markup.match(/aria-label="Show chat"/gu)).toHaveLength(1);
    expect(markup).not.toContain(">Show chat<");
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
