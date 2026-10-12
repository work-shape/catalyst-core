import { mixedSeed, pick, seededGenerator } from "../random.js";
import type { Ledger } from "./accounts.js";
import type { Booking } from "./booking.js";
import type { SampleMonth } from "./calendar.js";
import { postingCount, STREAM, type SampleClient } from "./clients.js";
import { ACCOUNTING_RULES, type AccountingRuleId } from "./rules.js";

// The planted bookings of a month: how many break each rule, where they stand, and what each
// says. A planted booking is added to the client's business and replaces none of it, so the
// clean bookings around it still add up. It is an office purchase on account with one thing
// wrong, and so it breaks exactly one rule of rules.ts. Its supplier numbers it behind the
// month's last purchase, whatever day it is dated on: the one number that does not fit its day.

/** A month with fewer bookings than this plants at most one booking per rule, and seldom. */
const SMALL_MONTH = 300;
/** The chance that a month holds bookings that break a given rule: in a small month, and in any other. */
const RULE_PRESENCE = { small: 0.25, other: 0.6 } as const;
/** A month that is not small plants up to two bookings per rule, and one more for each so many bookings. */
const POSTINGS_PER_FURTHER_FINDING = 2_500;
/** How many days before or after the month a planted date may lie. */
const OUTSIDE_DAYS = 5;
const MONTHS_PER_YEAR = 12;

type Random = () => number;
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

export function plantedCount(seed: number, client: SampleClient, monthIndex: number): number {
  return Object.values(expectedFindings(seed, client, monthIndex)).reduce(
    (sum, count) => sum + count,
    0
  );
}

/** A planted booking: the rule it breaks and its number among the month's planted bookings. */
interface Planted {
  rule: AccountingRuleId;
  ordinal: number;
  /** For a booking dated outside the month: how many days before its first day (negative) or after its last. */
  outsideDays?: number;
}

/**
 * Where the month's planted bookings stand. It costs time in proportion to their number.
 *
 * A booking dated outside the month stands at the month's start or end, where its date keeps
 * the order. Its date never leaves the fiscal year: in the first month of a fiscal year all
 * of them lie after the month, in the last all before it. Every other planted booking takes a
 * free position, and a duplicate also keeps the position before it free, so that it copies a
 * clean booking and with it that booking's date.
 */
export function plan(seed: number, client: SampleClient, period: SampleMonth) {
  const count = postingCount(seed, client, period.index);
  const findings = expectedFindings(seed, client, period.index);
  const random = seededGenerator(mixedSeed(seed, STREAM.plan, client.row.client_id, period.index));
  const planted = new Map<number, Planted>();
  const originals = new Set<number>();
  const free = (position: number) => !planted.has(position) && !originals.has(position);
  const plant = (position: number, rule: AccountingRuleId, outsideDays?: number) =>
    planted.set(position, { rule, ordinal: planted.size, outsideDays });

  const outside = findings["date-outside-month"];
  const startsFiscalYear = period.month === client.fiscalYearStartMonth;
  const endsFiscalYear = period.month % MONTHS_PER_YEAR === client.fiscalYearStartMonth - 1;
  const early = startsFiscalYear ? 0 : endsFiscalYear ? outside : Math.ceil(outside / 2);
  const late = outside - early;
  for (let position = 0; position < early; position += 1) {
    plant(position, "date-outside-month", -1 - Math.min(OUTSIDE_DAYS - 1, early - 1 - position));
  }
  for (let position = count - late; position < count; position += 1) {
    plant(
      position,
      "date-outside-month",
      period.days + Math.min(OUTSIDE_DAYS - 1, position - (count - late))
    );
  }

  /** Ends, because the planted bookings are a small share of even the smallest month. */
  function place(rule: AccountingRuleId) {
    for (let remaining = findings[rule]; remaining > 0;) {
      const position = early + Math.floor(random() * (count - early - late));
      if (!free(position)) continue;
      if (rule === "duplicate-posting") {
        const original = position - 1;
        if (original < early || !free(original)) continue;
        originals.add(original);
      }
      plant(position, rule);
      remaining -= 1;
    }
  }
  place("duplicate-posting");
  place("vat-key-account-mismatch");
  place("blocked-account");
  place("round-amount-no-document");
  place("expense-in-credit");
  place("missing-cost-centre");

  const positions = [...planted.keys()].sort((left, right) => left - right);
  return {
    planted,
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

/** The booking that breaks `rule` and no other, made of a clean office purchase on account. */
export function plantedBooking(
  purchase: Booking,
  rule: Exclude<AccountingRuleId, "duplicate-posting" | "date-outside-month">,
  ledger: Ledger,
  random: Random
): Booking {
  switch (rule) {
    case "vat-key-account-mismatch": {
      const { inputVatKeys, vatKeys } = ACCOUNTING_RULES[rule].parameters;
      // Either the purchase carries a key of sales, or it is booked on a revenue account.
      return random() < 0.5
        ? { ...purchase, vatKey: drawn(vatKeys, random) }
        : {
            ...purchase,
            account: ledger.revenue,
            vatKey: drawn(inputVatKeys, random),
            costCentre: ""
          };
    }
    case "blocked-account":
      return random() < 0.5
        ? { ...purchase, account: ledger.otherExpenses }
        : { ...purchase, contra: ledger.clearing };
    case "round-amount-no-document": {
      const { thresholdEuros, roundingUnitEuros } = ACCOUNTING_RULES[rule].parameters;
      // From the threshold up to three times it: a payment a small business would still make.
      const units = (2 * thresholdEuros) / roundingUnitEuros;
      return {
        ...purchase,
        account: ledger.legal,
        contra: ledger.bank,
        vatKey: 0,
        cents:
          (thresholdEuros / roundingUnitEuros + Math.floor(random() * units)) *
          roundingUnitEuros *
          100,
        // The creditor's account is labelled with the supplier's name.
        text: `Abschlagszahlung ${purchase.contra.label}`,
        document: "",
        documentLink: ""
      };
    }
    case "expense-in-credit":
      return { ...purchase, side: "H" };
    case "missing-cost-centre":
      return { ...purchase, costCentre: "" };
  }
}
