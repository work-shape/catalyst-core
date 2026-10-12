import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type TableProps
} from "@vivd-catalyst/ui";

// The density, the head row that stays, the alignment and the cut of a cell. Every test here
// fails without them: the props did not exist and reached the DOM unread, or not at all.

const table = (props: TableProps, cell: ReactNode = createElement(TableCell, null, "value")) =>
  renderToStaticMarkup(
    createElement(
      Table,
      props,
      createElement(
        TableHeader,
        null,
        createElement(TableRow, null, createElement(TableHead, { align: "end" }, "Amount"))
      ),
      createElement(TableBody, null, createElement(TableRow, null, cell))
    )
  );
const classesOf = (markup: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*\\sclass="([^"]*)"`, "u").exec(markup)?.[1]?.split(" ") ?? [];

describe("Table", () => {
  it("is a plain table in a box that scrolls sideways, at the default density", () => {
    const markup = table({});

    expect(markup).toMatch(/^<div data-slot="table-box" class="w-full overflow-x-auto"><table/u);
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
      /^<div data-slot="table-frame" class="w-full overflow-hidden rounded-md border bg-card"><div data-slot="table-box" class="w-full max-h-128 overflow-auto"><table/u
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
  });

  it("stands a column at its end, head and cell alike, with figures of one width", () => {
    const markup = table({}, createElement(TableCell, { align: "end" }, "1.240,00"));

    for (const tag of ["th", "td"]) {
      expect(classesOf(markup, tag)).toEqual(expect.arrayContaining(["text-end", "tabular-nums"]));
      expect(markup).not.toMatch(new RegExp(`<${tag}\\b[^>]*\\salign=`, "u"));
    }
    expect(classesOf(table({}), "td")).toContain("text-start");
  });

  it("cuts a cell to one line and keeps the whole value in the cell and as its tooltip", () => {
    const long = "Betrag über der Freigrenze für Sachzuwendungen";
    const markup = table({}, createElement(TableCell, { truncate: 24 }, long));

    expect(markup).toContain(
      `<span data-slot="table-cell-value" title="${long}" class="block truncate" style="max-width:24ch">${long}</span>`
    );
    // A number is a value too.
    expect(table({}, createElement(TableCell, { truncate: 4 }, 1234567))).toContain(
      'title="1234567"'
    );
  });

  it("takes the tooltip of a cut cell from the caller when the content is not plain text", () => {
    const code = createElement("code", null, '{"a":1}');
    const named = table({}, createElement(TableCell, { truncate: 4, title: "a is 1" }, code));
    const unnamed = table({}, createElement(TableCell, { truncate: 4 }, code));

    expect(named).toMatch(/<td class="[^"]*"><span data-slot="table-cell-value" title="a is 1"/u);
    expect(unnamed).not.toContain("title=");
  });

  it("leaves a cell that is not cut as the caller wrote it", () => {
    const markup = table({}, createElement(TableCell, { title: "whole" }, "value"));

    expect(markup).toMatch(/<td title="whole" class="[^"]*">value<\/td>/u);
  });
});
