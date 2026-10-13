// The cron expressions of a `schedule` trigger: five fields, minute, hour, day of month,
// month and day of week, read in one time zone. A field is `*`, a number, a range `a-b`, a
// step `*/n` or `a-b/n`, or a list of those. Names of months and days are not read.

/** A cron expression as the minutes, hours, days and months it is due in. */
export interface CronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday. */
  daysOfWeek: ReadonlySet<number>;
  /** Whether the field names days at all: with both given, a day that fits either is due. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

function fieldOf(text: string, low: number, high: number): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/u.exec(part);
    if (!match) return undefined;
    const [, all, first, last, every] = match;
    const from = all !== undefined ? low : Number(first);
    const to =
      all !== undefined
        ? high
        : last !== undefined
          ? Number(last)
          : every !== undefined
            ? high
            : from;
    const step = every === undefined ? 1 : Number(every);
    if (from < low || to > high || from > to || step < 1) return undefined;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Reads a cron expression, or answers nothing where it is none. */
export function parseCron(text: string): CronExpression | undefined {
  const fields = text.trim().split(/\s+/u);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (fields.length !== 5 || !minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return undefined;
  }
  const minutes = fieldOf(minute, 0, 59);
  const hours = fieldOf(hour, 0, 23);
  const daysOfMonth = fieldOf(dayOfMonth, 1, 31);
  const months = fieldOf(month, 1, 12);
  // 7 is Sunday as 0 is.
  const days = fieldOf(dayOfWeek, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !days) return undefined;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...days].map((day) => day % 7)),
    anyDayOfMonth: dayOfMonth === "*",
    anyDayOfWeek: dayOfWeek === "*"
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MINUTE_MS = 60_000;
/** Two looks an hour for more than a year: a due time further away than that is none. */
const MAX_LOOKS = 40_000;

/** Whether a name is a time zone this process can read a clock in: an IANA name, or UTC. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** What a moment reads on the clock and the calendar of a time zone. */
function clockOf(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short"
  });
  return (time: number) => {
    const read: Record<string, string> = {};
    for (const part of format.formatToParts(time)) read[part.type] = part.value;
    return clockAt(
      Number(read.year),
      Number(read.month),
      Number(read.day),
      Number(read.hour),
      Number(read.minute),
      WEEKDAYS.indexOf(read.weekday ?? "")
    );
  };
}

/** One reading of a clock, with `wall`: the reading as a count of milliseconds. */
function clockAt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  weekday: number
) {
  return { month, day, hour, minute, weekday, wall: Date.UTC(year, month - 1, day, hour, minute) };
}

type Clock = ReturnType<typeof clockAt>;

function dueOnDay(cron: CronExpression, clock: Clock): boolean {
  if (!cron.months.has(clock.month)) return false;
  const byDate = cron.daysOfMonth.has(clock.day);
  const byWeekday = cron.daysOfWeek.has(clock.weekday);
  if (cron.anyDayOfMonth) return byWeekday;
  if (cron.anyDayOfWeek) return byDate;
  return byDate || byWeekday;
}

const dueOnClock = (cron: CronExpression, clock: Clock): boolean =>
  dueOnDay(cron, clock) && cron.hours.has(clock.hour) && cron.minutes.has(clock.minute);

/**
 * Whether a minute is due. On the two days a year the clock of a time zone is changed, a
 * reading is skipped or shown twice, and a schedule still runs once for it:
 *
 * A reading that is shown twice, when the clock is set back, is due the first time alone.
 * A reading that is skipped, when the clock is set forward, is due at the first minute after
 * the gap: that minute is due once for whatever the gap held.
 */
function isDue(cron: CronExpression, read: (time: number) => Clock, time: number): boolean {
  const clock = read(time);
  if (dueOnClock(cron, clock)) {
    // The same reading an hour or half an hour earlier: the clock was set back in between.
    return ![30, 60].some((minutes) => read(time - minutes * MINUTE_MS).wall === clock.wall);
  }
  const before = read(time - MINUTE_MS);
  // The minute before reads more than a minute earlier: the readings between were skipped.
  for (let wall = before.wall + MINUTE_MS; wall < clock.wall; wall += MINUTE_MS) {
    const skipped = new Date(wall);
    const reading = clockAt(
      skipped.getUTCFullYear(),
      skipped.getUTCMonth() + 1,
      skipped.getUTCDate(),
      skipped.getUTCHours(),
      skipped.getUTCMinutes(),
      skipped.getUTCDay()
    );
    if (dueOnClock(cron, reading)) return true;
  }
  return false;
}

/**
 * The nearest minute that is due, looking forward or back from `start`, which is itself
 * looked at. It walks hour by hour over what is not due and minute by minute inside an hour
 * that is, on the clock of the time zone, so a day that is longer or shorter than 24 hours is
 * read as it was. The first minute of every hour is looked at on the way, because that is
 * where a clock that was set forward goes on.
 */
function look(
  cron: CronExpression,
  start: number,
  direction: 1 | -1,
  timeZone: string
): number | undefined {
  const read = clockOf(timeZone);
  let time = Math.floor(start / MINUTE_MS) * MINUTE_MS;
  if (direction === 1 && time < start) time += MINUTE_MS;
  for (let looks = 0; looks < MAX_LOOKS; looks += 1) {
    if (isDue(cron, read, time)) return time;
    const clock = read(time);
    if (dueOnDay(cron, clock) && cron.hours.has(clock.hour)) {
      time += direction * MINUTE_MS;
    } else if (direction === 1) {
      // To the first minute of the next hour.
      time += (60 - clock.minute) * MINUTE_MS;
    } else {
      // To the first minute of this hour, and from there to the last one of the hour before.
      time -= Math.max(clock.minute, 1) * MINUTE_MS;
    }
  }
  return undefined;
}

/** The first due time after a moment, of any of the expressions. */
export function nextDueAfter(
  crons: readonly CronExpression[],
  after: Date,
  timeZone: string
): Date | undefined {
  const times = crons.flatMap((cron) => {
    const time = look(cron, after.getTime() + 1, 1, timeZone);
    return time === undefined ? [] : [time];
  });
  return times.length === 0 ? undefined : new Date(Math.min(...times));
}

/** The latest due time from `from` to `to`, both included, of any of the expressions. */
export function lastDueWithin(
  crons: readonly CronExpression[],
  from: Date,
  to: Date,
  timeZone: string
): Date | undefined {
  const times = crons.flatMap((cron) => {
    const time = look(cron, to.getTime(), -1, timeZone);
    return time === undefined || time < from.getTime() ? [] : [time];
  });
  return times.length === 0 ? undefined : new Date(Math.max(...times));
}
