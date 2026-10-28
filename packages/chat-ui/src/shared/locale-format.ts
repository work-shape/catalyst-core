import type { LocaleCode } from "@work-shape/catalyst-api-client";

/** A moment as date and time, written the way the reader's language writes it. */
export function formatDateTime(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleString(locale);
}

/**
 * A moment as a sentence names it: the day in words and the time without seconds. Without a
 * time zone it is the reader's.
 */
export function formatMoment(value: string, locale: LocaleCode, timeZone?: string): string {
  return new Date(value).toLocaleString(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone
  });
}

/** The time of day of a moment, without seconds: "10:47" in German, "10:47 AM" in English. */
export function formatTimeOfDay(value: string, locale: LocaleCode, timeZone?: string): string {
  return new Date(value).toLocaleTimeString(locale, { timeStyle: "short", timeZone });
}

/** The day of the week a moment falls on, in words: "Sonntag", "Sunday". */
export function formatWeekday(value: string, locale: LocaleCode, timeZone?: string): string {
  return new Date(value).toLocaleDateString(locale, { weekday: "long", timeZone });
}

/** A moment in a row that has little room: the month shortened, the time without seconds. */
export function formatMomentShort(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The day of a moment in a badge: "26. Okt.", "Oct 26", with the year where it is not this
 * year's.
 */
export function formatDayShort(value: string, locale: LocaleCode, now = new Date()): string {
  const date = new Date(value);
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" })
  });
}

/**
 * A short moment with the name of the reader's zone it is shown in, such as "18. Okt. 2026,
 * 23:34 MESZ": where a schedule names its own zone, the reader can compare the two.
 */
export function formatMomentShortZoned(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

/** The day of a moment, and its time of day: the two lines of a moment in a narrow column. */
export function formatDate(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleDateString(locale);
}

export function formatTime(value: string, locale: LocaleCode): string {
  return new Date(value).toLocaleTimeString(locale);
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

/** How long something took, to the second: "45 s", "3 min 2 s", "1 hr 4 min". */
export function formatDuration(ms: number, locale: LocaleCode): string {
  const unit = (value: number, name: "second" | "minute" | "hour") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short" }).format(
      value
    );
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0
      ? unit(minutes, "minute")
      : `${unit(minutes, "minute")} ${unit(rest, "second")}`;
  }
  const rest = minutes % 60;
  const hours = Math.floor(minutes / 60);
  return rest === 0 ? unit(hours, "hour") : `${unit(hours, "hour")} ${unit(rest, "minute")}`;
}
