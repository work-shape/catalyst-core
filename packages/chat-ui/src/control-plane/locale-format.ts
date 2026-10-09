import type { LocaleCode } from "@vivd-catalyst/api-client";

/** A moment as date and time, written the way the reader's language writes it. */
export function formatDateTime(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleString(locale);
}
