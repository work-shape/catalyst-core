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
