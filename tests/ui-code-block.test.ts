import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CodeBlock,
  CopyText,
  UiRoot,
  uiLabelsDe,
  type CodeBlockProps,
  type CopyTextProps
} from "@work-shape/catalyst-ui";

// CodeBlock shows the text of a file, read-only; CopyText a text somebody takes elsewhere.
// Both show the text as it is stored, never as markup.

const render = (code: string) =>
  renderToStaticMarkup(createElement(CodeBlock, { code, label: "src/main.ts" }));
const renderInRoot = (props: Partial<CodeBlockProps> & { code: string }) =>
  renderToStaticMarkup(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsDe },
      createElement(CodeBlock, { label: "output.json", ...props })
    )
  );

const linesOf = (markup: string) =>
  [...markup.matchAll(/<span data-line="(\d+)"[^>]*>([^<]*)<\/span>/gu)].map((match) => [
    Number(match[1]),
    match[2]
  ]);
const textOf = (markup: string) => markup.replace(/<[^>]*>/gu, "");

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

  it("writes no line number into the text, so a selection copies the file alone", () => {
    expect(textOf(render("first\nsecond"))).toBe("first\nsecond\n");
  });

  it("cuts a longer text to its first lines and offers the rest through a button", () => {
    const markup = renderInRoot({ code: "1\n2\n3\n4\n5\n6\n", maxLines: 4 });

    expect(linesOf(markup).map(([number]) => number)).toEqual([1, 2, 3, 4]);
    expect(/<button[^>]*>/u.exec(markup)?.[0]).toContain('aria-expanded="false"');
    expect(renderInRoot({ code: "1\n2\n3\n4\n", maxLines: 4 })).not.toContain("<button");
  });

  it("changes no character of the text when it colours its runs", () => {
    const markup = renderInRoot({
      code: "name: a\nplain\n",
      tokens: [
        [{ text: "name", color: "var(--info)", darkColor: "var(--success)" }, { text: ": a" }],
        [{ text: "plain" }]
      ]
    });

    expect(textOf(/<pre[^>]*>([\s\S]*)<\/pre>/u.exec(markup)?.[1] ?? "")).toBe("name: a\nplain\n");
  });

  it("draws a line plain when its runs spell something else, so the stored text always shows", () => {
    const markup = renderInRoot({
      code: "stored\nsecond",
      tokens: [[{ text: "other", color: "var(--info)" }]]
    });

    expect(linesOf(markup)).toEqual([
      [1, "stored\n"],
      [2, "second\n"]
    ]);
  });
});

describe("CopyText", () => {
  const renderCopy = (props: CopyTextProps) =>
    renderToStaticMarkup(
      createElement(UiRoot, { mode: "light", labels: uiLabelsDe }, createElement(CopyText, props))
    );

  it("shows the text as text, with its line breaks, never as markup", () => {
    const text = "Guten Tag,\n\n  <b>fett</b> & **mehr**\n";
    const body = /data-slot="copy-text-body"[^>]*>([^<]*)</u.exec(renderCopy({ text }))?.[1];

    expect(body).toBe("Guten Tag,\n\n  &lt;b&gt;fett&lt;/b&gt; &amp; **mehr**\n");
    expect(renderCopy({ text })).not.toContain("<b>");
  });
});
