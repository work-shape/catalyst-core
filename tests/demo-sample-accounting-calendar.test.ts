import { describe, expect, it } from "vitest";
import { required } from "./support/assertions";
import {
  cents,
  chartOf,
  clientsOf,
  everyPosting,
  INDUSTRIES,
  PUBLIC_HOLIDAYS,
  sample,
  weekdayOf,
  type Posting
} from "./support/sample-accounting";

// On which days the accounting sample books: nothing on a public holiday, a restaurant's till
// every day it is open and most at the weekend, and the cash to the bank on a banking day.

const SUNDAY = 0;
const SATURDAY = 6;
/** A month of each year of the sample that holds public holidays. */
const HOLIDAY_MONTHS = ["2024-05", "2025-04", "2025-12", "2026-01", "2026-05"];
const YEAR_2026 = sample.months.filter((month) => month.startsWith("2026"));

const isTillReport = ({ posting_description }: Posting) =>
  posting_description.startsWith("Tageseinnahmen");

function datesOf(month: string): string[] {
  const [year, monthOfYear] = month.split("-").map(Number);
  const days = new Date(Date.UTC(required(year), required(monthOfYear), 0)).getUTCDate();
  return Array.from({ length: days }, (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`);
}

/** The bookings of a client's till in a month, by the till report they belong to. */
function tillReports(clientId: number, month: string): Posting[][] {
  const reports = new Map<string, Posting[]>();
  for (const row of everyPosting(clientId, month).filter(isTillReport)) {
    reports.set(row.document_field_1, [...(reports.get(row.document_field_1) ?? []), row]);
  }
  // A planted duplicate repeats one line of a report word for word.
  return [...reports.values()].map((lines) =>
    lines.filter((line, index) => JSON.stringify(line) !== JSON.stringify(lines[index - 1]))
  );
}

describe("demo sample accounting calendar", () => {
  it("books nothing on a nationwide public holiday but the takings of a restaurant's till", () => {
    expect(PUBLIC_HOLIDAYS).toHaveLength(27);
    let bookings = 0;
    let tillReportsOnHolidays = 0;
    for (const industry of INDUSTRIES) {
      for (const clientId of clientsOf(industry, 3)) {
        for (const month of HOLIDAY_MONTHS) {
          for (const row of everyPosting(clientId, month)) {
            bookings += 1;
            if (!PUBLIC_HOLIDAYS.includes(row.date)) continue;
            expect(isTillReport(row), `${industry} ${clientId} ${row.date}`).toBe(true);
            expect(industry).toBe("restaurant");
            tillReportsOnHolidays += 1;
          }
        }
      }
    }
    expect(bookings).toBeGreaterThan(10_000);
    expect(tillReportsOnHolidays).toBeGreaterThan(0);
  });

  it("books a restaurant's till report in two bookings, food at 7 % and drinks at 19 %", () => {
    const restaurants = clientsOf("restaurant", 6, 4_000);
    expect(restaurants).toHaveLength(6);
    for (const clientId of restaurants) {
      const chart = chartOf(clientId);
      for (const [month, foodShare] of [
        // Food eaten in the restaurant is taxed at 7 % from 2026. Before that only food
        // taken away was, the smaller part of a day's takings.
        ["2026-09", { least: 0.5, most: 0.8 }],
        ["2025-09", { least: 0.08, most: 0.35 }]
      ] as const) {
        const reports = tillReports(clientId, month);
        expect(reports.length).toBeGreaterThan(0);
        for (const lines of reports) {
          const [first] = lines;
          const where = `${clientId} ${required(first).document_field_1}`;
          expect(lines.map(({ tax_rate }) => tax_rate).sort(), where).toEqual([19, 7]);
          for (const line of lines) {
            expect(line).toMatchObject({
              date: required(first).date,
              posting_description: required(first).posting_description,
              document_link: required(first).document_link,
              debit_credit_indicator: "H"
            });
            expect(required(chart.get(line.account_number)).account_class).toBe("revenue");
            expect(required(chart.get(line.contra_account_number)).label).toBe("Kasse");
          }
          const net = lines.reduce((sum, line) => sum + line.net_amount, 0);
          const food = required(lines.find(({ tax_rate }) => tax_rate === 7)).net_amount;
          expect(food / net, where).toBeGreaterThan(foodShare.least);
          expect(food / net, where).toBeLessThan(foodShare.most);
        }
        // A till reports once a day.
        const tillDays = reports.map(
          (lines) => `${required(lines[0]).date} ${required(lines[0]).posting_description}`
        );
        expect(new Set(tillDays).size).toBe(tillDays.length);
      }
    }
  });

  it("gives a restaurant its best days at the weekend and a shop none on a Sunday", () => {
    for (const clientId of clientsOf("restaurant", 12, 4_000)) {
      for (const month of ["2026-08", "2026-09"]) {
        // What an average Saturday, Sunday and working day take, over the days of the month.
        const taken = new Map<string, number>();
        for (const row of everyPosting(clientId, month).filter(isTillReport)) {
          taken.set(row.date, (taken.get(row.date) ?? 0) + cents(row.net_amount));
        }
        const average = (test: (weekday: number) => boolean) => {
          const dates = datesOf(month).filter((date) => test(weekdayOf(date)));
          return dates.reduce((sum, date) => sum + (taken.get(date) ?? 0), 0) / dates.length;
        };
        const weekend =
          average((weekday) => weekday === SATURDAY) + average((weekday) => weekday === SUNDAY);
        const workingDay = average((weekday) => weekday !== SATURDAY && weekday !== SUNDAY);
        expect(weekend, `${clientId} ${month}`).toBeGreaterThan(2 * workingDay);
      }
    }
    for (const clientId of clientsOf("retail", 6, 4_000)) {
      const dates = everyPosting(clientId, "2026-09")
        .filter(isTillReport)
        .map(({ date }) => date);
      expect(dates.some((date) => weekdayOf(date) === SATURDAY)).toBe(true);
      expect(dates.some((date) => weekdayOf(date) === SUNDAY)).toBe(false);
    }
  });

  it("brings the till's cash to the bank on banking days, in amounts and at intervals that vary", () => {
    const [clientId] = clientsOf("restaurant", 100).filter(
      (id) => sample.postingCount(id, "2026-09") >= 150
    );
    const deposits = YEAR_2026.flatMap((month) =>
      everyPosting(required(clientId), month).filter(
        ({ posting_description }, index, rows) =>
          posting_description.startsWith("Bareinzahlung") &&
          posting_description !== rows[index - 1]?.posting_description
      )
    );
    expect(deposits.length).toBeGreaterThan(30);
    for (const { date, amount } of deposits) {
      expect([SATURDAY, SUNDAY]).not.toContain(weekdayOf(date));
      expect(PUBLIC_HOLIDAYS).not.toContain(date);
      // Notes, so whole fifties.
      expect(cents(amount) % 5_000).toBe(0);
    }
    const amounts = new Map<number, number>();
    for (const { amount } of deposits) amounts.set(amount, (amounts.get(amount) ?? 0) + 1);
    expect(amounts.size).toBeGreaterThan(15);
    expect(Math.max(...amounts.values())).toBeLessThan(deposits.length / 5);
    const gaps = deposits
      .slice(1)
      .map(({ date }, index) => Date.parse(date) - Date.parse(required(deposits[index]).date));
    expect(new Set(gaps).size).toBeGreaterThan(2);
  });
});
