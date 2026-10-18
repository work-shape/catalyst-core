// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LoadMore,
  Picker,
  PickerButton,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn,
  type PickerMoreRow
} from "@work-shape/catalyst-ui";

// DISCOVERY-PAGING: the two controls of a list read a page at a time from a cursor, with no
// total. A Picker's last row, and a list's foot (`LoadMore`), ask for the next page; while the
// page is on its way they cannot be used again; once the last page is there they are gone.

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(more: PickerMoreRow | undefined) {
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(Picker, {
          search: true,
          defaultOpen: true,
          options: [
            { value: "alpha", label: "Alpha" },
            { value: "beta", label: "Beta" }
          ],
          value: undefined,
          onValueChange: () => undefined,
          more,
          children: createElement(PickerButton, {
            label: "Skill",
            placeholder: "Choose a skill",
            value: undefined
          })
        })
      )
    );
  });
}

const moreRow = () => document.querySelector<HTMLElement>("[data-picker-more]");

describe("Picker with a next page", () => {
  it("ends its list with a row that asks for the next page", async () => {
    const onLoad = vi.fn();
    await mount({ loading: false, onLoad });

    const row = moreRow();
    expect(row?.textContent).toBe(uiLabelsEn.showMore);
    // The row comes after the options, inside the list that scrolls.
    const rows = [...document.querySelectorAll("[cmdk-item]")].map((item) => item.textContent);
    expect(rows).toEqual(["Alpha", "Beta", uiLabelsEn.showMore]);

    await act(async () => row?.click());
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("cannot be chosen again while the next page is on its way", async () => {
    const onLoad = vi.fn();
    await mount({ loading: true, onLoad });

    const row = moreRow();
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => row?.click());
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("shows no such row once the last page is there", async () => {
    await mount(undefined);
    expect(document.querySelector("[cmdk-item]")).not.toBeNull();
    expect(moreRow()).toBeNull();
  });
});

describe("LoadMore", () => {
  async function mountLoadMore(props: Parameters<typeof LoadMore>[0], labels = uiLabelsEn) {
    await act(async () => {
      root.render(createElement(UiRoot, { mode: "light", labels }, createElement(LoadMore, props)));
    });
    return host.querySelector<HTMLButtonElement>('[data-slot="load-more"] button');
  }

  it("reads the next page when pressed, in the library's words of the reader's language", async () => {
    const onLoad = vi.fn();
    const button = await mountLoadMore({ loading: false, onLoad, id: "list-more" });
    expect(button?.textContent).toBe(uiLabelsEn.showMore);
    // What the caller marks it with reaches its element.
    expect(host.querySelector('[data-slot="load-more"]')?.id).toBe("list-more");
    await act(async () => button?.click());
    expect(onLoad).toHaveBeenCalledTimes(1);

    expect((await mountLoadMore({ loading: false, onLoad }, uiLabelsDe))?.textContent).toBe(
      uiLabelsDe.showMore
    );
  });

  it("says the caller's words where it gives them", async () => {
    const button = await mountLoadMore({
      loading: false,
      onLoad: () => undefined,
      label: "Mehr zeigen"
    });
    expect(button?.textContent).toBe("Mehr zeigen");
  });

  it("cannot be pressed again while the next page is on its way", async () => {
    const onLoad = vi.fn();
    const button = await mountLoadMore({ loading: true, onLoad });
    expect(button?.disabled).toBe(true);
    await act(async () => button?.click());
    expect(onLoad).not.toHaveBeenCalled();
  });
});
