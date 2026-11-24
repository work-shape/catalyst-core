import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { pageSurfaceRendering } from "@work-shape/catalyst-chat-ui/pages";
import { SurfaceSlotFrame } from "./support/chat-ui";
import { renderToStaticMarkup } from "./chat-ui-render-harness";

type FrameProps = Parameters<typeof SurfaceSlotFrame>[0];
type Surface = FrameProps["surface"];

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
  it("renders a tool display with its own actions", () => {
    const markup = renderFrame(toolDisplay);
    expect(markup).toContain("kind action");
    expect(markup).toContain("display content");
    expect(markup).not.toContain("This content cannot be shown yet.");
  });

  it("renders a Page through its renderer, with the revision it names", () => {
    // Fails without the Page renderer: the frame showed the sentence of a kind it cannot show.
    const page: Surface = {
      kind: "page",
      key: "page:page-1:set-2",
      title: "Offer comparison",
      path: "offers",
      conversationId: "conv-1",
      pageId: "page-1",
      fileSetId: "set-2"
    };
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
    expect(markup).toContain("the revision");
    expect(markup).not.toContain("This content cannot be shown yet.");
    expect(pageSurfaceRendering(page).content).toMatchObject({
      key: "page:page-1:set-2",
      props: { conversationId: "conv-1", pageId: "page-1", fileSetId: "set-2" }
    });
  });

  it("shows the frame with a sentence for a kind its renderers do not render", () => {
    const markup = renderToStaticMarkup(
      createElement(SurfaceSlotFrame, {
        surface: toolDisplay,
        renderers: {},
        mode: "beside",
        onClose() {},
        onShowChat() {},
        onToggleFullscreen() {}
      })
    );
    expect(markup).toContain("This content cannot be shown yet.");
  });

  it("offers fullscreen and close beside, Show chat in fullscreen, Show chat alone while covering", () => {
    const beside = renderFrame(toolDisplay, "beside");
    expect(beside).toContain('aria-label="View fullscreen"');
    expect(beside).toContain('aria-label="Close display panel"');
    expect(beside).not.toContain("Show chat");

    const fullscreen = renderFrame(toolDisplay, "fullscreen");
    expect(fullscreen).toContain("Show chat");
    expect(fullscreen).toContain('aria-label="Exit fullscreen"');

    const covering = renderFrame(toolDisplay, "covering");
    expect(covering).toContain("Show chat");
    expect(covering).not.toContain("fullscreen");
    expect(covering).not.toContain("Close display panel");
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
    expect(markup).not.toContain("Show chat");
  });
});
