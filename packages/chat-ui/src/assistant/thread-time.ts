import type { LocaleCode, Message } from "@vivd-catalyst/api-client";
import { formatMoment, formatTimeOfDay, formatWeekday } from "../control-plane/locale-format";
import type { TranslationContextValue } from "../i18n";

export function formatElapsedSeconds(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return minutes > 0 ? `${minutes}m ${wholeSeconds % 60}s` : `${wholeSeconds}s`;
}

export function formatWorkHistoryLabel(label: string, durationMs?: number): string {
  return durationMs === undefined ? label : `${label} · ${formatElapsedSeconds(durationMs / 1000)}`;
}

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

/**
 * When each message of the thread was written, by the id the thread shows it under: the stored
 * messages by their own id, and the answer of the conversation's latest run, which the thread
 * shows under the run's id while it streams and once it has stopped or failed, by the run's start.
 */
export function transcriptMessageTimes(
  messages: ReadonlyArray<Pick<Message, "id" | "createdAt">>,
  activeRun?: { run: { id: string; startedAt: string } }
): Record<string, string> {
  const times: Record<string, string> = {};
  for (const message of messages) {
    times[message.id] = message.createdAt;
  }
  if (activeRun) {
    times[activeRun.run.id] ??= activeRun.run.startedAt;
  }
  return times;
}

/** What the thread shows when its message times are read. */
export interface ThreadTimesInput {
  /** The ids of the thread's messages, in order. */
  ids: readonly string[];
  /** When each stored message was written, by id. */
  stored: Readonly<Record<string, string>>;
  /** A message is being sent, or an answer streams in. */
  busy: boolean;
  now: Date;
}

/**
 * Reads the moment of each message of a thread, for its day markers. A stored message has its
 * own. A message after the last stored one, while the thread is busy, is the one being sent or
 * answered: it is written now, and keeps that moment until the server's arrives, however often
 * the thread is read again. Any other message without a moment takes its neighbour's, the one
 * before it, or else the one after it; it is never taken for new.
 */
export function createThreadTimes(): (input: ThreadTimesInput) => TimedMessage[] {
  const unsaved = new Map<string, string>();
  return ({ ids, stored, busy, now }) => {
    for (const id of [...unsaved.keys()]) {
      if (!ids.includes(id) || stored[id] !== undefined) {
        unsaved.delete(id);
      }
    }
    let lastStored = -1;
    ids.forEach((id, index) => {
      if (stored[id] !== undefined) {
        lastStored = index;
      }
    });
    const own = ids.map((id, index): string | undefined => {
      const at = stored[id] ?? unsaved.get(id);
      if (at !== undefined || !busy || index <= lastStored) {
        return at;
      }
      const written = now.toISOString();
      unsaved.set(id, written);
      return written;
    });
    const timed: TimedMessage[] = [];
    let previous: string | undefined;
    ids.forEach((id, index) => {
      const at = own[index] ?? previous ?? own.slice(index + 1).find((next) => next !== undefined);
      if (at !== undefined) {
        timed.push({ id, at });
        previous = at;
      }
    });
    return timed;
  };
}

/** How long from `now` until the reader's next midnight, when "today" becomes "yesterday". */
export function msUntilNextMidnight(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return midnight.getTime() - now.getTime();
}
