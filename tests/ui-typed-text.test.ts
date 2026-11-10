// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedText } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";

// A text that replaces another is typed in. The steps run on timers, so the clock here is
// fake: one step is 24 ms, and a text takes at most 50 of them.

const STEP_MS = 24;

describe("TypedText", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let reducedMotion: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    reducedMotion = false;
    vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = (text: string, still?: boolean) =>
    act(() => root.render(createElement(TypedText, { text, still, title: text })));
  // Each step is rendered before the next one is timed, so the clock moves one step at a time.
  const steps = (count: number) => {
    for (let step = 0; step < count; step += 1) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
    }
  };
  const element = () => required(container.querySelector<HTMLElement>(":scope > span"));
  /** What a person sees: the letters typed so far, without the rest a screen reader gets. */
  const seen = () => element().firstChild?.nodeValue ?? "";
  const typing = () => element().hasAttribute("data-typing");

  it("shows its first text at once", () => {
    render("Offers for the roof");

    expect(typing()).toBe(false);
    expect(element().outerHTML).toBe(
      '<span title="Offers for the roof">Offers for the roof</span>'
    );
  });

  it("types in a text that replaces another, with the whole text in the element throughout", () => {
    render("First line of the message");
    render("Roof");

    expect(typing()).toBe(true);
    expect(seen()).toBe("");
    expect(element().textContent).toBe("Roof");
    steps(1);
    expect(seen()).toBe("R");
    steps(2);
    expect(seen()).toBe("Roo");
    expect(element().textContent).toBe("Roof");
    expect(element().querySelector(".sr-only")?.textContent).toBe("f");
    expect(element().querySelector("[aria-hidden]")?.textContent).toBe("");
    steps(1);
    expect(typing()).toBe(false);
    expect(element().outerHTML).toBe('<span title="Roof">Roof</span>');
  });

  it("starts over when the text changes in the middle of the typing", () => {
    render("One");
    render("Offers");
    steps(3);
    expect(seen()).toBe("Off");

    render("Roof");
    expect(seen()).toBe("");
    steps(4);
    expect(typing()).toBe(false);
    expect(element().textContent).toBe("Roof");
  });

  it("shows a text at once where the caller says it stands", () => {
    render("One");
    render("Typed by the reader", true);

    expect(typing()).toBe(false);
    expect(element().textContent).toBe("Typed by the reader");
  });

  it("shows a text at once under reduced motion", () => {
    render("One");
    reducedMotion = true;
    render("Offers");

    expect(typing()).toBe(false);
    expect(element().textContent).toBe("Offers");
  });

  it("types a long text in bigger steps, and never half a character", () => {
    const long = "📎".repeat(120);
    render("One");
    render(long);

    steps(1);
    expect(seen()).toBe("📎📎📎");
    steps(38);
    expect(typing()).toBe(true);
    steps(1);
    expect(typing()).toBe(false);
    expect(element().textContent).toBe(long);
  });
});
