// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-ui";

// A column with a priority folds into the row's details once the table cannot show every
// column at its full width. happy-dom lays nothing out, so the widths a browser would measure
// are set here: a column is 10 px per character of its longest text, head included, and the
// table is the sum of the columns it shows.

let boxWidth = 0;
let tableMeasures = 0;

const shows = (cell: Element) => !cell.hasAttribute("data-folded");

function columnWidth(table: HTMLTableElement, column: number): number {
  return Math.max(
    ...[...table.rows].map((row) => (row.cells[column]?.firstChild?.textContent?.length ?? 0) * 10)
  );
}

function widthOf(element: Element): number {
  if (element instanceof HTMLTableElement) {
    tableMeasures += 1;
    return [...(element.rows[0]?.cells ?? [])]
      .filter(shows)
      .reduce((sum, head) => sum + columnWidth(element, head.cellIndex), 0);
  }
  const table = element.closest("table");
  return element instanceof HTMLTableCellElement && table
    ? columnWidth(table, element.cellIndex)
    : 0;
}

interface Person {
  lastActive: string;
  lastActiveHead?: string;
}

/**
 * Name (130) never folds; Last active folds first, then Access (60), then Status (70). Its
 * head is 40 wide, so its value sets its width.
 */
function people(person: Person, priorities = true) {
  const head = (label: string, priority: number) =>
    createElement(TableHead, priorities ? { priority } : {}, label);
  return createElement(
    Table,
    null,
    createElement(
      TableHeader,
      null,
      createElement(
        TableRow,
        null,
        createElement(TableHead, null, "Name"),
        head("Access", 2),
        head("Status", 1),
        head(person.lastActiveHead ?? "Last", 3)
      )
    ),
    createElement(
      TableBody,
      null,
      createElement(
        TableRow,
        null,
        createElement(TableCell, { rowDetail: true }, "Mara Oyelaran"),
        createElement(TableCell, null, "Admin"),
        createElement(TableCell, null, createElement("b", null, "Invited")),
        createElement(TableCell, null, person.lastActive)
      )
    )
  );
}

const NEVER = { lastActive: "Never" };
const RECENTLY = { lastActive: "16 Oct 2026, 23:15" };

describe("Table columns with a priority", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element
    ) {
      return DOMRect.fromRect({ width: widthOf(this), height: 0 });
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.slot === "table-box" ? boxWidth : 0;
    });
    tableMeasures = 0;
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

  const render = (width: number, person: Person = NEVER, priorities = true) => {
    boxWidth = width;
    act(() => root.render(people(person, priorities)));
  };
  const folded = (tag: string) =>
    [...container.querySelectorAll(`${tag}[data-folded]`)].map((cell) => cell.textContent);
  const details = () =>
    [...container.querySelectorAll('[data-slot="table-row-detail"] > div')].map((pair) => [
      pair.querySelector("dt")?.textContent,
      pair.querySelector("dd")?.innerHTML
    ]);

  it("shows every column while they fit at their full width", () => {
    render(310);

    expect(folded("th")).toEqual([]);
    expect(container.querySelector('[data-slot="table-row-detail"]')).toBeNull();
  });

  it("folds the least important columns until the rest fit, into the row's details", () => {
    render(220);

    // 310 needs 90 more than 220: Last (50) is not enough, Access (60) is.
    expect(folded("th")).toEqual(["Access", "Last"]);
    for (const head of container.querySelectorAll("th[data-folded]")) {
      expect(head.className.split(" ")).toContain("data-folded:hidden");
    }
    // Each value shows whole, in column order, under its head's label; the rest stay put.
    expect(details()).toEqual([
      ["Access", "Admin"],
      ["Last", "Never"]
    ]);
    const cells = [...container.querySelectorAll("td:not([data-folded])")];
    expect(cells.map((cell) => cell.firstChild?.textContent)).toEqual(["Mara Oyelaran", "Invited"]);
    expect(cells[0]?.querySelector("dl")).not.toBeNull();
  });

  // UI-KEYS: at 390 a folded value stood beside its label however wide it was, and spilled
  // over the next column.
  it("lets a folded value wrap under its label where the room beside it is too narrow", () => {
    render(220);

    for (const pair of container.querySelectorAll('[data-slot="table-row-detail"] > div')) {
      expect(pair.className.split(" ")).toContain("flex-wrap");
    }
    expect(details()).not.toEqual([]);
  });

  it("unfolds the columns again once the room returns", () => {
    render(220);
    render(1000);

    expect(folded("th")).toEqual([]);
    expect(folded("td")).toEqual([]);
    expect(container.querySelector('[data-slot="table-row-detail"]')).toBeNull();
    expect(container.querySelectorAll("td")[2]?.innerHTML).toBe("<b>Invited</b>");
  });

  it("measures a folded column by the values it holds now", () => {
    // Last folds for its long value (180) and shows again once its value is short (50).
    render(320, RECENTLY);
    expect(folded("th")).toEqual(["Last"]);
    render(320, NEVER);
    expect(folded("th")).toEqual([]);

    // A value that grows while folded keeps it folded, though the box widened past the width
    // the column had when it folded.
    render(280, NEVER);
    expect(folded("th")).toEqual(["Last"]);
    render(320, RECENTLY);
    expect(folded("th")).toEqual(["Last"]);
    expect(details()).toEqual([["Last", RECENTLY.lastActive]]);

    // A head that changes its words names the folded value in the new words.
    render(320, { ...RECENTLY, lastActiveHead: "Zuletzt" });
    expect(details()).toEqual([["Zuletzt", RECENTLY.lastActive]]);
  });

  it("keeps the columns that never fold, however narrow the table", () => {
    render(50);

    expect(folded("th")).toEqual(["Access", "Status", "Last"]);
    expect(container.querySelector("th:not([data-folded])")?.textContent).toBe("Name");
  });

  it("leaves a table without priorities unmeasured and every column in place", () => {
    render(50, NEVER, false);

    expect(tableMeasures).toBe(0);
    expect(container.querySelector("[data-column]")).toBeNull();
    expect(folded("th")).toEqual([]);
  });
});
