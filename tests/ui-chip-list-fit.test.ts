// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chip, ChipList, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// A chip list never wraps: it shows the chips that fit its width and one "+N" for the rest,
// which opens a list of them. happy-dom lays nothing out, so every chip is 100 px wide here,
// "+N" is 30 px, and the list is as wide as the test says.

const CHIP = 100;
const MORE = 30;

describe("ChipList on one line", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let room = 0;
  let resized: ((entries: unknown[]) => void)[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resized = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: unknown[]) => void) {
          resized.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => room);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      return DOMRect.fromRect({ width: (this.textContent ?? "").startsWith("+") ? MORE : CHIP });
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

  const render = (count: number, width: number) => {
    room = width;
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(ChipList, {
            label: "Knowledge",
            tone: "quiet",
            moreLabel: (hidden) => `${String(hidden)} more`,
            children: Array.from({ length: count }, (_, index) =>
              createElement(Chip, {
                key: index,
                tone: "quiet",
                description: `About ${String(index + 1)}.`,
                children: `Chip ${String(index + 1)}`
              })
            )
          })
        )
      )
    );
  };
  const resizeTo = (width: number) => {
    room = width;
    act(() => resized.forEach((callback) => callback([])));
  };
  const row = () => container.querySelector('ul[aria-label="Knowledge"]');
  const shown = () =>
    Array.from(row()?.querySelectorAll("li") ?? [], (item) => item.textContent ?? "");
  const more = () => row()?.querySelector<HTMLButtonElement>("button[aria-haspopup]") ?? null;

  it("shows every chip where all fit, without a +N", () => {
    // Three chips and two gaps of 6 px.
    render(3, 312);
    expect(shown()).toEqual(["Chip 1", "Chip 2", "Chip 3"]);
    expect(more()).toBeNull();
  });

  it("shows the chips that fit beside +N and counts the rest", () => {
    // Nine chips need 948 px. Four, +N and four gaps need 454.
    render(9, 460);
    expect(shown()).toEqual(["Chip 1", "Chip 2", "Chip 3", "Chip 4", "+5"]);
    expect(more()?.getAttribute("aria-label")).toBe("5 more");
  });

  it("counts again when its width changes", () => {
    render(9, 460);
    resizeTo(250);
    expect(shown()).toEqual(["Chip 1", "Chip 2", "+7"]);
    resizeTo(2000);
    expect(shown()).toHaveLength(9);
    expect(more()).toBeNull();
  });

  it("keeps one chip and +N at the width of a phone, the chip free to shorten", () => {
    render(4, 120);
    expect(shown()).toEqual(["Chip 1", "+3"]);
    expect(row()?.querySelector("li")?.className).toContain("min-w-0");
  });

  it("opens a list of the rest from +N, each a chip of its own", () => {
    render(9, 460);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => more()?.click());
    const rest = document.querySelector('[role="dialog"] ul');
    expect(rest?.getAttribute("aria-label")).toBe("5 more");
    expect(Array.from(rest?.querySelectorAll("li") ?? [], (item) => item.textContent)).toEqual([
      "Chip 5",
      "Chip 6",
      "Chip 7",
      "Chip 8",
      "Chip 9"
    ]);
    // Each keeps its description: a label that takes focus for it.
    expect(rest?.querySelectorAll("button")).toHaveLength(5);
  });

  it("does not open its list on focus alone, so Tab passes over +N", () => {
    render(9, 460);
    act(() => more()?.focus());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not open its list again by itself once +N comes back", () => {
    render(9, 460);
    act(() => more()?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    resizeTo(2000);
    resizeTo(460);
    expect(more()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps what it measures out of sight and out of reach", () => {
    render(9, 460);
    const measure = container.querySelector("[inert]");
    expect(measure?.getAttribute("aria-hidden")).toBe("true");
    expect(measure?.className).toContain("invisible");
  });
});
