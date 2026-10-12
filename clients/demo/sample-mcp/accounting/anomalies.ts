import { mixedSeed, pick, seededGenerator, shuffled } from "../random.js";
import { LEDGERS } from "./accounts.js";
import type { ExtraBookings } from "./activities.js";
import type { Booking } from "./booking.js";
import {
  dayAt,
  daysOutside,
  dayWeights,
  monthAt,
  MONTHS_PER_YEAR,
  OFFICE_WEEK,
  type SampleMonth
} from "./calendar.js";
import { postingCount, STREAM, type SampleClient } from "./clients.js";
import { formerSupplierOf } from "./counterparties.js";
import type { PlantedPoints, Random } from "./frame.js";
import { ACCOUNTING_RULES, type AccountingRuleId } from "./rules.js";
import type { Schedule } from "./schedule.js";

// The planted bookings of a month: how many break each rule, where they stand, and what each
// says. A planted booking is added to the client's business and replaces none of it, so the
// clean bookings around it still add up. It is an ordinary booking of the client with one
// thing wrong: the text and the pair of accounts of each are those of clean bookings, and
// only the rule it breaks tells it apart.
//
// No planted booking is like another booking of the month, clean or planted, so none is a
// duplicate by accident:
//
// - A purchase and a sales invoice carry a document number of their own, the one their
//   supplier or the client gives at the point of the month they are dated at (documents.ts).
// - A booking without a document number has an amount that no other one of the month has.
// - A duplicate copies the clean booking before it, and no clean booking is copied twice.

/** A month with fewer bookings than this plants at most one booking per rule, and seldom. */
const SMALL_MONTH = 300;
/** The chance that a month holds bookings that break a given rule: in a small month, and in any other. */
const RULE_PRESENCE = { small: 0.25, other: 0.6 } as const;
/** A month that is not small plants up to two bookings per rule, and one more for each so many bookings. */
const POSTINGS_PER_FURTHER_FINDING = 2_500;
/** How many days before or after the month a planted date may lie. */
const OUTSIDE_DAYS = 5;

type Findings = Record<AccountingRuleId, number>;

function drawn<T>(items: readonly T[], random: Random): T {
  return pick(items, Math.floor(random() * items.length));
}

/** How many bookings of the client's month break each rule. It reads no booking. */
export function expectedFindings(seed: number, client: SampleClient, monthIndex: number): Findings {
  const count = postingCount(seed, client, monthIndex);
  const random = seededGenerator(
    mixedSeed(seed, STREAM.findings, client.row.client_id, monthIndex)
  );
  const findingCount = () => {
    const present = random();
    const further = random();
    if (count < SMALL_MONTH) return present < RULE_PRESENCE.small ? 1 : 0;
    return present < RULE_PRESENCE.other
      ? 1 + Math.floor(further * (2 + count / POSTINGS_PER_FURTHER_FINDING))
      : 0;
  };
  return {
    "duplicate-posting": findingCount(),
    "vat-key-account-mismatch": findingCount(),
    "blocked-account": findingCount(),
    "round-amount-no-document": findingCount(),
    "date-outside-month": findingCount(),
    "expense-in-credit": findingCount(),
    // The rule needs another booking of the month with a cost centre to compare with.
    "missing-cost-centre": client.costCentres.length > 0 ? findingCount() : 0
  };
}

/** The rules in the order their bookings are planted. A booking's place in that order is its `ordinal`. */
const PLANTING_ORDER: readonly AccountingRuleId[] = [
  "date-outside-month",
  "duplicate-posting",
  "vat-key-account-mismatch",
  "blocked-account",
  "round-amount-no-document",
  "expense-in-credit",
  "missing-cost-centre"
];

/** A planted booking: the rule it breaks and its numbers among the month's planted bookings. */
interface Planted {
  rule: AccountingRuleId;
  ordinal: number;
  /** Its number among the `of` bookings of the month that break the same rule. */
  index: number;
  of: number;
  /**
   * The point of the month, from 0 to 1, at which it is dated and its document is numbered.
   * One dated before the month has 0 and one dated after it 1. A duplicate stands with the
   * booking it copies, whatever its point.
   */
  point: number;
}

/**
 * Of the bookings of a month that break the rule of the VAT keys, the first is a purchase,
 * the second a sales invoice, and so on in turn.
 */
function isSalesInvoice({ rule, index }: Planted): boolean {
  return rule === "vat-key-account-mismatch" && index % 2 === 1;
}

/**
 * The month's planted bookings in the order they are planted. It reads no booking.
 *
 * The date of one that is dated outside the month never leaves the fiscal year: in the first
 * month of a fiscal year all of them lie after the month, in the last all before it, and in
 * any other month half of them on either side.
 */
function plantedIn(seed: number, client: SampleClient, monthIndex: number): Planted[] {
  const findings = expectedFindings(seed, client, monthIndex);
  const { month } = monthAt(monthIndex);
  const outside = findings["date-outside-month"];
  const startsFiscalYear = month === client.fiscalYearStartMonth;
  const endsFiscalYear = month % MONTHS_PER_YEAR === client.fiscalYearStartMonth - 1;
  const early = startsFiscalYear ? 0 : endsFiscalYear ? outside : Math.ceil(outside / 2);
  const random = seededGenerator(
    mixedSeed(seed, STREAM.plantedPoint, client.row.client_id, monthIndex)
  );
  return PLANTING_ORDER.flatMap((rule) =>
    Array.from({ length: findings[rule] }, (_, index) => ({ rule, index, of: findings[rule] }))
  ).map((planted, ordinal) => ({
    ...planted,
    ordinal,
    point: planted.rule === "date-outside-month" ? (planted.index < early ? 0 : 1) : random()
  }));
}

/** What of a month is planted, as the numbering of its documents needs it. It reads no booking. */
export function plantedPoints(
  seed: number,
  client: SampleClient,
  monthIndex: number
): PlantedPoints {
  const planted = plantedIn(seed, client, monthIndex);
  return {
    bookings: planted.map(({ point }) => point),
    salesInvoices: planted.filter(isSalesInvoice).map(({ point }) => point)
  };
}

/**
 * Where the month's planted bookings stand among its clean ones, which `order` puts in the
 * order of their dates. It costs time in proportion to their number.
 *
 * A planted booking stands among the clean bookings of the day its point of the month falls
 * on, a day the client's office is open, so the month stays in the order of its dates and the
 * number of its document fits the day. A booking dated outside the month stands before the
 * month's first booking or behind its last, on no public holiday. A duplicate stands behind
 * the clean booking it copies, and no clean booking is copied twice.
 */
export function plan(seed: number, client: SampleClient, period: SampleMonth, order: Schedule) {
  const bookings = plantedIn(seed, client, period.index);
  const cleanCount = postingCount(seed, client, period.index) - bookings.length;
  const random = seededGenerator(mixedSeed(seed, STREAM.plan, client.row.client_id, period.index));
  const officeDay = dayAt(dayWeights(period, OFFICE_WEEK));
  const early = bookings.filter(
    ({ rule, point }) => rule === "date-outside-month" && point === 0
  ).length;
  const daysBefore = daysOutside(period, -1, OUTSIDE_DAYS);
  const daysAfter = daysOutside(period, 1, OUTSIDE_DAYS);
  // The farthest day takes all that the nearer days leave.
  const farthest = (days: number) => Math.min(OUTSIDE_DAYS - 1, days);
  const copied = new Set<number>();

  /** The clean booking a planted one stands before, by its position among the clean ones, and the day it is dated on. */
  function placeOf({ rule, index, point }: Planted): { before: number; day: number } {
    if (rule === "date-outside-month") {
      return index < early
        ? { before: 0, day: pick(daysBefore, farthest(early - 1 - index)) }
        : { before: cleanCount, day: pick(daysAfter, farthest(index - early)) };
    }
    if (rule === "duplicate-posting") {
      // Ends, because the duplicates are a small share of even the smallest month.
      for (;;) {
        const before = 1 + Math.floor(random() * (cleanCount - 1));
        if (copied.has(before)) continue;
        copied.add(before);
        return { before, day: order.at(before - 1).day };
      }
    }
    const day = officeDay(point);
    const { first, count } = order.on(day);
    return { before: first + Math.floor(random() * (count + 1)), day };
  }

  // Where several stand before the same clean booking, the earlier date comes first, and a
  // duplicate, the first to be planted there, follows the booking it copies at once.
  const inOrder = bookings
    .map((planted) => ({ ...planted, ...placeOf(planted) }))
    .sort(
      (left, right) =>
        left.before - right.before || left.day - right.day || left.ordinal - right.ordinal
    );
  const positions = inOrder.map(({ before }, number) => before + number);
  return {
    /** The planted bookings by their position in the month, each with the day (from 0) it is dated on. */
    planted: new Map(inOrder.map((planted, number) => [pick(positions, number), planted])),
    /** How many planted bookings stand before `position`. */
    plantedBefore(position: number): number {
      let low = 0;
      let high = positions.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pick(positions, middle) < position) low = middle + 1;
        else high = middle;
      }
      return low;
    }
  };
}

/**
 * The planted booking that breaks `rule` and no other, made of an ordinary booking of the
 * client's month.
 */
export function plantedBooking(
  seed: number,
  client: SampleClient,
  period: SampleMonth,
  rule: Exclude<AccountingRuleId, "duplicate-posting">,
  planted: Planted,
  extra: ExtraBookings
): Booking {
  const { ordinal, index, of } = planted;
  const ledger = LEDGERS[client.skr];
  const monthSeed = mixedSeed(seed, STREAM.plan, client.row.client_id, period.index);
  const random = seededGenerator(mixedSeed(monthSeed, ordinal));
  switch (rule) {
    case "date-outside-month":
      return extra.purchase(ordinal);
    case "vat-key-account-mismatch": {
      const { inputVatKeys, vatKeys } = ACCOUNTING_RULES[rule].parameters;
      // A purchase with a key of sales, or a sales invoice with a key of purchases.
      if (!isSalesInvoice(planted)) {
        return { ...extra.purchase(ordinal), vatKey: drawn(vatKeys, random) };
      }
      // An automatic account would apply its own key, so the invoice is booked on an account
      // without one: the first such of the client's industry, or `Erlöse`.
      const account = client.business.profile.invoices
        .lines(period.year)
        .map((line) => ledger[line.account])
        .find(({ automatic_vat_key }) => automatic_vat_key === null);
      return {
        ...extra.salesInvoice(Math.floor(index / 2)),
        account: account ?? ledger.revenue,
        vatKey: drawn(inputVatKeys, random)
      };
    }
    case "blocked-account":
      // A purchase on an account the consultancy has closed for the client, or from a
      // supplier whose creditor it has closed.
      return random() < 0.5
        ? {
            ...extra.purchase(ordinal),
            account: ledger[drawn(client.business.blockedAccounts, random)]
          }
        : extra.purchase(ordinal, formerSupplierOf(client, random()));
    case "round-amount-no-document": {
      const { thresholdEuros, roundingUnitEuros } = ACCOUNTING_RULES[rule].parameters;
      // A standing order paid once more, by hand: no statement number, and a round amount
      // from the threshold up to three times it or, where a month has more such bookings
      // than that gives amounts, further. Each takes an amount of its own.
      const amounts = Math.max((2 * thresholdEuros) / roundingUnitEuros, of);
      const units = thresholdEuros / roundingUnitEuros + shuffled(index, amounts, monthSeed);
      return { ...extra.standingOrder(), cents: units * roundingUnitEuros * 100, document: "" };
    }
    case "expense-in-credit":
      return { ...extra.purchase(ordinal), side: "H" };
    case "missing-cost-centre":
      return { ...extra.purchase(ordinal), costCentre: "" };
  }
}
