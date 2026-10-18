import type { JsonValue } from "./json";
import type { RecordEvidenceResult } from "@work-shape/catalyst-asset-schemas";

/** Compare retained text and citations without layout or Unicode encoding differences. */
function normalise(text: string, keepLineHyphen = false): string {
  return text
    .normalize("NFC")
    .replace(/(\p{L})[-\u00ad][\t ]*\r?\n\s*(?=\p{L})/gu, keepLineHyphen ? "$1-" : "$1")
    .replaceAll("\u00ad", "")
    .replace(/\s+/gu, " ")
    .trim();
}

function wordsInclude(text: string, value: string): boolean {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(text);
}

function numberFrom(token: string, locale: string): number | undefined {
  const german = locale.startsWith("de");
  const grouping = german ? "\\." : ",";
  const decimal = german ? "," : "\\.";
  const syntax = new RegExp(
    `^[+-]?(?:\\d+|\\d{1,3}(?:${grouping}\\d{3})+)(?:${decimal}\\d+)?$`,
    "u"
  );
  if (!syntax.test(token)) return undefined;
  return Number(german ? token.replaceAll(".", "").replace(",", ".") : token.replaceAll(",", ""));
}

function valueInQuote(value: JsonValue, quote: string, locale: string): boolean {
  if (typeof value === "string") {
    const text = normalise(value);
    const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
    if (date) {
      if (wordsInclude(quote, text)) return true;
      const matches = [
        ...quote.matchAll(/(?<![\p{L}\p{N}])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/gu)
      ].map(([, day, month, year]) => ({ day: Number(day), month: Number(month), year }));
      const months = [
        ["Januar", "January"],
        ["Februar", "February"],
        ["März", "March"],
        ["April"],
        ["Mai", "May"],
        ["Juni", "June"],
        ["Juli", "July"],
        ["August"],
        ["September"],
        ["Oktober", "October"],
        ["November"],
        ["Dezember", "December"]
      ];
      for (const [index, names] of months.entries()) {
        const name = `(?:${names.join("|")})`;
        for (const [, day, year] of quote.matchAll(
          new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})\\.? ${name} (\\d{4})(?!\\d)`, "giu")
        ))
          matches.push({ day: Number(day), month: index + 1, year });
        for (const [, day, year] of quote.matchAll(
          new RegExp(`(?<![\\p{L}\\p{N}])${name} (\\d{1,2}),? (\\d{4})(?!\\d)`, "giu")
        ))
          matches.push({ day: Number(day), month: index + 1, year });
      }
      return matches.some(
        ({ day, month, year }) =>
          year === date[1] && month === Number(date[2]) && day === Number(date[3])
      );
    }
    return wordsInclude(quote, text);
  }
  if (typeof value === "number") {
    // Keep OCR letters inside the token: '35O.OOO' must never become the number 35.
    return [...quote.matchAll(/(?<![\p{L}\p{N}_.,])[+-]?\d[\p{L}\p{N}.,]*/gu)].some(([raw]) => {
      const token = raw.replace(/[.,]+$/u, "");
      const primary = numberFrom(token, locale);
      if (primary !== undefined) return primary === value;
      // A separator followed by three digits is locale-ambiguous; never guess the other reading.
      if (/[.,]\d{3}(?:[.,]|$)/u.test(token)) return false;
      return numberFrom(token, locale.startsWith("de") ? "en" : "de") === value;
    });
  }
  if (Array.isArray(value))
    return value.length > 0 && value.every((item) => valueInQuote(item, quote, locale));
  return wordsInclude(quote, JSON.stringify(value));
}

/** Recheck at the write boundary: a caller cannot claim its own evidence passed. */
export function recordEvidence(
  value: JsonValue,
  quote: string,
  page: string | undefined,
  locale = "de"
): RecordEvidenceResult {
  if (page === undefined) return { status: "failed", reason: "page_not_found" };
  const quotes = [normalise(quote), normalise(quote, true)].filter(
    (text) =>
      text &&
      [normalise(page), normalise(page, true)].some((pageText) => wordsInclude(pageText, text))
  );
  if (!quotes.length) return { status: "failed", reason: "quote_not_found" };
  if (!quotes.some((text) => valueInQuote(value, text, locale)))
    return { status: "failed", reason: "value_not_parsed" };
  return { status: "passed" };
}
