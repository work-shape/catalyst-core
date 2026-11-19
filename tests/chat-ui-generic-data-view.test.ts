import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { DataPart, ToolCallPart } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { GenericDataView, readableLabel } from "./support/chat-ui";

// Data of a kind no widget of the release draws is read from its own shape: labelled values,
// tables and lists, as text. It was a code box of raw JSON (TOOL-2, check 82).

function view(data: unknown, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale,
      children: createElement(GenericDataView, { data })
    })
  );
}

/** The text of the markup, tags dropped: what a reader sees. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("the generic data view", () => {
  it("shows an object as labelled values, its keys made readable", () => {
    const data = { due_date: "2026-11-19", amountTotal: 12.5, paid: false, note: null };
    const english = view(data);
    expect(english).toContain("<dl");
    expect(text(english)).toContain("Due date 11/19/2026");
    expect(text(english)).toContain("Amount total 12.5");
    expect(text(english)).toContain("Paid No");
    expect(text(english)).toContain("Note —");

    const german = text(view(data, "de"));
    expect(german).toContain("Due date 19.11.2026");
    expect(german).toContain("Amount total 12,5");
    expect(german).toContain("Paid Nein");
  });

  it("makes keys readable in every common spelling", () => {
    expect(readableLabel("due_date")).toBe("Due date");
    expect(readableLabel("dueDate")).toBe("Due date");
    expect(readableLabel("due-date")).toBe("Due date");
    expect(readableLabel("userID")).toBe("User ID");
    expect(readableLabel("HTTPStatus")).toBe("HTTP status");
    expect(readableLabel("_")).toBe("_");
  });

  it("shows a list of flat objects as a table with the columns of all its rows", () => {
    const markup = view([
      { name: "First", count: 3 },
      { name: "Second", count: 12, owner: "Team" }
    ]);
    expect(markup).toContain("<table");
    const heads = [...markup.matchAll(/<th[^>]*>([^<]*)<\/th>/gu)].map((match) => match[1]);
    expect(heads).toEqual(["Name", "Count", "Owner"]);
    expect(markup.match(/<tr/gu)).toHaveLength(3);
    // Numbers stand at the end of their column; a missing value is a dash.
    expect(markup).toMatch(/<td[^>]*text-end[^>]*>12<\/td>/u);
    expect(text(markup)).toContain("First 3 —");
  });

  it("shows a list of plain values as a list", () => {
    const markup = view({ tags: ["urgent", "review", 7] });
    expect(markup).toContain("<ul");
    expect(markup.match(/<li/gu)).toHaveLength(3);
    expect(text(markup)).toContain("Tags");
    expect(text(markup)).toContain("urgent review 7");
    expect(markup).not.toContain("<table");
  });

  it("shows nested objects as sections and counts what lies deeper than four levels", () => {
    const markup = text(
      view({
        customer: {
          address: { city: "Springfield", geo: { point: { lat: 1, lon: 2 } } }
        }
      })
    );
    expect(markup).toContain("Customer Address City Springfield Geo Point 2 fields");
    expect(markup).not.toContain("Lat");

    // A list of objects with nested values is a section per item, under its position.
    const items = text(view([{ title: "One", parts: { size: 1 } }, "plain"]));
    expect(items).toContain("1 Title One Parts Size 1");
    expect(items).toContain("2 plain");
  });

  it("shows fifty rows of a long list and says how many more there are", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ position: index + 1 }));
    const markup = view(rows);
    // One head row and fifty rows.
    expect(markup.match(/<tr/gu)).toHaveLength(51);
    expect(text(markup)).toContain("and 10 more");
    expect(text(view({ values: Array.from({ length: 52 }, (_, index) => index) }))).toContain(
      "and 2 more"
    );
    expect(
      text(
        view(
          Array.from({ length: 55 }, () => "x"),
          "de"
        )
      )
    ).toContain("und 5 weitere");
  });

  it("cuts a long value and bounds the whole view however large the data is", () => {
    const long = "a".repeat(5000);
    const markup = view({ body: long });
    expect(markup).toContain("…");
    expect(markup).not.toContain(long);

    const wide = Array.from({ length: 50 }, (_, index) => [
      `section${index}`,
      Array.from({ length: 50 }, (_, row) => ({ row, label: `r${row}` }))
    ]);
    const huge = view(Object.fromEntries(wide));
    // 1500 values at most: every value of the fifteenth table and later ones is left out.
    expect(huge.match(/<td/gu)?.length ?? 0).toBeLessThanOrEqual(1500);
    expect(text(huge)).toContain("and 50 more");
    // Once the values are spent a list is only its count: no table of heads alone.
    expect(huge.match(/<table/gu)).toHaveLength(15);
    expect(huge.match(/<th[ >]/gu)).toHaveLength(30);

    // A long key is cut as a label and as a column's head; a long number is cut like text.
    const key = `field_${"x".repeat(200)}`;
    const labelled = text(view({ [key]: 1 }));
    expect(labelled).toContain(`Field ${"x".repeat(73)}…`);
    expect(labelled).not.toContain("x".repeat(80));
    const heads = view([{ [key]: 1 }]);
    expect(/<th[^>]*>([^<]*)<\/th>/u.exec(heads)?.[1]).toHaveLength(80);
    // A number of 301 digits in a table cell, which shows 120 characters.
    expect(text(view([{ amount: 1e300 }]))).toMatch(/^Amount 10{118}…$/u);
  });

  it("reads a day or a moment only where it is on the calendar", () => {
    expect(text(view({ due: "2026-02-28" }))).toContain("Due 2/28/2026");
    expect(text(view({ due: "2026-02-31" }))).toContain("Due 2026-02-31");
    expect(text(view({ at: "2026-02-31T10:00:00Z" }))).toContain("At 2026-02-31T10:00:00Z");
    expect(text(view({ at: "2026-11-19T10:00:00Z" }))).not.toContain("2026-11-19T");
  });

  it("shows text in the data as text and never as markup", () => {
    const markup = view({ note: '<script>alert("x")</script>', html: "<b>bold</b>" });
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("says when there is nothing to show", () => {
    expect(text(view({}))).toBe("No data");
    expect(text(view([], "de"))).toBe("Keine Daten");
  });
});

describe("a display whose kind has no widget", () => {
  function renderCall(result: unknown): string {
    return renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(ToolCallPart, {
          toolName: "example.lookup",
          toolCallId: "call_1",
          args: {},
          argsText: "{}",
          result,
          type: "tool-call" as const,
          status: { type: "complete" as const },
          addResult: () => undefined,
          resume: () => undefined,
          respondToApproval: () => undefined
        })
      )
    );
  }

  it("is drawn by the generic data view in the tool call, not as raw JSON", () => {
    const markup = renderCall({
      output: { found: 1 },
      display: {
        kind: "example.unknown_kind",
        version: 1,
        mode: "inline",
        data: { status: "open", due_date: "2026-11-19" }
      }
    });
    expect(markup).toContain('data-slot="generic-data-view"');
    expect(text(markup)).toContain("Status open");
    expect(text(markup)).toContain("Due date 11/19/2026");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("&quot;status&quot;");
    // In the thread it is bounded and scrolls.
    expect(markup).toMatch(/data-slot="generic-data-view" class="[^"]*max-h-96 overflow-auto/u);
  });

  it("keeps the sentence of the call above the data", () => {
    const markup = renderCall({
      output: "Found one open item.",
      display: { kind: "example.unknown_kind", mode: "inline", data: { status: "open" } }
    });
    expect(text(markup)).toContain("Found one open item. Status open");
  });

  it("is no display without a kind or without data", () => {
    // Without data it is the call's line alone.
    const empty = renderCall({ display: { kind: "example.unknown_kind", data: null } });
    expect(empty).not.toContain('data-slot="generic-data-view"');

    // A data part that is a record without a kind is data: all its fields show, not the inner
    // `data` as if it were a display's.
    const part = text(
      renderToStaticMarkup(
        createElement(
          ToolDisplayPanelProvider,
          null,
          createElement(DataPart, { name: "page", data: { data: ["one", "two"], total: 2 } })
        )
      )
    );
    expect(part).toContain("Data one two");
    expect(part).toContain("Total 2");
  });

  it("is drawn by the generic data view as a data part of a message", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(DataPart, {
          name: "lookup",
          data: { rows: [{ name: "First", count: 3 }] }
        })
      )
    );
    expect(markup).toContain('data-slot="generic-data-view"');
    expect(markup).toContain("<table");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("&quot;");
  });
});
