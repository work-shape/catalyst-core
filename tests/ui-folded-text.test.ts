// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoldedText, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// A folded text shows three lines. The browser's line clamp puts "…" where it cuts, also
// behind a full stop that ends the third line, which reads "Keep a copy.…" (COPY-1). happy-dom
// lays nothing out, so each line of the text is 20 px high here, a line being what lies
// between two line breaks, and a range ends at the bottom of the line its last character is on.

const LINE = 20;

const linesOf = (element: Element) => (element.textContent ?? "").split("\n").length;

function rangeBottom(range: Range): number {
  const before = (range.endContainer.textContent ?? "").slice(0, range.endOffset - 1);
  return before.split("\n").length * LINE;
}

class StillResizeObserver {
  observe() {}
  disconnect() {}
}

describe("FoldedText", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", StillResizeObserver);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return linesOf(this) * LINE;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return Math.min(linesOf(this), 3) * LINE;
    });
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return DOMRect.fromRect({ y: 0, height: rangeBottom(this) });
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (text: string) =>
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(FoldedText, null, text)
        )
      )
    );
  const value = () => container.querySelector("span > span[id]");
  const toggle = () => container.querySelector("button");

  it("cuts after a full stop that ends the third line without a mark", () => {
    render(
      "Check the document before you sign.\nRead the terms carefully.\nKeep a copy.\nFurther notes follow in the next section."
    );

    expect(toggle()?.textContent).toBe("Show more");
    expect(value()?.className).toContain("max-h-[3lh] overflow-hidden");
    expect(value()?.className).not.toContain("line-clamp-3");
  });

  it("marks a cut inside a sentence with one …", () => {
    render("Check the document before you sign.\nRead the terms\ncarefully and keep\na copy.");

    expect(toggle()?.textContent).toBe("Show more");
    expect(value()?.className).toContain("line-clamp-3");
    expect(value()?.className).not.toContain("max-h-[3lh]");
  });

  it("measures a new text of the same height again", async () => {
    const stop =
      "Check the document before you sign.\nRead the terms carefully.\nKeep a copy.\nFurther notes follow.";
    const open = "Check the document before you sign.\nRead the terms\ncarefully and keep\na copy.";
    render(stop);
    expect(value()?.className).toContain("max-h-[3lh]");

    // Four lines each: no resize is seen, only the changed text.
    await act(async () => render(open));
    expect(value()?.className).toContain("line-clamp-3");

    await act(async () => render(stop));
    expect(value()?.className).toContain("max-h-[3lh]");
  });

  it("shows a text of three lines whole, with no control", () => {
    render("Check the document before you sign.\nRead the terms carefully.\nKeep a copy.");

    expect(toggle()).toBeNull();
  });

  it("unfolds whole and folds back without a mark behind the full stop", () => {
    render(
      "Check the document before you sign.\nRead the terms carefully.\nKeep a copy.\nFurther notes follow."
    );
    act(() => toggle()?.click());

    expect(toggle()?.textContent).toBe("Show less");
    expect(value()?.className).not.toMatch(/line-clamp-3|max-h-\[3lh\]/u);

    act(() => toggle()?.click());

    expect(value()?.className).toContain("max-h-[3lh] overflow-hidden");
  });
});
