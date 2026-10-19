// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  Picker,
  PickerButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  UiRoot,
  uiLabelsDe
} from "@work-shape/catalyst-ui";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function render(element: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.append(host);
  const created = createRoot(host);
  root = created;
  act(() => created.render(createElement(UiRoot, { mode: "dark", labels: uiLabelsDe }, element)));
}

/** The classes that hold on the panel while it is open, as the stylesheet applies them. */
function openStateClasses(panel: Element): string[] {
  expect(panel.getAttribute("data-state")).toBe("open");
  return Array.from(panel.classList).filter(
    (name) => !name.includes(":") || name.startsWith("data-[state=open]:")
  );
}

/** The classes that start an opening animation or set where it starts from. */
const ENTERING = /animate-in|fade-in|zoom-in|slide-in/u;

describe("Picker panel", () => {
  it("is opaque from its first frame: it opens on the raised surface with no fade or zoom", () => {
    render(
      createElement(Picker, {
        defaultOpen: true,
        search: true,
        options: [
          { value: "elif", label: "Elif Yilmaz", description: "elif@example.test" },
          { value: "jonas", label: "Jonas Brandt", description: "jonas@example.test" }
        ],
        value: undefined,
        onValueChange: () => undefined,
        children: createElement(PickerButton, { label: "Person", placeholder: "Person wählen" })
      })
    );
    const panel = document.querySelector("[data-catalyst-overlays] [role=dialog]");
    expect(panel?.textContent).toContain("Elif Yilmaz");
    if (!panel) {
      throw new Error("The picker panel did not open.");
    }

    const open = openStateClasses(panel);
    expect(open).toEqual(expect.arrayContaining(["bg-popover", "border", "shadow-overlay"]));
    expect(open.filter((name) => ENTERING.test(name))).toEqual([]);
  });

  it("leaves the other anchored overlays their opening fade", () => {
    render(
      createElement(Popover, {
        open: true,
        children: [
          createElement(
            PopoverTrigger,
            { key: "trigger", asChild: true },
            createElement("button", null, "Open")
          ),
          createElement(PopoverContent, { key: "content" }, "Filter")
        ]
      })
    );
    const panel = document.querySelector("[data-catalyst-overlays] [role=dialog]");
    if (!panel) {
      throw new Error("The popover did not open.");
    }

    expect(openStateClasses(panel)).toEqual(
      expect.arrayContaining(["data-[state=open]:animate-in", "data-[state=open]:fade-in-0"])
    );
  });
});
