import { mixedSeed, pick, seededGenerator, shuffled } from "../random.js";
import { LEDGERS } from "./accounts.js";
import type { ExtraBookings } from "./activities.js";
import type { Booking } from "./booking.js";
import { daysOutside, MONTHS_PER_YEAR, type SampleMonth } from "./calendar.js";
import { postingCount, STREAM, type SampleClient } from "./clients.js";
import { formerSupplierOf } from "./counterparties.js";
import type { PlantedCounts, Random } from "./frame.js";
import { ACCOUNTING_RULES, type AccountingRuleId } from "./rules.js";

// The planted bookings of a month: how many break each rule, where they stand, and what each
// says. A planted booking is added to the client's business and replaces none of it, so the
// clean bookings around it still add up. It is an ordinary booking of the client with one
// thing wrong: the text and the pair of accounts of each are those of clean bookings, and
// only the rule it breaks tells it apart.
//
// No planted booking is like another booking of the month, clean or planted, so none is a
// duplicate by accident:
//
// - A purchase and a sales invoice carry a document number of their own, behind the month's
//   last: the one number that does not fit its day.
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

/** What of a month is planted, as the numbering of its documents needs it. It reads no booking. */
export function plantedCounts(
  seed: number,
  client: SampleClient,
  monthIndex: number
): PlantedCounts {
  const findings = expectedFindings(seed, client, monthIndex);
  return {
    bookings: Object.values(findings).reduce((sum, count) => sum + count, 0),
    salesInvoices: salesInvoicesAmong(findings["vat-key-account-mismatch"])
  };
}

/**
 * Of the bookings of a month that break the rule of the VAT keys, the first is a purchase,
 * the second a sales invoice, and so on in turn. So many of the first `count` are invoices.
 */
function salesInvoicesAmong(count: number): number {
  return Math.floor(count / 2);
}

/** A planted booking: the rule it breaks and its numbers among the month's planted bookings. */
interface Planted {
  rule: AccountingRuleId;
  ordinal: number;
  /** Its number among the `of` bookings of the month that break the same rule. */
  index: number;
  of: number;
  /** For a booking dated outside the month: its day, counted from the month's first day. */
  outsideDay?: number;
}

/**
 * Where the month's planted bookings stand. It costs time in proportion to their number.
 *
 * A planted booking stands before a clean one and takes its date, which `datable` must allow
 * for the clean booking: a planted booking is dated on no day the client's office is closed.
 * No two stand before the same clean booking, so each has clean neighbours and a duplicate
 * copies the clean booking before it. A booking dated outside the month stands before the
 * month's first booking or behind its last, where its date keeps the order, and on no public
 * holiday. Its date never leaves the fiscal year: in the first month of a fiscal year all of
 * them lie after the month, in the last all before it.
 */
export function plan(
  seed: number,
  client: SampleClient,
  period: SampleMonth,
  datable: (cleanPosition: number) => boolean
) {
  const findings = expectedFindings(seed, client, period.index);
  const { bookings } = plantedCounts(seed, client, period.index);
  const cleanCount = postingCount(seed, client, period.index) - bookings;
  const random = seededGenerator(mixedSeed(seed, STREAM.plan, client.row.client_id, period.index));
  /** Each with the position, among the clean bookings, of the clean booking it stands before. */
  const placed: (Planted & { before: number })[] = [];
  const taken = new Set<number>();
  const plant = (before: number, rule: AccountingRuleId, outsideDay?: number) =>
    placed.push({
      before,
      rule,
      ordinal: placed.length,
      index: placed.filter((other) => other.rule === rule).length,
      of: findings[rule],
      outsideDay
    });

  const outside = findings["date-outside-month"];
  const startsFiscalYear = period.month === client.fiscalYearStartMonth;
  const endsFiscalYear = period.month % MONTHS_PER_YEAR === client.fiscalYearStartMonth - 1;
  const early = startsFiscalYear ? 0 : endsFiscalYear ? outside : Math.ceil(outside / 2);
  const daysBefore = daysOutside(period, -1, OUTSIDE_DAYS);
  const daysAfter = daysOutside(period, 1, OUTSIDE_DAYS);
  // The farthest day takes all that the nearer days leave.
  const farthest = (days: number) => Math.min(OUTSIDE_DAYS - 1, days);
  for (let number = 0; number < outside; number += 1) {
    if (number < early) {
      plant(0, "date-outside-month", pick(daysBefore, farthest(early - 1 - number)));
    } else {
      plant(cleanCount, "date-outside-month", pick(daysAfter, farthest(number - early)));
    }
  }

  /** Ends, because the planted bookings are a small share of even the smallest month. */
  function place(rule: AccountingRuleId) {
    for (let remaining = findings[rule]; remaining > 0;) {
      const before = Math.floor(random() * cleanCount);
      if (taken.has(before) || !datable(before)) continue;
      // A duplicate needs a clean booking before it.
      if (rule === "duplicate-posting" && before === 0) continue;
      taken.add(before);
      plant(before, rule);
      remaining -= 1;
    }
  }
  place("duplicate-posting");
  place("vat-key-account-mismatch");
  place("blocked-account");
  place("round-amount-no-document");
  place("expense-in-credit");
  place("missing-cost-centre");

  // The ones dated before the month were planted first and keep their place before the others.
  const inOrder = [...placed].sort(
    (left, right) => left.before - right.before || left.ordinal - right.ordinal
  );
  const positions = inOrder.map(({ before }, number) => before + number);
  return {
    /** The planted bookings by their position in the month. */
    planted: new Map<number, Planted>(
      inOrder.map((planted, number) => [pick(positions, number), planted])
    ),
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
  { ordinal, index, of }: Planted,
  extra: ExtraBookings
): Booking {
  const ledger = LEDGERS[client.skr];
  const monthSeed = mixedSeed(seed, STREAM.plan, client.row.client_id, period.index);
  const random = seededGenerator(mixedSeed(monthSeed, ordinal));
  switch (rule) {
    case "date-outside-month":
      return extra.purchase(ordinal);
    case "vat-key-account-mismatch": {
      const { inputVatKeys, vatKeys } = ACCOUNTING_RULES[rule].parameters;
      // A purchase with a key of sales, or a sales invoice with a key of purchases.
      const invoicesBefore = salesInvoicesAmong(index);
      if (salesInvoicesAmong(index + 1) === invoicesBefore) {
        return { ...extra.purchase(ordinal), vatKey: drawn(vatKeys, random) };
      }
      // An automatic account would apply its own key, so the invoice is booked on an account
      // without one: the first such of the client's industry, or `Erlöse`.
      const account = client.business.profile.invoices
        .lines(period.year)
        .map((line) => ledger[line.account])
        .find(({ automatic_vat_key }) => automatic_vat_key === null);
      return {
        ...extra.salesInvoice(invoicesBefore),
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
