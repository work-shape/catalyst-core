import { pick } from "../random.js";
import { vatRate } from "./accounts.js";
import type { Activity, Booking } from "./booking.js";
import { TILL_BOOKINGS_PER_DEPOSIT } from "./business.js";
import { BANK_WEEK, dayAt, dayWeights, type Week } from "./calendar.js";
import { yearlyDocument, type Issued } from "./documents.js";
import {
  ACTIVITY,
  AMOUNT,
  drawsOf,
  evenDraw,
  issuedBefore,
  linkOf,
  plain,
  spreadAround,
  type Frame,
  type PlantedPoints
} from "./frame.js";

// The tills of a client and the cash they take. A till reports once a day it is open (the
// Z-Bon), and the report is booked in one booking for each tax rate, all with the report's
// number. The days follow the week of the industry: a restaurant is open every day and takes
// most at the weekend, a shop is closed on Sundays. The cash goes to the bank on a banking day.

/** How many times its smallest amount the largest is: of a till's day, and of a deposit. */
const TAKINGS_SPREAD = 1.6;
const DEPOSIT_SPREAD = 3;
/** How far a tax rate's share of one report lies from its usual share at most, as a part of it. */
const SHARE_VARIATION = 0.2;
const DEPOSIT_UNIT_EUROS = 50;

/**
 * Where the month's till reports stand. Every open day has as many reports as the client has
 * tills, and what is left over goes to the best days first: a second till on Saturdays, or,
 * for a client with fewer reports than open days, a till that is open on its best days only.
 * A report's `level` is what its day takes of the usual day's takings.
 */
function reportDays({ client, period, issued }: Frame, week: Week) {
  const reports = issued.tillReports;
  const weights = dayWeights(period, week);
  const open = weights.flatMap((weight, day) => (weight > 0 ? [day] : []));
  const onEveryDay = Math.floor(reports / open.length);
  // Among days alike the earlier one comes first, as the sort keeps their order.
  const best = new Set(
    [...open]
      .sort((left, right) => pick(weights, right) - pick(weights, left))
      .slice(0, reports - onEveryDay * open.length)
  );
  let end = 0;
  /** By day: the reports up to the end of that day. */
  const ends = weights.map(
    (weight, day) => (end += weight > 0 ? onEveryDay + (best.has(day) ? 1 : 0) : 0)
  );
  const before = (day: number) => (day === 0 ? 0 : pick(ends, day - 1));
  const usualWeight =
    weights.reduce((sum, weight, day) => sum + weight * (pick(ends, day) - before(day)), 0) /
    reports;
  return (report: number) => {
    const day = ends.findIndex((dayEnd) => report < dayEnd);
    if (day === -1) {
      throw new Error(`Client ${client.row.client_id} has no till report ${report} in the month.`);
    }
    return { day, till: report - before(day), level: pick(weights, day) / usualWeight };
  };
}

/** The bookings of the client's tills in the frame's month: the reports, then the deposits. None for a client without a till. */
export function tillActivities(
  frame: Frame,
  plantedIn: (monthIndex: number) => PlantedPoints
): Activity[] {
  const { client, ledger, period, issued } = frame;
  const { till } = client.business.profile;
  if (till === null) return [];
  const { euros } = till;
  const lines = till.lines(period.year);
  const reportAt = reportDays(frame, till.week);
  const reportsBefore = issuedBefore(frame, plantedIn, (month) => month.issued.tillReports);
  const depositsOf = (month: Frame) =>
    Math.floor(month.issued.tillBookings / TILL_BOOKINGS_PER_DEPOSIT);
  const depositsBefore = issuedBefore(frame, plantedIn, depositsOf);
  const deposits = depositsOf(frame);
  const bankDay = dayAt(dayWeights(period, BANK_WEEK));

  /** One tax rate of one till's report of a day. */
  function reportLine(rank: number): Booking {
    const report = Math.floor(rank / lines.length);
    const { till: number, level } = reportAt(report);
    const random = drawsOf(frame, ACTIVITY.tillReports, report);
    // Each rate takes its usual share of the day, a little more on one day and less on another.
    const shares = lines.map(({ share }) => share * (1 + SHARE_VARIATION * (2 * random() - 1)));
    const netEuros =
      euros *
      lines.length *
      frame.level *
      level *
      spreadAround(
        evenDraw(frame, ACTIVITY.tillReports, AMOUNT, report, issued.tillReports, random),
        TAKINGS_SPREAD
      );
    const line = pick(lines, rank);
    const account = ledger[line.account];
    const share = pick(shares, rank) / shares.reduce((sum, other) => sum + other, 0);
    return {
      ...plain,
      account,
      contra: ledger.cash,
      side: "H",
      vatKey: line.vatKey,
      cents: Math.max(
        1,
        Math.round(netEuros * share * (100 + vatRate(account.automatic_vat_key ?? line.vatKey)))
      ),
      text: `Tageseinnahmen Kasse ${number + 1}`,
      document: yearlyDocument("Z", period, reportsBefore.thisYear + report),
      documentLink: linkOf(frame, ACTIVITY.tillReports, report)
    };
  }

  /** The draws of a deposit: for its day, and the ones its amount is made of. */
  function depositDraws(rank: number) {
    const random = drawsOf(frame, ACTIVITY.deposits, rank);
    return { when: random(), random };
  }

  /** The till's cash brought to the bank, in notes and with the number of the deposit slip. */
  function deposit(before: Issued, rank: number): Booking {
    const usualEuros = euros * TILL_BOOKINGS_PER_DEPOSIT * frame.level;
    const draw = evenDraw(
      frame,
      ACTIVITY.deposits,
      AMOUNT,
      rank,
      deposits,
      depositDraws(rank).random
    );
    const units = Math.round(
      (usualEuros * spreadAround(draw, DEPOSIT_SPREAD)) / DEPOSIT_UNIT_EUROS
    );
    const document = yearlyDocument("EZ", period, before.thisYear + rank);
    return {
      ...plain,
      account: ledger.bank,
      contra: ledger.cash,
      side: "S",
      vatKey: 0,
      cents: Math.max(1, units) * DEPOSIT_UNIT_EUROS * 100,
      text: `Bareinzahlung ${document}`,
      document
    };
  }

  return [
    {
      count: issued.tillBookings,
      day: (rank) => reportAt(Math.floor(rank / lines.length)).day,
      booking: reportLine
    },
    {
      count: deposits,
      // Whenever the cash is worth the way: one deposit in each stretch of the month, on any
      // day of it.
      day: (rank) => bankDay((rank + depositDraws(rank).when) / deposits),
      booking: (rank) => deposit(depositsBefore, rank)
    }
  ];
}
