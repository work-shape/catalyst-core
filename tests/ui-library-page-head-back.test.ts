// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Badge, PageHeader, PageHeaderBack, UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";

// happy-dom lays nothing out, so the widths a browser measured in a phone's head are given here:
// the row, the name, and the text of the way back. The name stands whole while the text is
// gone; with the text back it is cut, as it was where the chips after the name did not give way.
const ROW_WIDTH = 358;
const NAME_WIDTH = 148;
const CUT_NAME_WIDTH = 81;
const BACK_TEXT_WIDTH = 39;

const textGone = (node: Element) => node.closest("[data-back-text-gone]") !== null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.tagName === "H1" ? NAME_WIDTH : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.tagName !== "H1") return 0;
    return textGone(this) ? NAME_WIDTH : CUT_NAME_WIDTH;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const back = this.querySelector(":scope > [data-slot=page-header-back-text]");
    const width = this.classList.contains("group/page-header-row")
      ? ROW_WIDTH
      : this.tagName === "H1"
        ? textGone(this)
          ? NAME_WIDTH
          : CUT_NAME_WIDTH
        : this.dataset.slot === "page-header-back-text"
          ? BACK_TEXT_WIDTH
          : back !== null
            ? textGone(this)
              ? 0
              : BACK_TEXT_WIDTH
            : 0;
    return DOMRect.fromRect({ width, height: 32 });
  });
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// The page of a Data Store never published, at 390 px: its head has the way back, a line of
// facts and the "not published" chip. Bringing the text of the way back cut the name, which
// took the text away again, in every render, until React gave up and the page was gone.
describe("the way back of a detail head", () => {
  it("settles where bringing its text back would cut the name again", () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() =>
      root?.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsDe },
          createElement(PageHeader, {
            variant: "detail",
            back: createElement(PageHeaderBack, {
              label: "Zurück zu Data Stores",
              href: "/build/data-stores",
              children: "Data Stores"
            }),
            title: "Orders 6dd383d5",
            meta: "Persönlich",
            state: createElement(Badge, { tone: "warning" }, "Nicht veröffentlicht")
          })
        )
      )
    );

    expect(errors).not.toHaveBeenCalled();
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Orders 6dd383d5");
    // The name stands whole beside the arrow alone.
    expect(heading && textGone(heading)).toBe(true);
  });
});
