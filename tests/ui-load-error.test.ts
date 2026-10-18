// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadError, UiRoot, uiLabelsDe, uiLabelsEn, type UiLabels } from "@work-shape/catalyst-ui";

// A read that failed says what failed and offers to read it again, in the library's own words
// for the button, so every screen that loads something offers the same control.

let root: Root | undefined;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function renderLoadError(labels: UiLabels, onRetry: () => void): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels },
        createElement(LoadError, { onRetry, children: "The workflows could not be loaded." })
      )
    )
  );
  return container;
}

describe("LoadError", () => {
  it("announces what failed and reads it again once per press of Try again", () => {
    const onRetry = vi.fn();
    const container = renderLoadError(uiLabelsEn, onRetry);
    const error = container.querySelector('[role="alert"][data-load-error]');
    expect(error?.textContent).toContain("The workflows could not be loaded.");
    const buttons = [...(error?.querySelectorAll("button") ?? [])];
    expect(buttons.map((button) => button.textContent)).toEqual([uiLabelsEn.tryAgain]);
    expect(onRetry).not.toHaveBeenCalled();
    act(() => buttons[0]?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("names its button in the language of its root", () => {
    const container = renderLoadError(uiLabelsDe, () => undefined);
    expect(container.querySelector("button")?.textContent).toBe("Erneut versuchen");
  });
});
