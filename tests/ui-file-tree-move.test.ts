// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTree, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

// A file or folder dragged into a folder, or onto the top level that shows while something is
// dragged. Nothing drags without `onMove`.

let host: HTMLDivElement;
let root: Root;

const items = [
  { path: "plan.md" },
  { path: "unterlagen/vertrag.md" },
  { path: "unterlagen/neu/a.md" }
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

async function render(onMove?: (path: string, toFolder: string) => void) {
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(FileTree, {
          label: "Dateien",
          items,
          defaultExpanded: true,
          ...(onMove ? { onMove, rootDropLabel: "Oberste Ebene" } : {})
        })
      )
    );
  });
}

async function drag(type: string, target: Element) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => undefined }
  });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

function find(selector: string): Element {
  const found = host.querySelector(selector);
  if (!found) throw new Error(`${selector} is not there`);
  return found;
}

const rowOf = (path: string) => find(`[data-path="${path}"] > div, [data-folder="${path}"] > div`);

describe("a file tree you can drag in", () => {
  it("moves a file into a folder and a folder to the top level", async () => {
    const onMove = vi.fn();
    await render(onMove);
    expect(host.querySelector('[data-testid="file-tree-root-drop"]')).toBeNull();

    await drag("dragstart", rowOf("plan.md"));
    await drag("dragover", rowOf("unterlagen/"));
    expect(rowOf("unterlagen/").hasAttribute("data-drop-over")).toBe(true);
    const dropped = await drag("drop", rowOf("unterlagen/"));
    expect(dropped.defaultPrevented).toBe(true);
    expect(onMove).toHaveBeenLastCalledWith("plan.md", "unterlagen/");

    await drag("dragstart", rowOf("unterlagen/neu/"));
    const top = find('[data-testid="file-tree-root-drop"]');
    expect(top.textContent).toBe("Oberste Ebene");
    await drag("drop", top);
    expect(onMove).toHaveBeenLastCalledWith("unterlagen/neu/", "");
  });

  it("takes no drop where the file already lies, or a folder into itself", async () => {
    const onMove = vi.fn();
    await render(onMove);
    await drag("dragstart", rowOf("unterlagen/vertrag.md"));
    // Already in "unterlagen/": the folder is no target for it; the top level is.
    expect((await drag("dragover", rowOf("unterlagen/"))).defaultPrevented).toBe(false);
    await drag("drop", rowOf("unterlagen/"));
    expect(onMove).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="file-tree-root-drop"]')).not.toBeNull();
    await drag("dragend", rowOf("unterlagen/vertrag.md"));

    await drag("dragstart", rowOf("unterlagen/"));
    expect((await drag("dragover", rowOf("unterlagen/neu/"))).defaultPrevented).toBe(false);
    await drag("drop", rowOf("unterlagen/neu/"));
    // A top-level folder has no top level to go to.
    expect(host.querySelector('[data-testid="file-tree-root-drop"]')).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("drags nothing without onMove", async () => {
    await render();
    expect(host.querySelectorAll("[draggable]")).toHaveLength(0);
  });
});
