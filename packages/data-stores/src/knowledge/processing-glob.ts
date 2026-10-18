import { Minimatch } from "minimatch";
import type { KnowledgeProcessingRule } from "@work-shape/catalyst-core";

type Match = KnowledgeProcessingRule["match"];
const matchers = new WeakMap<Match, Partial<Record<keyof Match, RegExp[]>>>();
const unicodeRanges = new Map<string, string>();

/** One compiler for ingestion and SQL review, with characters counted as Unicode codepoints. */
export function processingMatchers(match: Match) {
  const cached = matchers.get(match);
  if (cached) return cached;
  const compiled = Object.fromEntries(
    Object.entries(match).map(([field, patterns]) => [
      field,
      patterns.map((pattern) => {
        const regex = new Minimatch(pattern, { nonegate: true, nocomment: true }).makeRe();
        // Minimatch escapes some punctuation that /u disallows outside character classes.
        const source = regex
          ? regex.source.replace(
              /\\([# ,\-])/gu,
              (_, char: string) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`
            )
          : "(?!)";
        return new RegExp(source, "u");
      })
    ])
  );
  matchers.set(match, compiled);
  return compiled;
}
export function matchesProcessing(
  match: Match,
  item: { path: string; name: string; mime: string }
) {
  return (["path", "name", "mime"] as const).every((field) => {
    const patterns = processingMatchers(match)[field];
    return (
      !patterns ||
      patterns.some(
        (pattern) =>
          pattern.test(item[field]) ||
          (field === "path" && pattern.test(item.path.replace(/^\//u, "")))
      )
    );
  });
}

/** PostgreSQL ARE has the same lookaheads and groups, but no JS Unicode property escapes.
 * Expand those classes once per property using this runtime's Unicode table, so database
 * locale and JS never disagree about POSIX glob classes. SQL text cannot contain NUL/surrogates.
 */
function unicodeRange(escape: string) {
  const cached = unicodeRanges.get(escape);
  if (cached) return cached;
  const matcher = new RegExp(escape, "u");
  const ranges: string[] = [];
  let start: number | undefined;
  const escapedCode = (code: number) => `\\U${code.toString(16).padStart(8, "0")}`;
  for (let code = 1; code <= 0x110000; code++) {
    const matches =
      code < 0x110000 &&
      !(code >= 0xd800 && code <= 0xdfff) &&
      matcher.test(String.fromCodePoint(code));
    if (matches && start === undefined) start = code;
    if (!matches && start !== undefined) {
      ranges.push(
        start === code - 1 ? escapedCode(start) : `${escapedCode(start)}-${escapedCode(code - 1)}`
      );
      start = undefined;
    }
  }
  const source = ranges.join("");
  unicodeRanges.set(escape, source);
  return source;
}

export function processingSqlPattern(pattern: RegExp) {
  // JS dot excludes line terminators while negated classes include them. ARE's newline
  // modes cannot express both together; spell out dot and keep anchors absolute.
  // Translate real escapes in one pass: a literal \x41 must not become \u0041.
  let source = "";
  let inClass = false;
  for (let index = 0; index < pattern.source.length; index++) {
    const char = pattern.source[index];
    if (char === "\\") {
      const next = pattern.source[index + 1];
      const hex = pattern.source.slice(index + 2, index + 4);
      const property = pattern.source.slice(index + 1).match(/^[pP]\{[A-Za-z]+\}/u)?.[0];
      if (next === "x" && /^[a-f0-9]{2}$/iu.test(hex)) {
        source += `\\u00${hex}`;
        index += 3;
      } else if (property) {
        const range = unicodeRange(`\\${property}`);
        source += inClass ? range : `[${range}]`;
        index += property.length;
      } else {
        source += char + next;
        index++;
      }
      continue;
    }
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    source += !inClass && char === "." ? "[^\\n\\r\\u2028\\u2029]" : char;
  }
  return `(?s)${source}`;
}
