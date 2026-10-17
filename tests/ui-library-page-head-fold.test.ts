// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageHeader, UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";

// happy-dom lays nothing out, so the widths a browser would measure are given here: the head's
// room, and the row the actions need when none of them is folded.
let headWidth = 0;
const ROW_WIDTH = 300;
const PRIMARY_WIDTH = 120;
const MENU_WIDTH = 32;
// The name on one line, longer than the least the head keeps for it (160).
const NAME_WIDTH = 400;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute("data-page-head") ? headWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute("data-name") ? NAME_WIDTH : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const width = this.hasAttribute("inert")
      ? ROW_WIDTH
      : this.textContent === "Jetzt starten"
        ? PRIMARY_WIDTH
        : this.firstElementChild?.getAttribute("aria-label") === "Weitere Aktionen"
          ? MENU_WIDTH
          : 0;
    return DOMRect.fromRect({ width, height: 32 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function renderHead(menu?: string): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(PageHeader, {
          variant: "detail",
          title: "Rechnungsprüfung",
          secondaryActions: [
            { label: "Verlauf", onSelect: () => undefined },
            { label: "Als Standard festlegen", onSelect: () => undefined }
          ],
          primaryAction: createElement("button", { type: "button" }, "Jetzt starten"),
          menu
        })
      )
    )
  );
  const head = container.querySelector<HTMLElement>("[data-page-head]");
  if (!head) {
    throw new Error("The page head did not render.");
  }
  return head;
}

/** The labels of the head's buttons a reader sees, without the row that only measures. */
function shownButtons(head: HTMLElement): string[] {
  return [...head.querySelectorAll("button")]
    .filter((button) => button.closest("[inert]") === null)
    .map((button) => button.getAttribute("aria-label") ?? button.textContent);
}

describe("a page head's actions", () => {
  it("stand as buttons where the head has room for all of them", () => {
    headWidth = 1200;

    expect(shownButtons(renderHead())).toEqual([
      "Verlauf",
      "Als Standard festlegen",
      "Jetzt starten"
    ]);
  });

  it("fold the secondary actions into the … menu where they do not fit, and keep the primary", () => {
    headWidth = 390;

    expect(shownButtons(renderHead())).toEqual(["Jetzt starten", "Weitere Aktionen"]);
  });

  it("count the button of the head's menu, which stands in either case", () => {
    // 300 + 120 and the 160 kept for the name fit in 600; with the menu's 32 they do not.
    headWidth = 600;

    expect(shownButtons(renderHead())).toEqual([
      "Verlauf",
      "Als Standard festlegen",
      "Jetzt starten"
    ]);
    act(() => root?.unmount());
    expect(shownButtons(renderHead("ID kopieren"))).toEqual(["Jetzt starten", "Weitere Aktionen"]);
  });

  // Fails without the name's room: beside a dock the head kept every action on its one line and
  // cut the name to two letters.
  it("fold before the name has less than its least width beside them", () => {
    // 300 + 120 fit in 520; with the 160 kept for the name they do not.
    headWidth = 520;

    expect(shownButtons(renderHead())).toEqual(["Jetzt starten", "Weitere Aktionen"]);
    act(() => root?.unmount());
    headWidth = 580;
    expect(shownButtons(renderHead())).toEqual([
      "Verlauf",
      "Als Standard festlegen",
      "Jetzt starten"
    ]);
  });

  it("keep no second button out of sight to measure with", () => {
    headWidth = 1200;
    const head = renderHead("ID kopieren");

    expect(head.querySelectorAll("button")).toHaveLength(4);
    expect(head.querySelector("[inert]")?.textContent).toBe("VerlaufAls Standard festlegen");
  });
});
