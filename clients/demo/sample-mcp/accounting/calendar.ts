import { pick } from "../random.js";

// The months the accounting sample serves, and the days of a month its bookings fall on. The
// range starts with a fixed month and ends with the month the sample is given, never with the
// clock, so a month gives the same bookings whenever it is asked for.

export const FIRST_MONTH = "2024-01";

const FIRST_YEAR = Number(FIRST_MONTH.slice(0, 4));
export const MONTHS_PER_YEAR = 12;
const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;

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

/**
 * The months from the first one to `lastMonth` as a request names them (`YYYY-MM`), oldest
 * first. The index of a month in the list is the one `monthAt` counts by.
 */
export function monthsUntil(lastMonth: string): string[] {
  const named = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(lastMonth);
  const count =
    named === null
      ? 0
      : (Number(named[1]) - FIRST_YEAR) * MONTHS_PER_YEAR +
        Number(named[2]) -
        Number(FIRST_MONTH.slice(5)) +
        1;
  if (count < 1) throw new Error(`lastMonth must be a month from ${FIRST_MONTH} on as YYYY-MM.`);
  return Array.from({ length: count }, (_, index) => {
    const { year, month } = monthAt(index);
    return `${year}-${twoDigits(month)}`;
  });
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
 * How a week runs for one kind of booking: what each day does of the usual day's business,
 * Monday first, and what a public holiday does. A day that does nothing has no such booking.
 */
export interface Week {
  days: readonly number[];
  holiday: number;
}

/** The week of a ledger: few bookings are dated on a weekend and none on a public holiday. */
export const OFFICE_WEEK: Week = { days: [1, 1, 1, 1, 1, 0.25, 0.1], holiday: 0 };
/** The week of a bank's counter. Monday also takes what the weekend brought. */
export const BANK_WEEK: Week = { days: [1.5, 1, 1, 1, 1, 0, 0], holiday: 0 };

/** Easter Sunday of a year as a UTC time, by the Gregorian computus of Meeus, Jones and Butcher. */
function easterSunday(year: number): number {
  const century = Math.floor(year / 100);
  const yearOfCentury = year % 100;
  const moon = year % 19;
  const moonCorrection = Math.floor((century - Math.floor((century + 8) / 25) + 1) / 3);
  const epact = (19 * moon + century - Math.floor(century / 4) - moonCorrection + 15) % 30;
  const weekday =
    (32 + 2 * (century % 4) + 2 * Math.floor(yearOfCentury / 4) - epact - (yearOfCentury % 4)) %
    DAYS_PER_WEEK;
  const late = Math.floor((moon + 11 * epact + 22 * weekday) / 451);
  // A day of March above 31 is a day of April.
  return Date.UTC(year, 2, epact + weekday - 7 * late + 22);
}

/**
 * The public holidays all of Germany keeps, as `YYYY-MM-DD`: New Year, Good Friday, Easter
 * Monday, 1 May, Ascension Day, Whit Monday, 3 October and the two days of Christmas. A
 * holiday of single states only, such as Corpus Christi, is a working day here.
 */
function publicHolidays(year: number): string[] {
  const easter = easterSunday(year);
  return [
    ...["01-01", "05-01", "10-03", "12-25", "12-26"].map((day) => `${year}-${day}`),
    ...[-2, 1, 39, 50].map((days) => new Date(easter + days * DAY_MS).toISOString().slice(0, 10))
  ];
}

/** What each day of the month does of the usual day's business in such a week, the first day first. */
export function dayWeights(month: SampleMonth, week: Week): number[] {
  const holidays = publicHolidays(month.year);
  const firstWeekday = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
  return Array.from({ length: month.days }, (_, day) =>
    holidays.includes(isoDate(month, day))
      ? week.holiday
      : // `getUTCDay` counts from Sunday, a week here from Monday.
        pick(week.days, firstWeekday + DAYS_PER_WEEK - 1 + day)
  );
}

/**
 * The day (from 0) a point of the month from 0 to 1 falls on, when each day takes room by its
 * weight. A day without weight takes no point, and the day never falls as the point rises.
 */
export function dayAt(weights: readonly number[]): (point: number) => number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) throw new Error("No day of the month has such a booking.");
  let end = 0;
  const ends = weights.map((weight) => (end += weight / total));
  // Rounding may leave the last end a hair under 1.
  const last = ends.indexOf(end);
  return (point) => {
    const day = ends.findIndex((dayEnd) => point < dayEnd);
    return day === -1 ? last : day;
  };
}

/**
 * The `count` days nearest to the month that lie before it (`side` -1) or after it (1) and
 * are no public holiday, the nearest first, each as its distance from the month's first day.
 */
export function daysOutside(month: SampleMonth, side: -1 | 1, count: number): number[] {
  const days: number[] = [];
  for (let step = 1; days.length < count; step += 1) {
    const day = side === 1 ? month.days - 1 + step : -step;
    const date = isoDate(month, day);
    if (!publicHolidays(Number(date.slice(0, 4))).includes(date)) days.push(day);
  }
  return days;
}
