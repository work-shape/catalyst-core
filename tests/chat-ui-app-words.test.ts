import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// NAME-1, check 57 of apps-and-pages: a member reads one noun for what an agent builds, App.
// The words of the Apps list, the draft page, the preview panel and the save steps say "App",
// "Entwurf" and "Vorschau", never "Page" or "Seite", in English and in German. Fails without
// NAME-1: those areas said "Page" in both languages.

const i18n = join(dirname(fileURLToPath(import.meta.url)), "../packages/chat-ui/src/shared/i18n");
const locales = ["en", "de"] as const;
type Locale = (typeof locales)[number];

/** Each message of a translation file, by locale and key. */
function messages(file: string): Record<Locale, Map<string, string>> {
  const path = join(i18n, file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const found: Record<Locale, Map<string, string>> = { en: new Map(), de: new Map() };
  const visit = (node: ts.Node, locale: Locale | undefined) => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(source).replace(/^"|"$/gu, "");
      const next = locales.find((candidate) => candidate === name) ?? locale;
      if (next && next === locale && ts.isStringLiteral(node.initializer)) {
        found[next].set(name, node.initializer.text);
        return;
      }
      ts.forEachChild(node, (child) => visit(child, next));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, locale));
  };
  visit(source, undefined);
  return found;
}

/** The word "Page" or "Seite", outside the placeholders a message fills in. */
const PAGE_WORD = /\b(?:pages?|seiten?)\b/iu;
const said = (text: string) => text.replace(/\{[^}]*\}/gu, "");

describe("the words of Apps, the preview and saving", () => {
  const areas = {
    "apps.ts": () => true,
    "pages.ts": () => true,
    "tools.ts": (key: string) => key.startsWith("assetToolApp")
  };

  it.each(Object.entries(areas))("say App and never Page or Seite in %s", (file, keeps) => {
    const read = messages(file);
    for (const locale of locales) {
      const words = [...read[locale]].filter(([key]) => keeps(key));
      expect(words.length, `${file} ${locale} holds no message`).toBeGreaterThan(0);
      expect(
        words.filter(([, text]) => PAGE_WORD.test(said(text))),
        `${file} ${locale}`
      ).toEqual([]);
    }
  });

  it("let the empty Apps list say a saved App is its builder's, and that publishing decides who else", () => {
    const { en, de } = messages("apps.ts");

    expect(en.get("apps.empty")).toBe(
      "No apps in this workspace yet. Describe a tool in chat and the agent builds it. Saved as an app, it is yours to use; publishing it decides who else sees it."
    );
    expect(de.get("apps.empty")).toBe(
      "In diesem Arbeitsbereich gibt es noch keine Apps. Beschreibe im Chat ein Werkzeug, und der Agent baut es. Speicherst du es als App, gehört sie dir; beim Veröffentlichen legst du fest, wer sie noch sieht."
    );
    // The sentence it replaces said that saving made the App everyone's.
    expect(en.get("apps.empty")).not.toMatch(/everyone/u);
    expect(de.get("apps.empty")).not.toMatch(/\balle\b/u);
  });
});
