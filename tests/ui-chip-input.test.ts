// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChipInput, Field, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function Sample({ initial }: { initial: readonly string[] }) {
  const [value, setValue] = useState(initial);
  return createElement(Field, {
    label: "Values",
    children: createElement(ChipInput, { value, onChange: setValue })
  });
}

async function mount(initial: readonly string[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(Sample, { initial })
      )
    )
  );
  const input = host.querySelector("input");
  if (!input) throw new Error("no input");
  return input;
}

const chips = () =>
  [...(host?.querySelectorAll("[data-chip-input] > span") ?? [])].map((chip) =>
    chip.textContent?.trim()
  );

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(input: HTMLInputElement, name: string) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

describe("ChipInput", () => {
  it("adds a value on a comma and on Enter, once each, and is labelled by its field", async () => {
    const input = await mount([]);
    expect(host?.querySelector("label")?.getAttribute("for")).toBe(input.id);
    await type(input, "101,");
    await type(input, "102");
    await key(input, "Enter");
    await type(input, "101,");
    expect(chips()).toEqual(["101", "102"]);
    expect(input.value).toBe("");
  });

  it("removes the last chip on Backspace in the empty field, and a chip by its button", async () => {
    const input = await mount(["101", "102", "103"]);
    await key(input, "Backspace");
    expect(chips()).toEqual(["101", "102"]);
    const remove = host?.querySelector<HTMLButtonElement>('button[aria-label="Remove"]');
    await act(async () => remove?.click());
    expect(chips()).toEqual(["102"]);
  });
});
