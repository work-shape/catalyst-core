import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  UiRoot,
  uiLabelsEn,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type TableProps
} from "@work-shape/catalyst-ui";

// The density, the head row that stays, the alignment and the cut of a cell. Every test here
// fails without them: the props did not exist and reached the DOM unread, or not at all.

const tableElement = (props: TableProps, cell: ReactNode) =>
  createElement(
    Table,
    props,
    createElement(
      TableHeader,
      null,
      createElement(TableRow, null, createElement(TableHead, { align: "end" }, "Amount"))
    ),
    createElement(TableBody, null, createElement(TableRow, null, cell))
  );
const table = (props: TableProps, cell: ReactNode = createElement(TableCell, null, "value")) =>
  renderToStaticMarkup(tableElement(props, cell));
/** A cut cell with a tooltip needs the root that holds the tooltip's container. */
const tableInRoot = (cell: ReactNode) =>
  renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, tableElement({}, cell))
  );
const classesOf = (markup: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*\\sclass="([^"]*)"`, "u").exec(markup)?.[1]?.split(" ") ?? [];

describe("Table", () => {
  it("is a plain table in a box that scrolls sideways, at the default density", () => {
    const markup = table({});

    expect(markup).toMatch(
      /^<div data-slot="table-frame" class="relative w-full min-w-0"><div data-slot="table-box" class="w-full overflow-x-auto"><table/u
    );
    // Nothing is hidden before a browser has measured, so nothing fades and no side is shaded.
    expect(markup).not.toMatch(/mask-image|table-edge-shade/u);
    expect(markup).toContain('data-density="default"');
    expect(markup).not.toContain('data-sticky-header=""');
    expect(markup.match(/<(?:thead|tbody|tr|th|td)\b/gu)).toEqual([
      "<thead",
      "<tr",
      "<th",
      "<tbody",
      "<tr",
      "<td"
    ]);
  });

  it("names its density on the table, which the cells answer with a lower row", () => {
    const markup = table({ density: "compact" });

    expect(markup).toContain('data-density="compact"');
    expect(classesOf(markup, "td")).toContain("group-data-[density=compact]/table:py-1.5");
    expect(classesOf(markup, "th")).toContain("group-data-[density=compact]/table:h-8");
  });

  it("stands in a bounded box that scrolls both ways when the head row stays", () => {
    const markup = table({ stickyHeader: true });

    // The frame holds the border and stands outside what scrolls, so the fade leaves it whole.
    expect(markup).toMatch(
      /^<div data-slot="table-frame" class="relative w-full min-w-0 overflow-hidden rounded-md border bg-card"><div data-slot="table-box" class="w-full max-h-128 overflow-auto"><table/u
    );
    expect(markup).toContain('data-sticky-header=""');
    // The head cell is opaque, so no row shows through it.
    expect(classesOf(markup, "th")).toEqual(
      expect.arrayContaining([
        "group-data-sticky-header/table:sticky",
        "group-data-sticky-header/table:top-0",
        "group-data-sticky-header/table:bg-card"
      ])
    );
    // A row that scrolls under the head row fades into it, in either mode: the fade is the
    // surface's own colour.
    expect(classesOf(markup, "th")).toEqual(
      expect.arrayContaining([
        "group-data-sticky-header/table:after:top-full",
        "group-data-sticky-header/table:after:bg-linear-to-b",
        "group-data-sticky-header/table:after:from-card"
      ])
    );
  });

  it("stands a column at its end, head and cell alike, with figures of one width", () => {
    const markup = table({}, createElement(TableCell, { align: "end" }, "1.240,00"));

    for (const tag of ["th", "td"]) {
      expect(classesOf(markup, tag)).toEqual(expect.arrayContaining(["text-end", "tabular-nums"]));
      expect(markup).not.toMatch(new RegExp(`<${tag}\\b[^>]*\\salign=`, "u"));
    }
    expect(classesOf(table({}), "td")).toContain("text-start");
  });

  it("cuts a cell to one line, keeps the whole value in it and lets the keyboard reach it", () => {
    const long = "Betrag über der Freigrenze für Sachzuwendungen";
    const markup = tableInRoot(createElement(TableCell, { truncate: 24 }, long));
    const value = /<span[^>]*data-slot="table-cell-value"[^>]*>([^<]*)<\/span>/u.exec(markup);

    expect(value?.[1]).toBe(long);
    expect(value?.[0]).toContain('tabindex="0"');
    expect(value?.[0]).toContain('style="max-width:24ch"');
    expect(value?.[0]).toMatch(/class="[^"]*\btruncate\b[^"]*focus-visible:focus-ring/u);
    // It is the trigger of the library's tooltip, closed until it is reached, and carries no
    // native tooltip beside it.
    expect(value?.[0]).toContain('data-state="closed"');
    expect(markup).not.toContain("title=");
    // A number is a value too.
    expect(tableInRoot(createElement(TableCell, { truncate: 4 }, 1234567))).toContain(
      'tabindex="0"'
    );
  });

  it("takes the tooltip of a cut cell from the caller when the content is not plain text", () => {
    const code = createElement("code", null, '{"a":1}');
    const named = tableInRoot(createElement(TableCell, { truncate: 4, title: "a is 1" }, code));
    const unnamed = table({}, createElement(TableCell, { truncate: 4 }, code));

    expect(named).toMatch(/<span tabindex="0" data-slot="table-cell-value"[^>]*><code>/u);
    expect(named).not.toContain("title=");
    // Without a whole value to show there is no tooltip, so nothing to reach and no root needed.
    expect(unnamed).toContain(
      '<span data-slot="table-cell-value" class="block truncate" style="max-width:4ch"><code>'
    );
    expect(unnamed).not.toContain("tabindex");
  });

  it("refuses a cut cell with a tooltip outside a UiRoot, which holds the tooltip", () => {
    expect(() => table({}, createElement(TableCell, { truncate: 4 }, "value"))).toThrow(
      /Tooltip must be rendered inside UiRoot/u
    );
  });

  it("leaves a cell that is not cut as the caller wrote it", () => {
    const markup = table({}, createElement(TableCell, { title: "whole" }, "value"));

    expect(markup).toMatch(/<td title="whole" class="[^"]*">value<\/td>/u);
  });
});
