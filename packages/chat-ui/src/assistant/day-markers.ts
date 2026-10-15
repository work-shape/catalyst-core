import type { LocaleCode } from "@vivd-catalyst/api-client";
import { formatMoment, formatTimeOfDay, formatWeekday } from "../control-plane/locale-format";
import type { TranslationContextValue } from "../i18n";

const DAY_MS = 86_400_000;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar day a moment falls on in a time zone, the reader's without one, counted in days
 * from 1 January 1970. Two moments of one day give the same number, whatever the day's length.
 */
export function calendarDay(at: Date, timeZone?: string): number {
  const key = timeZone ?? "";
  let format = dayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric"
    });
    dayFormats.set(key, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS);
}

/** A message of the transcript, in its order, with the moment it was written. */
export interface TimedMessage {
  id: string;
  /** ISO 8601. */
  at: string;
}

/**
 * The messages a day marker stands before, by id, with the moment it names: the first message
 * of the conversation, and after it the first message of each later calendar day. A message
 * whose day lies before a day already marked, as an earlier message out of order does, opens
 * no day of its own.
 */
export function dayOpeningMessages(
  messages: readonly TimedMessage[],
  timeZone?: string
): Map<string, string> {
  const openings = new Map<string, string>();
  let markedDay = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const moment = new Date(message.at);
    if (Number.isNaN(moment.getTime())) {
      continue;
    }
    const day = calendarDay(moment, timeZone);
    if (day > markedDay) {
      openings.set(message.id, message.at);
      markedDay = day;
    }
  }
  return openings;
}

/**
 * What a day marker says: "Today 10:47 AM", "Yesterday 4:12 PM", the weekday within the last
 * week, and the full date beyond it, each with the time of day.
 */
export function dayMarkerLabel(input: {
  at: string;
  now: Date;
  locale: LocaleCode;
  t: TranslationContextValue["t"];
  timeZone?: string;
}): string {
  const { at, now, locale, t, timeZone } = input;
  const daysAgo = calendarDay(now, timeZone) - calendarDay(new Date(at), timeZone);
  const time = formatTimeOfDay(at, locale, timeZone);
  if (daysAgo === 0) {
    return t("dayMarkerToday", { time });
  }
  if (daysAgo === 1) {
    return t("dayMarkerYesterday", { time });
  }
  if (daysAgo > 1 && daysAgo < 7) {
    return t("dayMarkerWeekday", { weekday: formatWeekday(at, locale, timeZone), time });
  }
  return formatMoment(at, locale, timeZone);
}
