import type { LocaleCode } from "@work-shape/catalyst-api-client";

/**
 * An estimated embedding cost as a person reads it: cents from one unit up, below it two
 * significant digits, so a small estimate never reads as a bare 0. A re-index's statement and
 * a first import's confirmation show it alike.
 */
export function formatEmbeddingCost(amount: number, currency: string, locale: LocaleCode): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    ...(amount >= 1 || amount === 0 ? {} : { maximumSignificantDigits: 2 })
  }).format(amount);
}

/** A size in bytes as a person reads it: megabytes, or gigabytes from one up. */
export function formatStoreBytes(bytes: number, locale: LocaleCode): string {
  const giga = bytes >= 1_000_000_000;
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: giga ? "gigabyte" : "megabyte",
    maximumFractionDigits: 1
  }).format(bytes / (giga ? 1_000_000_000 : 1_000_000));
}
