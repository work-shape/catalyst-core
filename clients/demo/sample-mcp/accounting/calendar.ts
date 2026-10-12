// The months the accounting sample serves. The range is fixed, so a month gives the same
// bookings forever, whenever it is asked for.

export const FIRST_MONTH = "2024-01";
export const LAST_MONTH = "2026-12";

const FIRST_YEAR = Number(FIRST_MONTH.slice(0, 4));
const MONTHS_PER_YEAR = 12;
const DAY_MS = 86_400_000;
// A ledger has few bookings dated on a weekend.
const SATURDAY_WEIGHT = 0.25;
const SUNDAY_WEIGHT = 0.1;

export interface SampleMonth {
  /** Counted from the first month of the range. */
  index: number;
  year: number;
  /** 1 to 12. */
  month: number;
  days: number;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** The month of the range that `text` names as `YYYY-MM`, or `undefined` outside it. */
export function sampleMonth(text: string): SampleMonth | undefined {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(text) || text < FIRST_MONTH || text > LAST_MONTH) {
    return undefined;
  }
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5));
  return {
    index: (year - FIRST_YEAR) * MONTHS_PER_YEAR + month - 1,
    year,
    month,
    days: new Date(Date.UTC(year, month, 0)).getUTCDate()
  };
}

/** The date `offsetDays` after the first day of the month (before it when negative), as `YYYY-MM-DD`. */
export function isoDate({ year, month }: SampleMonth, offsetDays: number): string {
  return new Date(Date.UTC(year, month - 1, 1) + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** A date as DATEV writes it into a number: `YYYYMMDD`. */
export function compactDate(year: number, month: number, day: number): string {
  return `${year}${twoDigits(month)}${twoDigits(day)}`;
}

/**
 * Where each day of the month ends on a line from 0 to 1 that gives a working day more room
 * than a weekend day. A booking's place in the month, on the same line, names its day.
 */
export function dayEnds(month: SampleMonth): number[] {
  const firstWeekday = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
  const weights = Array.from({ length: month.days }, (_, day) => {
    const weekday = (firstWeekday + day) % 7;
    return weekday === 6 ? SATURDAY_WEIGHT : weekday === 0 ? SUNDAY_WEIGHT : 1;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let end = 0;
  return weights.map((weight) => (end += weight / total));
}
