import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CodeBlock } from "@work-shape/catalyst-ui";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
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

const { t } = createTranslationContext("en");

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

  it("colours the keys and values of a yaml file, and leaves punctuation in the text colour", async () => {
    const yaml = "name: payroll\nactions:\n  - id: calc # the sum\n";
    const tokens = await coloured("app.yaml", yaml);
    const markup = renderToStaticMarkup(
      createElement(CodeBlock, { label: "app.yaml", code: yaml, tokens })
    );

    expect(colouredRuns(markup)).toEqual(
      expect.arrayContaining(["name", "payroll", "actions", "id", "# the sum"])
    );
    // What the theme draws in its own text colour takes the product's instead.
    expect(tokens[0]).toContainEqual({ text: ": " });
    expect(textOf(markup)).toBe(yaml);
  });

  it("reads the language from the end of the file's name and colours nothing it does not know", () => {
    const language = (path: string) => {
      const colouring = codeColouring(path, "x");
      return colouring.kind === "language" ? colouring.language : colouring.kind;
    };

    expect(
      [
        "index.html",
        "a/style.CSS",
        "model.js",
        "worker.mjs",
        "src/routes/index.tsx",
        "lib.ts",
        "data.json",
        "app.yaml",
        "ci.yml",
        "README.md",
        "steps/query.sql",
        "steps/run.py"
      ].map(language)
    ).toEqual([
      "html",
      "css",
      "javascript",
      "javascript",
      "tsx",
      "typescript",
      "json",
      "yaml",
      "yaml",
      "markdown",
      "sql",
      "python"
    ]);
    expect(["notes.txt", "LICENSE", "a.b/Makefile", ".env"].map(language)).toEqual([
      "plain",
      "plain",
      "plain",
      "plain"
    ]);
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

  it("shows a file as plain text at once, unwrapped, with the switch off and a copy button", () => {
    const markup = view("index.html", "<p>a</p>\n");

    expect(textOf(markup)).toBe("<p>a</p>\n");
    expect(markup).not.toContain("--code-token");
    expect(/<button[^>]*role="switch"[^>]*>/u.exec(markup)?.[0]).toContain('aria-checked="false"');
    expect(markup).toContain("w-max min-w-full");
    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toContain(t("pages.fileTooLargeToColour"));
  });

  it("keeps a very large file plain and says so quietly", () => {
    const markup = view("model.js", `${"a".repeat(HIGHLIGHT_MAX_CHARS)}\nlast\n`);

    expect(markup).toContain(`>${t("pages.fileTooLargeToColour")}</span>`);
    expect(markup).not.toContain("--code-token");
    expect(textOf(markup).endsWith("\nlast\n")).toBe(true);
  });
});
