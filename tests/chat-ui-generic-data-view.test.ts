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
  it("shows an object as labelled values in the reader's language, its keys made readable", () => {
    const data = { due_date: "2026-11-19", amountTotal: 12.5, paid: false };
    expect(text(view(data))).toContain("Due date 11/19/2026");
    expect(text(view(data, "de"))).toContain("Amount total 12,5");
    expect(readableLabel("dueDate")).toBe("Due date");
    expect(readableLabel("HTTPStatus")).toBe("HTTP status");
  });

  it("shows a list of flat objects as a table with the columns of all its rows, and plain values as a list", () => {
    const markup = view([
      { name: "First", count: 3 },
      { name: "Second", count: 12, owner: "Team" }
    ]);
    const heads = [...markup.matchAll(/<th[^>]*>([^<]*)<\/th>/gu)].map((match) => match[1]);
    expect(heads).toEqual(["Name", "Count", "Owner"]);
    expect(markup.match(/<tr/gu)).toHaveLength(3);
    expect(view({ tags: ["urgent", "review", 7] }).match(/<li/gu)).toHaveLength(3);
  });

  it("counts what lies deeper than four levels instead of showing it", () => {
    const markup = text(
      view({ customer: { address: { city: "Springfield", geo: { point: { lat: 1, lon: 2 } } } } })
    );
    expect(markup).toContain("Customer Address City Springfield Geo Point 2 fields");
    expect(markup).not.toContain("Lat");
  });

  it("shows fifty rows of a long list, cuts a long value and bounds the whole view", () => {
    const rows = view(Array.from({ length: 60 }, (_, index) => ({ position: index + 1 })));
    expect(rows.match(/<tr/gu)).toHaveLength(51);
    expect(text(rows)).toContain("and 10 more");

    const long = "a".repeat(5000);
    expect(view({ body: long })).not.toContain(long);

    const wide = Array.from({ length: 50 }, (_, index) => [
      `section${index}`,
      Array.from({ length: 50 }, (_, row) => ({ row, label: `r${row}` }))
    ]);
    const huge = view(Object.fromEntries(wide));
    expect(huge.match(/<td/gu)?.length ?? 0).toBeLessThanOrEqual(1500);
    expect(huge.match(/<table/gu)).toHaveLength(15);
  });

  it("reads a day only where it is on the calendar", () => {
    expect(text(view({ due: "2026-02-28" }))).toContain("Due 2/28/2026");
    expect(text(view({ due: "2026-02-31" }))).toContain("Due 2026-02-31");
  });

  it("shows text in the data as text and never as markup", () => {
    const markup = view({ note: '<script>alert("x")</script>', html: "<b>bold</b>" });
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain("&lt;script&gt;");
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
  const dataPart = (data: unknown) =>
    renderToStaticMarkup(
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(DataPart, { name: "lookup", data })
      )
    );

  it("is drawn by the generic data view below the call's sentence, not as raw JSON", () => {
    const markup = renderCall({
      output: "Found one open item.",
      display: { kind: "example.unknown_kind", mode: "inline", data: { status: "open" } }
    });
    expect(markup).toContain('data-slot="generic-data-view"');
    expect(text(markup)).toContain("Found one open item. Status open");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("&quot;status&quot;");
  });

  it("is drawn by the generic data view as a data part of a message", () => {
    const markup = dataPart({ rows: [{ name: "First", count: 3 }] });
    expect(markup).toContain('data-slot="generic-data-view"');
    expect(markup).not.toContain("<pre");
  });

  it("is no display without data, and a record without a kind shows all its fields", () => {
    const empty = renderCall({ display: { kind: "example.unknown_kind", data: null } });
    expect(empty).not.toContain('data-slot="generic-data-view"');
    const part = text(dataPart({ data: ["one", "two"], total: 2 }));
    expect(part).toContain("Data one two");
    expect(part).toContain("Total 2");
  });
});
