import type { LocaleCode } from "@vivd-catalyst/api-client";

/** A moment as date and time, written the way the reader's language writes it. */
export function formatDateTime(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleString(locale);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago a moment was, in the largest whole unit: "5 min", "3 hr", "2 days". */
export function formatElapsed(since: string, now: Date, locale: LocaleCode): string {
  const elapsedMs = Math.max(0, now.getTime() - new Date(since).getTime());
  const [unit, size] =
    elapsedMs >= DAY_MS
      ? (["day", DAY_MS] as const)
      : elapsedMs >= HOUR_MS
        ? (["hour", HOUR_MS] as const)
        : elapsedMs >= MINUTE_MS
          ? (["minute", MINUTE_MS] as const)
          : (["second", 1000] as const);
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(
    Math.floor(elapsedMs / size)
  );
}
