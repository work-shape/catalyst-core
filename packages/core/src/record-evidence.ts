import type { JsonValue } from "./json";
import type { RecordEvidenceResult } from "@work-shape/catalyst-asset-schemas";

function valueInQuote(value: JsonValue, quote: string): boolean {
  if (typeof value === "string") {
    if (!value) return false;
    const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (date) return quote.includes(value) || quote.includes(`${date[3]}.${date[2]}.${date[1]}`);
    return quote.includes(value);
  }
  if (typeof value === "number") {
    // Parse both decimal conventions, including spaces used as grouping separators.
    return [...quote.matchAll(/[+-]?\d+(?:[.,\s\u00a0]\d+)*/gu)].some(([token]) => {
      const compact = token.replace(/[\s\u00a0]/gu, "");
      const forms = [
        compact,
        compact.replaceAll(".", "").replace(",", "."),
        compact.replaceAll(",", "")
      ];
      return forms.some((form) => Number(form) === value);
    });
  }
  if (Array.isArray(value)) return value.every((item) => valueInQuote(item, quote));
  return quote.includes(JSON.stringify(value));
}

/** Recheck at the write boundary: a caller cannot claim its own evidence passed. */
export function recordEvidence(
  value: JsonValue,
  quote: string,
  page: string | undefined
): RecordEvidenceResult {
  if (page === undefined) return { status: "failed", reason: "page_not_found" };
  if (!page.includes(quote)) return { status: "failed", reason: "quote_not_found" };
  if (!valueInQuote(value, quote)) return { status: "failed", reason: "value_not_parsed" };
  return { status: "passed" };
}
