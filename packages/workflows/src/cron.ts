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
/** A year of hours and more: a due time further away than that is none. */
const MAX_LOOKS = 20_000;

/** What a moment reads on the clock and the calendar of a time zone. */
function clockOf(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short"
  });
  return (time: number) => {
    const read: Record<string, string> = {};
    for (const part of format.formatToParts(time)) read[part.type] = part.value;
    return {
      month: Number(read.month),
      day: Number(read.day),
      hour: Number(read.hour),
      minute: Number(read.minute),
      weekday: WEEKDAYS.indexOf(read.weekday ?? "")
    };
  };
}

type Clock = ReturnType<ReturnType<typeof clockOf>>;

function dueOnDay(cron: CronExpression, clock: Clock): boolean {
  if (!cron.months.has(clock.month)) return false;
  const byDate = cron.daysOfMonth.has(clock.day);
  const byWeekday = cron.daysOfWeek.has(clock.weekday);
  if (cron.anyDayOfMonth) return byWeekday;
  if (cron.anyDayOfWeek) return byDate;
  return byDate || byWeekday;
}

/**
 * The nearest minute that is due, looking forward or back from `start`, which is itself
 * looked at. It walks hour by hour over what is not due and minute by minute inside an hour
 * that is, on the clock of the time zone, so a day that is longer or shorter than 24 hours is
 * read as it was.
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
    const clock = read(time);
    if (!dueOnDay(cron, clock) || !cron.hours.has(clock.hour)) {
      // To the first minute of the next hour, or the last one of the hour before.
      time += direction === 1 ? (60 - clock.minute) * MINUTE_MS : -(clock.minute + 1) * MINUTE_MS;
    } else if (!cron.minutes.has(clock.minute)) {
      time += direction * MINUTE_MS;
    } else {
      return time;
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
