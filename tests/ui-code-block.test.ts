import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "@vivd-catalyst/ui";

// CodeBlock shows the text of a file, read-only. Every test here fails without the component:
// the library did not export it.

const render = (code: string) =>
  renderToStaticMarkup(createElement(CodeBlock, { code, label: "src/main.ts" }));

const linesOf = (markup: string) =>
  [...markup.matchAll(/<span data-line="(\d+)"[^>]*>([^<]*)<\/span>/gu)].map((match) => [
    Number(match[1]),
    match[2]
  ]);

describe("CodeBlock", () => {
  it("shows one numbered line per line of the text and keeps an empty line", () => {
    expect(linesOf(render("const a = 1;\n\nexport { a };"))).toEqual([
      [1, "const a = 1;\n"],
      [2, "\n"],
      [3, "export { a };\n"]
    ]);
  });

  it("counts no line after the line break a file ends with, on either kind of line end", () => {
    expect(linesOf(render("a\nb\n")).map(([number]) => number)).toEqual([1, 2]);
    expect(linesOf(render("a\r\nb\r\n"))).toEqual([
      [1, "a\n"],
      [2, "b\n"]
    ]);
    expect(linesOf(render(""))).toEqual([[1, "\n"]]);
  });

  it("shows markup in the text as text", () => {
    const markup = render('<script>alert("x")</script>');

    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("is a named region that the keyboard reaches, since it scrolls, and holds no control", () => {
    const markup = render("a");

    expect(markup).toMatch(/^<div role="region" aria-label="src\/main\.ts" tabindex="0"/u);
    expect(markup).not.toMatch(/<(?:button|input|textarea|a)\b|contenteditable/u);
  });

  it("writes no line number into the text, so a selection copies the file alone", () => {
    const markup = render("first\nsecond");

    expect(markup.replace(/<[^>]*>/gu, "")).toBe("first\nsecond\n");
    // The gutter is as wide as the highest number needs.
    expect(markup).toContain('data-digits="1"');
    expect(render(Array.from({ length: 120 }, () => "x").join("\n"))).toContain('data-digits="3"');
  });
});
