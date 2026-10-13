import { code, type HighlightOptions, type HighlightResult } from "@streamdown/code";
import { useEffect, useState } from "react";
import type { CodeToken } from "@vivd-catalyst/ui";

/**
 * The one highlighter of the interface: the Shiki plugin the chat's Markdown draws its code
 * blocks with. A stored file is coloured by the same instance, in the same two themes, so a
 * grammar is loaded once for both and no second highlighter is bundled. Each grammar is a
 * chunk of its own that is asked for when the first text in that language shows. Of Shiki's
 * types only the name of a language leaves this file.
 */
export const codeHighlighter = code;

/** The light and the dark theme of every highlighted text in the interface. */
export const CODE_THEMES: HighlightOptions["themes"] = ["github-light", "github-dark"];

/** A language the highlighter has a grammar for. */
type CodeLanguage = HighlightOptions["language"];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = {
  html: "html",
  htm: "html",
  css: "css",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  py: "python",
  sh: "bash",
  xml: "xml",
  svg: "xml",
  toml: "toml"
};

/**
 * Past either bound a text stays plain. The grammar runs on the thread that draws the page,
 * and a text of this size holds it for about a second.
 */
export const HIGHLIGHT_MAX_CHARS = 200_000;
export const HIGHLIGHT_MAX_LINES = 5000;

/** How a stored file is coloured: in a language, not at all, or not because of its size. */
export type CodeColouring =
  { kind: "language"; language: CodeLanguage } | { kind: "plain" } | { kind: "too-large" };

/** Decides by the file's name and size alone; the text is not read for its language. */
export function codeColouring(path: string, text: string): CodeColouring {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const language = dot < 0 ? undefined : LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
  if (language === undefined) {
    return { kind: "plain" };
  }
  if (text.length > HIGHLIGHT_MAX_CHARS || exceedsLines(text, HIGHLIGHT_MAX_LINES)) {
    return { kind: "too-large" };
  }
  return { kind: "language", language };
}

function exceedsLines(text: string, limit: number): boolean {
  let lines = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    lines += 1;
    if (lines > limit) {
      return true;
    }
  }
  return false;
}

type TokenLines = CodeToken[][];

/** Where the plugin keeps a token's colour in the dark theme. */
const DARK = "--shiki-dark";

/**
 * The plugin's tokens as the library's `CodeBlock` takes them. A token in the theme's own
 * text colour carries no colour, so it takes the product's text colour in either mode.
 */
function tokenLines(result: HighlightResult): TokenLines {
  const [light, ...rest] = (result.fg ?? "").split(";");
  const dark = rest.find((part) => part.startsWith(DARK))?.slice(DARK.length + 1);
  return result.tokens.map((line) =>
    line.map((token): CodeToken => {
      const style = token.htmlStyle ?? {};
      const color = style.color;
      const darkColor = style[DARK];
      const own = !sameColor(color, light) || !sameColor(darkColor, dark);
      return {
        text: token.content,
        ...(own && color !== undefined ? { color, darkColor } : {}),
        ...(style["--shiki-light-font-style"] === "italic" ? { italic: true } : {}),
        ...(style["--shiki-light-font-weight"] === "bold" ? { bold: true } : {})
      };
    })
  );
}

const sameColor = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Colours a text. The answer comes at once when the same text was coloured before, and
 * through `onReady` otherwise, after the grammar has loaded. A grammar that fails to load
 * answers never, and the text stays plain.
 */
export function highlightCode(
  text: string,
  language: CodeLanguage,
  onReady: (lines: TokenLines) => void
): TokenLines | undefined {
  const result = codeHighlighter.highlight({ code: text, language, themes: CODE_THEMES }, (ready) =>
    onReady(tokenLines(ready))
  );
  return result ? tokenLines(result) : undefined;
}

/**
 * The colours of a stored file, or nothing while the grammar loads and where the file is
 * shown plain. The text shows at once either way.
 */
export function useCodeTokens(text: string, colouring: CodeColouring): TokenLines | undefined {
  const language = colouring.kind === "language" ? colouring.language : undefined;
  const [ready, setReady] = useState<{ text: string; language: CodeLanguage; lines: TokenLines }>();

  useEffect(() => {
    if (language === undefined) {
      return;
    }
    let shown = true;
    const show = (lines: TokenLines) => {
      if (shown) {
        setReady({ text, language, lines });
      }
    };
    const known = highlightCode(text, language, show);
    if (known) {
      show(known);
    }
    return () => {
      shown = false;
    };
  }, [text, language]);

  return ready && ready.text === text && ready.language === language ? ready.lines : undefined;
}
