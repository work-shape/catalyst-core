import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CodeBlock,
  CodeFile,
  CommandLine,
  UiRoot,
  uiLabelsDe,
  type CodeBlockProps,
  type CodeFileProps
} from "@vivd-catalyst/ui";

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

  // Colours and wrapping. Each test below fails without them: the props did not exist, every
  // line was one text node and a long line could only scroll.
  const textOf = (markup: string) => markup.replace(/<[^>]*>/gu, "");

  it("draws the runs of a line in their colours and changes no character of the text", () => {
    const markup = renderInRoot({
      code: "name: a\nplain\n",
      tokens: [
        [{ text: "name", color: "var(--info)", darkColor: "var(--success)" }, { text: ": a" }],
        [{ text: "plain" }]
      ]
    });

    expect(markup).toContain(
      '<span class="text-(color:--code-token) dark:text-(color:--code-token-dark)" style="--code-token:var(--info);--code-token-dark:var(--success)">name</span>: a\n'
    );
    expect(textOf(/<pre[^>]*>([\s\S]*)<\/pre>/u.exec(markup)?.[1] ?? "")).toBe("name: a\nplain\n");
    // A run without a colour is text of the line, not an element.
    expect(markup.match(/<span class="text-/gu)).toHaveLength(1);
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

  it("scrolls a long line sideways unless it is told to wrap, and numbers a wrapped line once", () => {
    const scrolling = renderInRoot({ code: "a\nb" });
    const wrapped = renderInRoot({ code: "a\nb", wrap: true });

    expect(scrolling).toContain('<pre class="py-2 [counter-reset:code-line] w-max min-w-full">');
    expect(scrolling).toContain("before:sticky");
    expect(wrapped).toContain(
      '<pre class="py-2 [counter-reset:code-line] w-full wrap-anywhere whitespace-pre-wrap">'
    );
    // The number is drawn beside the first row of its line and takes no room in the text.
    expect(wrapped).toContain("before:absolute");
    expect(wrapped).toContain("pl-12");
    expect(wrapped).not.toContain("before:sticky");
    expect(textOf(wrapped)).toBe("a\nb\n");
  });
});

describe("CodeFile", () => {
  const renderFile = (props: Partial<CodeFileProps> = {}) =>
    renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(CodeFile, {
          name: "app.yaml",
          code: "name: a\n",
          wrap: false,
          onWrapChange: () => undefined,
          ...props
        })
      )
    );

  it("heads the text with its name, a labelled switch for wrapping and a copy button", () => {
    const markup = renderFile();
    const toggle = /<button[^>]*role="switch"[^>]*>/u.exec(markup)?.[0] ?? "";
    const toggleId = /\sid="([^"]+)"/u.exec(toggle)?.[1];

    expect(toggle).toContain('aria-checked="false"');
    expect(markup).toContain(`<label for="${toggleId}"`);
    expect(markup).toContain(`>${uiLabelsDe.wrapLines}</label>`);
    expect(markup).toContain(`aria-label="${uiLabelsDe.copy}"`);
    expect(markup).toMatch(/role="region" aria-label="app\.yaml" tabindex="0"/u);
    expect(markup).toContain("w-max min-w-full");
  });

  it("wraps the text while the switch is on", () => {
    const markup = renderFile({ wrap: true });

    expect(/<button[^>]*role="switch"[^>]*>/u.exec(markup)?.[0]).toContain('aria-checked="true"');
    expect(markup).toContain("whitespace-pre-wrap");
  });

  it("shows a note beside the name only when there is one", () => {
    expect(renderFile()).not.toContain("code-file-note");
    expect(renderFile({ note: "Zu groß" })).toMatch(/data-slot="code-file-note"[^>]*>Zu groß</u);
  });
});

describe("CommandLine", () => {
  const command =
    "npm install --global @work-shape/catalyst-cli@0.6.3 && catalyst setup codex --instance https://chat.example.com";
  const renderCommand = () =>
    renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(CommandLine, { command, label: "Befehl für Codex" })
      )
    );

  it("shows the whole command, broken where it is long, beside a button that copies it", () => {
    const markup = renderCommand();
    expect(markup).toMatch(/role="region" aria-label="Befehl für Codex" tabindex="0"/u);
    expect(markup).toContain("whitespace-pre-wrap");
    expect(markup).toContain("catalyst setup codex --instance https://chat.example.com");
    expect(markup).not.toContain('data-line="1" class="block pr-4');
    expect(markup).toContain(`aria-label="${uiLabelsDe.copy}"`);
  });

  it("needs a UiRoot for its button's label", () => {
    expect(() =>
      renderToStaticMarkup(createElement(CommandLine, { command, label: "Command" }))
    ).toThrow(/CommandLine/u);
  });
});
