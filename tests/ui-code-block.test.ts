import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock, UiRoot, uiLabelsDe, type CodeBlockProps } from "@vivd-catalyst/ui";

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

  // The cut, the footer and the unnumbered form. Each test below fails without them: the props
  // did not exist, and every line of a text was drawn.
  const renderInRoot = (props: Partial<CodeBlockProps> & { code: string }) =>
    renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(CodeBlock, { label: "output.json", ...props })
      )
    );
  const sixLines = "1\n2\n3\n4\n5\n6\n";

  it("cuts a longer text to its first lines and offers the rest through a button it controls", () => {
    const markup = renderInRoot({ code: sixLines, maxLines: 4 });
    const regionId = /<div role="region"[^>]*\sid="([^"]+)"/u.exec(markup)?.[1];
    const toggle = /<button[^>]*>([^<]*)<\/button>/u.exec(markup);

    expect(linesOf(markup).map(([number]) => number)).toEqual([1, 2, 3, 4]);
    expect(regionId).toBeDefined();
    expect(toggle?.[0]).toContain('aria-expanded="false"');
    expect(toggle?.[0]).toContain(`aria-controls="${regionId}"`);
    expect(toggle?.[0]).toContain('type="button"');
    expect(toggle?.[1]).toBe(uiLabelsDe.showMore);
  });

  it("shows no button for a text that fits, and needs no UiRoot then", () => {
    const fits = render("1\n2\n3\n4\n");
    const exact = renderToStaticMarkup(
      createElement(CodeBlock, { code: "1\n2\n3\n4\n", label: "output.json", maxLines: 4 })
    );

    expect(exact).not.toContain("<button");
    expect(linesOf(exact)).toEqual(linesOf(fits));
    expect(() =>
      renderToStaticMarkup(
        createElement(CodeBlock, { code: sixLines, label: "output.json", maxLines: 4 })
      )
    ).toThrow(/CodeBlock must be rendered inside UiRoot/u);
  });

  it("keeps the gutter of the whole text while it is cut, so showing the rest moves no line", () => {
    const code = Array.from({ length: 120 }, () => "x").join("\n");

    expect(renderInRoot({ code, maxLines: 5 })).toContain('data-digits="3"');
  });

  it("puts the footer under the block, outside the region that holds the text", () => {
    const markup = renderInRoot({ code: "a", footer: "Gekürzt." });

    expect(markup).toMatch(
      /<\/pre><\/div><div class="[^"]*text-caption text-muted-foreground[^"]*"><p data-slot="code-block-footer"[^>]*>Gekürzt\.<\/p><\/div>/u
    );
    expect(markup).not.toContain("<button");
  });

  it("draws no line numbers when they are turned off", () => {
    const markup = renderInRoot({ code: "a\nb", lineNumbers: false });

    expect(markup).not.toContain("counter(code-line)");
    expect(markup).not.toContain("data-digits");
    expect(linesOf(markup)).toEqual([
      [1, "a\n"],
      [2, "b\n"]
    ]);
  });
});
