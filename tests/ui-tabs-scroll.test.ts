// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Tabs,
  TabsContent,
  TabsLink,
  TabsList,
  TabsNav,
  TabsTrigger,
  UiRoot,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

// A tab row that does not fit scrolls sideways (UI-LIB-1: the Inbox at 390 with a count). It
// fades the edge that hides tabs, keeps its line whole under the fade, and scrolls the selected
// tab into view. happy-dom lays nothing out, so a browser's measures are set here: every tab is
// 100 px wide, the row shows 250 px, and the fade is 16 px.

const TAB_WIDTH = 100;
const ROW_WIDTH = 250;
const values = ["a", "b", "c", "d", "e"];

let host: HTMLDivElement;
let root: Root;

function rowOf(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>('[data-slot="tab-row"]');
}

function tabsIn(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('[role="tab"], a')];
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const row = this.dataset.slot === "tab-row" ? null : rowOf(this);
    const left = row ? tabsIn(row).indexOf(this) * TAB_WIDTH - row.scrollLeft : 0;
    const width = row ? TAB_WIDTH : ROW_WIDTH;
    return DOMRect.fromRect({ x: left, y: 0, width, height: 36 });
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.slot === "tab-row" ? ROW_WIDTH : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.slot === "tab-row" ? tabsIn(this).length * TAB_WIDTH : 0;
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(element: ReactElement) {
  act(() => root.render(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)));
}

function row(): HTMLElement {
  const found = host.querySelector<HTMLElement>('[data-slot="tab-row"]');
  if (!found) {
    throw new Error("no tab row");
  }
  return found;
}

function viewTabs(props: {
  value?: string;
  defaultValue?: string;
  onValueChange?(v: string): void;
}) {
  return createElement(
    Tabs,
    props,
    createElement(
      TabsList,
      { label: "Views" },
      ...values.map((value) =>
        createElement(TabsTrigger, { key: value, value, count: 3 }, `Tab ${value}`)
      )
    ),
    ...values.map((value) => createElement(TabsContent, { key: value, value }, value))
  );
}

describe("a tab row that does not fit", () => {
  it("scrolls the selected tab into view, clear of the fade, when it first shows", () => {
    render(viewTabs({ defaultValue: "d" }));
    // Tab d spans 300 to 400; with 16 px for the fade it shows from 166.
    expect(row().scrollLeft).toBe(400 + 16 - ROW_WIDTH);
  });

  it("leaves a row whose selected tab already shows where it is", () => {
    render(viewTabs({ defaultValue: "a" }));
    expect(row().scrollLeft).toBe(0);
  });

  it("scrolls to the tab selected next, in a row the caller holds the value of", () => {
    const element = (value: string) => viewTabs({ value, onValueChange() {} });
    render(element("a"));
    expect(row().scrollLeft).toBe(0);
    render(element("e"));
    expect(row().scrollLeft).toBe(5 * TAB_WIDTH - ROW_WIDTH);
    render(element("b"));
    expect(row().scrollLeft).toBe(TAB_WIDTH - 16);
  });

  it("scrolls to the tab selected next, in a row that holds its own value", () => {
    render(viewTabs({ defaultValue: "a" }));
    const last = tabsIn(row()).at(-1);
    act(() => {
      last?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(last?.getAttribute("aria-selected")).toBe("true");
    expect(row().scrollLeft).toBe(5 * TAB_WIDTH - ROW_WIDTH);
  });

  it("keeps where the reader scrolled to until another tab is selected", () => {
    const element = (count: number) =>
      createElement(
        Tabs,
        { defaultValue: "a" },
        createElement(
          TabsList,
          { label: "Views" },
          ...values.map((value) => createElement(TabsTrigger, { key: value, value, count }, value))
        )
      );
    render(element(1));
    act(() => {
      row().scrollLeft = 120;
      row().dispatchEvent(new Event("scroll"));
    });
    render(element(2));
    expect(row().scrollLeft).toBe(120);
  });

  it("fades the edge that hides tabs and draws the line on a frame the fade leaves whole", () => {
    render(viewTabs({ defaultValue: "a" }));
    expect(row().style.maskImage).toBe(
      "linear-gradient(to right, black 0, black calc(100% - 1rem), transparent 100%)"
    );
    expect(row().className).not.toContain("shadow-");
    expect(row().parentElement?.className).toContain("shadow-[inset_0_-1px_0_var(--color-border)]");

    act(() => {
      row().scrollLeft = 5 * TAB_WIDTH - ROW_WIDTH;
      row().dispatchEvent(new Event("scroll"));
    });
    expect(row().style.maskImage).toBe(
      "linear-gradient(to right, transparent 0, black 1rem, black 100%)"
    );
  });

  it("scrolls the open route's tab into view in a navigation of links", () => {
    const nav = (open: string) =>
      createElement(
        TabsNav,
        { label: "Sections" },
        ...values.map((value) =>
          createElement(
            TabsLink,
            { key: value, href: `/${value}`, selected: value === open },
            value
          )
        )
      );
    render(nav("a"));
    expect(row().closest("nav")?.getAttribute("aria-label")).toBe("Sections");
    expect(row().scrollLeft).toBe(0);
    render(nav("d"));
    expect(row().scrollLeft).toBe(400 + 16 - ROW_WIDTH);
  });
});
