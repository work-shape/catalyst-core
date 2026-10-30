import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChangeList,
  ChangeTag,
  diffLines,
  DraftHeader,
  TextDiff,
  UiRoot,
  uiLabelsDe,
  uiLabelsEn
} from "@work-shape/catalyst-ui";

function render(element: ReactElement, labels = uiLabelsEn): string {
  return renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, element));
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

describe("the head of a draft (DT-1b)", () => {
  it("says what a call of the draft does, and names each test target after it", () => {
    const markup = render(
      createElement(DraftHeader, {
        targets: [
          {
            name: "Invoices",
            kind: "copy",
            link: createElement("a", { href: "/stores/invoices" })
          },
          { name: "Mail", kind: "credential" }
        ],
        live: { version: 4, by: "Anna Beispiel", at: "Oct 12" }
      })
    );
    expect(text(markup)).toBe(
      "Draft · reads live data · changes are simulated · Invoices: test copy · Mail: test credential Live: version 4, published by Anna Beispiel on Oct 12"
    );
    expect(markup).toMatch(/<a href="\/stores\/invoices"[^>]*data-draft-test-target="copy"/u);
    expect(markup).toMatch(/<span data-draft-test-target="credential">Mail: test credential/u);
  });

  it("says nothing is live where nothing is published, and leaves out a live line not known", () => {
    expect(text(render(createElement(DraftHeader, { live: null })))).toContain("Not published yet");
    expect(render(createElement(DraftHeader, {}))).not.toContain("data-draft-live");
    expect(text(render(createElement(DraftHeader, { live: { version: 2 } })))).toContain(
      "Live: version 2"
    );
    expect(
      text(render(createElement(DraftHeader, { live: { version: 2, at: "Oct 1" } })))
    ).toContain("Live: version 2, published on Oct 1");
  });

  it("speaks the reader's language", () => {
    const markup = render(
      createElement(DraftHeader, {
        targets: [{ name: "Rechnungen", kind: "copy" }],
        live: { version: 3, by: "Anna Beispiel" }
      }),
      uiLabelsDe
    );
    expect(text(markup)).toBe(
      "Entwurf · liest Live-Daten · Änderungen werden simuliert · Rechnungen: Testkopie Live: Version 3, veröffentlicht von Anna Beispiel"
    );
  });
});

describe("what a draft changes against what is live", () => {
  it("tags each part new, changed or removed, and a part without a change not at all", () => {
    const markup = render(
      createElement(ChangeList, {
        items: [
          { id: "a", label: "Write the invoice", change: "new" },
          { id: "b", label: "Send the reminder", change: "changed" },
          { id: "c", label: "Read the customers" }
        ]
      })
    );
    expect(markup).toMatch(/data-change-item="a"[^]*?data-change-tag="new"[^>]*>New</u);
    expect(markup).toMatch(/data-change-item="b"[^]*?data-change-tag="changed"[^>]*>Changed</u);
    expect(markup.match(/data-change-tag=/gu)).toHaveLength(2);
    expect(render(createElement(ChangeTag, { change: "removed" }))).toContain(">Removed<");
  });
});

describe("a text against the live text", () => {
  it("finds the lines added and removed, numbered on their own side", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a", before: 1, after: 1 },
      { kind: "removed", text: "b", before: 2 },
      { kind: "added", text: "B", after: 2 },
      { kind: "same", text: "c", before: 3, after: 3 },
      { kind: "added", text: "d", after: 4 }
    ]);
    // A new file is all added; a removed one all removed.
    expect(diffLines(undefined, "x\ny").map((line) => line.kind)).toEqual(["added", "added"]);
    expect(diffLines("x", undefined).map((line) => line.kind)).toEqual(["removed"]);
  });

  it("folds long runs of unchanged lines and says so where nothing differs", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const markup = render(createElement(TextDiff, { before, after }));
    expect(markup).toContain('data-text-diff="changed"');
    expect(markup.match(/data-diff-line="added"/gu)).toHaveLength(1);
    expect(markup.match(/data-diff-line="removed"/gu)).toHaveLength(1);
    // Three lines of context each side; the rest folds, said in words.
    expect(markup).toContain('data-diff-fold="6"');
    expect(markup).toContain("6 unchanged lines");
    expect(markup).toContain('<span class="sr-only">Added: </span>');
    expect(render(createElement(TextDiff, { before, after: before }))).toContain("No differences.");
  });
});
