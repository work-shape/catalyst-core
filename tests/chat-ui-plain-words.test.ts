import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// UXA-1b (navigation-and-layout section 4.16): member and admin screens use the words of the
// product, never engineering terms, audit keys or error codes. Every message of the interface
// catalogs is read in English and German; a word that stays has its exception named below,
// with the reason it stays. Fails without UXA-1b: the catalogs said "operator", "release
// config", "Secret Store", "revision", "System prompt" and "widgets".

const i18n = join(dirname(fileURLToPath(import.meta.url)), "../packages/chat-ui/src/shared/i18n");
const locales = ["en", "de"] as const;
type Locale = (typeof locales)[number];

/** Each message of every translation file, by locale, as `key` and text. */
function catalog(): Record<Locale, [string, string][]> {
  const found: Record<Locale, [string, string][]> = { en: [], de: [] };
  for (const file of readdirSync(i18n).filter((name) => name.endsWith(".ts"))) {
    const path = join(i18n, file);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node, locale: Locale | undefined) => {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(source).replace(/^"|"$/gu, "");
        const next = locales.find((candidate) => candidate === name) ?? locale;
        if (
          next &&
          next === locale &&
          (ts.isStringLiteral(node.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer))
        ) {
          found[next].push([name, node.initializer.text]);
          return;
        }
        ts.forEachChild(node, (child) => visit(child, next));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, locale));
    };
    visit(source, undefined);
  }
  return found;
}

/** The refused words, each in the locales it is refused in. */
const REFUSED: { word: string; pattern: RegExp; in: readonly Locale[] }[] = [
  { word: "release config", pattern: /release[- ]?config|Release-Konfiguration/iu, in: locales },
  { word: "operator", pattern: /\boperators?\b|\bBetreiber/iu, in: locales },
  { word: "Secret Store", pattern: /secret[- ]?store/iu, in: locales },
  { word: "bearer", pattern: /\bbearer\b/iu, in: locales },
  { word: "MCP", pattern: /\bmcp\b/iu, in: locales },
  { word: "revision", pattern: /\brevisions?\b/iu, in: locales },
  { word: "System prompt", pattern: /system[- ]?prompt|Systemanweisung/iu, in: locales },
  { word: "tool calls", pattern: /\btool[- ]calls?\b|Werkzeugaufruf|Tool-Aufruf/iu, in: locales },
  { word: "widget", pattern: /\bwidgets?\b/iu, in: locales },
  { word: "audit key", pattern: /\b[a-z]+(?:_[a-z]+)*\.[a-z]+_[a-z_]+\b/u, in: locales },
  {
    word: "error code",
    pattern: /\b[A-Z]{2,}(?:_[A-Z]+)+\b|\b(?:FORBIDDEN|UNAUTHENTICATED)\b/u,
    in: locales
  },
  // German says Skill: "Fähigkeit" beside it on one screen reads as a second thing.
  { word: "Fähigkeit", pattern: /Fähigkeit/u, in: ["de"] }
];

/** Where a refused word stays, by key or key prefix, and why. */
const EXCEPTIONS: { keys: RegExp; words: readonly string[]; reason: string }[] = [
  {
    keys: /^(?:operations|jobs|modules|infrastructure)\./u,
    words: ["operator", "release config", "revision", "tool calls", "MCP"],
    reason:
      "The System group: Jobs, Operations, Modules and Infrastructure are shown only to the team that runs the instance (ruling 2 of section 4.16)."
  },
  {
    keys: /^(?:connectionCreate\.(?:mcpTitle|mcpHeading|proposalCardMcp)|connections\.(?:serverDescription|urlHint|exposeOutside)|guardrails\.runs\.byMcp)$/u,
    words: ["MCP"],
    reason:
      "MCP server is the kind of Connection a builder picks and the client an outside tool connects as; the provider names it so."
  },
  {
    keys: /^(?:connectionCreate\.sendAsBearer|connections\.authBearer)$/u,
    words: ["bearer"],
    reason: "The header a REST API receives, in the words its provider's documentation uses."
  },
  {
    keys: /^personalApiKeys\.createdDescription$/u,
    words: ["error code"],
    reason: "CATALYST_API_KEY is the variable the person sets for the CLI; it is no error code."
  }
];

/** The text a person reads: the placeholders a message fills in are not its words. */
const said = (text: string) => text.replace(/\{[^}]*\}/gu, "");

describe("plain words in the interface (UXA-1b)", () => {
  const messages = catalog();

  it("reads both catalogs", () => {
    for (const locale of locales) expect(messages[locale].length).toBeGreaterThan(1000);
  });

  it.each(REFUSED.map((rule) => [rule.word, rule] as const))(
    "says no %s outside its named exceptions",
    (word, rule) => {
      const found = rule.in.flatMap((locale) =>
        messages[locale]
          .filter(([key, text]) => rule.pattern.test(said(text)) && !excepted(key, word))
          .map(([key, text]) => `${locale} ${key}: ${text}`)
      );
      expect(found).toEqual([]);
    }
  );

  it.each(EXCEPTIONS.map((exception) => [exception.reason, exception] as const))(
    "keeps each exception in use: %s",
    (_reason, exception) => {
      for (const word of exception.words) {
        const rule = REFUSED.find((candidate) => candidate.word === word);
        expect(rule, word).toBeDefined();
      }
      const used = locales.some((locale) =>
        messages[locale].some(
          ([key, text]) =>
            exception.keys.test(key) &&
            exception.words.some((word) =>
              REFUSED.find((rule) => rule.word === word)?.pattern.test(said(text))
            )
        )
      );
      expect(used, String(exception.keys)).toBe(true);
    }
  );
});

function excepted(key: string, word: string): boolean {
  return EXCEPTIONS.some((exception) => exception.keys.test(key) && exception.words.includes(word));
}
