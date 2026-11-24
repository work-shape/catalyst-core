import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { diffLines, TextDiff, UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, element)
  );
}

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
    expect(render(createElement(TextDiff, { before, after: before }))).toContain(
      'data-text-diff="same"'
    );
  });
});
