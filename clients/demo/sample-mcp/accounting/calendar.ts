// The months the accounting sample serves. The range is fixed, so a month gives the same
// bookings forever, whenever it is asked for.

export const FIRST_MONTH = "2024-01";
export const LAST_MONTH = "2026-12";

const FIRST_YEAR = Number(FIRST_MONTH.slice(0, 4));
export const MONTHS_PER_YEAR = 12;
const MONTH_COUNT =
  (Number(LAST_MONTH.slice(0, 4)) - FIRST_YEAR) * MONTHS_PER_YEAR +
  Number(LAST_MONTH.slice(5)) -
  Number(FIRST_MONTH.slice(5)) +
  1;
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

export function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The month `index` months after the first one of the range. A month before the range has a
 * negative index: the clients kept books before the sample starts, and a payment of the first
 * month settles an invoice of the month before it.
 */
export function monthAt(index: number): SampleMonth {
  const monthsOfEra = Number(FIRST_MONTH.slice(5)) - 1 + index;
  const year = FIRST_YEAR + Math.floor(monthsOfEra / MONTHS_PER_YEAR);
  const month = monthsOfEra - (year - FIRST_YEAR) * MONTHS_PER_YEAR + 1;
  return { index, year, month, days: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

/** The months of the range as a request names them (`YYYY-MM`), oldest first. */
export const SAMPLE_MONTHS: readonly string[] = Array.from({ length: MONTH_COUNT }, (_, index) => {
  const { year, month } = monthAt(index);
  return `${year}-${twoDigits(month)}`;
});

/** The month of the range that `text` names as `YYYY-MM`, or `undefined` outside it. */
export function sampleMonth(text: string): SampleMonth | undefined {
  const index = SAMPLE_MONTHS.indexOf(text);
  return index === -1 ? undefined : monthAt(index);
}

/** A month as a booking text names it: `MM/YYYY`. */
export function periodLabel({ year, month }: SampleMonth): string {
  return `${twoDigits(month)}/${year}`;
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
