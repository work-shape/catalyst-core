import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "@work-shape/catalyst-ui";
import {
  codeColouring,
  HIGHLIGHT_MAX_CHARS,
  HIGHLIGHT_MAX_LINES,
  highlightCode,
  StoredFileView
} from "@work-shape/catalyst-chat-ui/pages";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// A stored file shows in the colours of its language, through the highlighter the chat's code
// blocks use. Every test here fails without that: a file was drawn as one colour of text.

/** The colours of a text, awaited the way the view receives them once the grammar is there. */
function coloured(path: string, text: string) {
  const colouring = codeColouring(path, text);
  if (colouring.kind !== "language") {
    throw new Error(`${path} is not coloured`);
  }
  return new Promise<NonNullable<ReturnType<typeof highlightCode>>>((resolve) => {
    const known = highlightCode(text, colouring.language, resolve);
    if (known) {
      resolve(known);
    }
  });
}

const colouredRuns = (markup: string) =>
  [
    ...markup.matchAll(
      /<span class="text-\(color:--code-token\)[^"]*" style="--code-token:(#[0-9A-Fa-f]{3,8});--code-token-dark:(#[0-9A-Fa-f]{3,8})">([^<]*)<\/span>/gu
    )
  ].map((match) => match[3]);

const textOf = (markup: string) =>
  (/<pre[^>]*>([\s\S]*)<\/pre>/u.exec(markup)?.[1] ?? "")
    .replace(/<[^>]*>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'")
    .replace(/&amp;/gu, "&");

describe("the colours of a stored file", () => {
  it("colours the tags, attributes and strings of an html file and keeps its text", async () => {
    const html = '<!doctype html>\n<main class="app">\n  <h1>Net pay</h1>\n</main>\n';
    const markup = renderToStaticMarkup(
      createElement(CodeBlock, {
        label: "index.html",
        code: html,
        tokens: await coloured("index.html", html)
      })
    );

    expect(colouredRuns(markup)).toEqual(expect.arrayContaining(["main", "class", "h1"]));
    expect(colouredRuns(markup)).toContain("&quot;app&quot;");
    expect(textOf(markup)).toBe(html);
  });

  it("reads the language from the end of the file's name and colours nothing it does not know", () => {
    const language = (path: string) => {
      const colouring = codeColouring(path, "x");
      return colouring.kind === "language" ? colouring.language : colouring.kind;
    };

    expect(["index.html", "a/style.CSS", "src/routes/index.tsx"].map(language)).toEqual([
      "html",
      "css",
      "tsx"
    ]);
    expect(["notes.txt", "a.b/Makefile"].map(language)).toEqual(["plain", "plain"]);
  });

  it("leaves a file past either bound plain", () => {
    const long = "a".repeat(HIGHLIGHT_MAX_CHARS + 1);
    const many = "a\n".repeat(HIGHLIGHT_MAX_LINES);

    expect(codeColouring("model.js", long).kind).toBe("too-large");
    expect(codeColouring("model.js", many).kind).toBe("too-large");
    expect(codeColouring("model.js", "a\n".repeat(HIGHLIGHT_MAX_LINES - 1)).kind).toBe("language");
    // A large file in no known language has nothing to say about colours.
    expect(codeColouring("notes.txt", long).kind).toBe("plain");
  });
});

describe("StoredFileView", () => {
  const view = (path: string, text: string) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(StoredFileView, { path, text })
      })
    );

  it("keeps a very large file plain", () => {
    const markup = view("model.js", `${"a".repeat(HIGHLIGHT_MAX_CHARS)}\nlast\n`);

    expect(markup).not.toContain("--code-token");
    expect(textOf(markup).endsWith("\nlast\n")).toBe(true);
  });
});
