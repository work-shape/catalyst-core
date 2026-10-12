import { beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTING_RULES } from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./support/assertions";
import {
  cents,
  chartOf,
  everyPosting,
  isCreditor,
  isDebtor,
  referenceFindings,
  sample,
  sizeGroupOf,
  type Posting,
  type RuleId
} from "./support/sample-accounting";

// Whether a month holds exactly the findings the sample expects: every booking of a
// client-month is checked against the sentences of the rules, by a check that knows nothing of
// how the bookings were made, and the counts are compared with `expectedFindings`.

const RULE_IDS: readonly RuleId[] = [
  "duplicate-posting",
  "vat-key-account-mismatch",
  "blocked-account",
  "round-amount-no-document",
  "date-outside-month",
  "expense-in-credit",
  "missing-cost-centre"
];
/** The most of the invoices numbered out of order that may be planted: no more than any hundred invoices hold. */
const PLANTED_OUT_OF_ORDER_BOUND = 0.02;
/** Two planted round bookings were alike here once, so one of them was a duplicate as well. */
const PINNED = { clientId: 1457, month: "2025-02" };
const SAMPLE_SEED = 20261012;

interface ClientMonth {
  clientId: number;
  month: string;
}

/** One month of every client, drawn by the seed: 600 client-months over all size groups. */
function sampledClientMonths(): ClientMonth[] {
  const { months } = sample;
  return sample.clients.map(({ client_id }) => ({
    clientId: client_id,
    month: required(months[(Math.imul(client_id ^ SAMPLE_SEED, 0x9e3779b1) >>> 0) % months.length])
  }));
}

/** What a booking says besides its numbers: the first word of its text and the kind of its two accounts. */
function shapeOf(row: {
  posting_description: string;
  account_number: number;
  contra_account_number: number;
}) {
  const kindOf = (account: number) =>
    isDebtor(account) ? "debtor" : isCreditor(account) ? "creditor" : String(account);
  const [word] = row.posting_description.split(" ");
  return `${word} on ${kindOf(row.account_number)} against ${kindOf(row.contra_account_number)}`;
}

/** The digits of a document number as one number, to compare two numbers of one counterparty. */
const numberOf = (document: string) => Number(document.replace(/\D/gu, ""));

/**
 * The places of the invoices that are numbered out of order: one with a higher number than a
 * later-dated invoice of the same customer or supplier. `invoices` are the places of all
 * invoices of a month, in its order.
 */
function numberedOutOfOrder(rows: readonly Posting[], invoices: readonly number[]): number[] {
  const byCounterparty = new Map<number, number[]>();
  for (const place of invoices) {
    const counterparty = required(rows[place]).contra_account_number;
    byCounterparty.set(counterparty, [...(byCounterparty.get(counterparty) ?? []), place]);
  }
  const found: number[] = [];
  for (const places of byCounterparty.values()) {
    // From the last invoice back: the lowest number among those dated on a later day.
    let lowestLater = Infinity;
    let lowestOfDay = Infinity;
    let day = "";
    for (const place of places.toReversed()) {
      const { date, document_field_1 } = required(rows[place]);
      if (date !== day) {
        lowestLater = Math.min(lowestLater, lowestOfDay);
        lowestOfDay = Infinity;
        day = date;
      }
      const number = numberOf(document_field_1);
      if (number > lowestLater) found.push(place);
      lowestOfDay = Math.min(lowestOfDay, number);
    }
  }
  return found;
}

function recount(clientMonths: readonly ClientMonth[]) {
  const result = {
    bookings: 0,
    /** The client-months whose findings are not the expected ones. */
    mismatches: [] as string[],
    /** The bookings that break more than one rule. */
    brokenTwice: [] as string[],
    /** The bookings that are no row of a ledger, whatever was planted. */
    unkept: [] as string[],
    totals: new Map<string, number>(RULE_IDS.map((rule) => [rule, 0])),
    monthsWithoutSomeRule: 0,
    sizes: new Set<string>(),
    /** The shapes of the bookings that break no rule, and of those that break one. */
    ordinaryShapes: new Set<string>(),
    plantedShapes: new Set<string>(),
    /** The invoices on a personal account, and those of them numbered out of order: all, and the planted ones. */
    invoices: { all: 0, planted: 0 },
    outOfOrder: { all: 0, planted: 0 }
  };
  for (const { clientId, month } of clientMonths) {
    const where = `client ${clientId} in ${month}`;
    const chart = chartOf(clientId);
    const rows = everyPosting(clientId, month);
    const found = referenceFindings(rows, chart, month);
    const expected = sample.expectedFindings(clientId, month);
    result.bookings += rows.length;
    result.sizes.add(sizeGroupOf(rows.length).name);
    for (const rule of RULE_IDS) {
      const count = found[rule].length;
      if (count !== expected[rule]) {
        result.mismatches.push(`${where}: ${rule} ${count}, expected ${expected[rule]}`);
      }
      result.totals.set(rule, required(result.totals.get(rule)) + count);
    }
    if (RULE_IDS.some((rule) => found[rule].length === 0)) result.monthsWithoutSomeRule += 1;
    const planted = new Set<number>();
    for (const place of Object.values(found).flat()) {
      if (planted.has(place)) result.brokenTwice.push(`${where}: booking ${place}`);
      planted.add(place);
    }

    const [fiscalYear] = sample
      .fiscalYears(clientId)
      .filter((year) => String(year.fiscal_year_start) === required(rows[0]).fiscal_year);
    const { fiscal_year_start: yearStart, fiscal_year_end: yearEnd } = required(fiscalYear);
    for (const [place, row] of rows.entries()) {
      (planted.has(place) ? result.plantedShapes : result.ordinaryShapes).add(shapeOf(row));
      const day = Number(row.date.replaceAll("-", ""));
      const automatic =
        required(chart.get(row.account_number)).automatic_vat_key ??
        required(chart.get(row.contra_account_number)).automatic_vat_key;
      const kept =
        // Whatever its date, a booking lies in the fiscal year it names.
        day >= yearStart &&
        day <= yearEnd &&
        row.fiscal_year === String(yearStart) &&
        row.follow_up_index === 0 &&
        /^$|^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/u.test(row.document_link) &&
        row.amount > 0 &&
        cents(row.net_amount) + cents(row.tax_amount) === cents(row.amount) &&
        cents(row.tax_amount) ===
          Math.round((cents(row.amount) * row.tax_rate) / (100 + row.tax_rate)) &&
        // An automatic account applies its key by itself, so the booking carries none.
        (automatic === null || row.accounting_transaction_key === 0);
      if (!kept) result.unkept.push(`${where}: ${JSON.stringify(row)}`);
    }

    // An invoice books revenue or an expense against a customer or a supplier. A discount
    // does so too and carries the number of the invoice it belongs to, so it is left out.
    const invoices = rows.flatMap((row, place) =>
      row.contra_account_number > 9_999 &&
      row.document_field_1 !== "" &&
      !row.posting_description.startsWith("Skonto ") &&
      ["revenue", "expense"].includes(required(chart.get(row.account_number)).account_class)
        ? [place]
        : []
    );
    const outOfOrder = numberedOutOfOrder(rows, invoices);
    result.invoices.all += invoices.length;
    result.invoices.planted += invoices.filter((place) => planted.has(place)).length;
    result.outOfOrder.all += outOfOrder.length;
    result.outOfOrder.planted += outOfOrder.filter((place) => planted.has(place)).length;
  }
  return result;
}

describe("demo sample accounting findings", () => {
  let counted: ReturnType<typeof recount>;
  beforeAll(() => {
    counted = recount(sampledClientMonths());
  }, 120_000);

  it("words each rule as one sentence in German and in English", () => {
    expect(Object.keys(ACCOUNTING_RULES)).toEqual(RULE_IDS);
    for (const rule of Object.values(ACCOUNTING_RULES)) {
      expect(rule.de).toMatch(/^Eine Buchung ist ein Befund, wenn .+\.$/u);
      expect(rule.en).toMatch(/^A booking is a finding when .+\.$/u);
    }
  });

  it("plants exactly the expected findings where two planted bookings were alike once", () => {
    expect(recount([PINNED]).mismatches).toEqual([]);
  });

  it("plants exactly the expected findings in one month of every client, one rule per booking", () => {
    expect(counted.mismatches).toEqual([]);
    expect(counted.brokenTwice).toEqual([]);
    expect(counted.sizes).toEqual(new Set(["micro", "small", "medium", "large"]));
    // The sample is no empty proof: every rule is broken somewhere, and no month by every rule.
    for (const rule of RULE_IDS) expect(counted.totals.get(rule), rule).toBeGreaterThan(0);
    expect(counted.monthsWithoutSomeRule).toBeGreaterThan(0);
  });

  it("keeps in every booking what a ledger keeps, whatever was planted", () => {
    expect(counted.unkept).toEqual([]);
  });

  it("gives a planted booking no text and no pair of accounts that only planted bookings have", () => {
    expect(counted.bookings).toBeGreaterThan(1_000_000);
    expect(counted.plantedShapes.size).toBeGreaterThan(RULE_IDS.length);
    expect(
      [...counted.plantedShapes].filter((shape) => !counted.ordinaryShapes.has(shape))
    ).toEqual([]);
  });

  it("numbers invoices out of order whether they are planted or not, so the pattern names no planted one", () => {
    const { invoices, outOfOrder } = counted;
    expect(invoices.all).toBeGreaterThan(500_000);
    expect(invoices.planted).toBeGreaterThan(1_000);
    // Common among all invoices: one in fifty at the least.
    expect(outOfOrder.all).toBeGreaterThan(invoices.all / 50);
    // Some of them are planted, and few: about the share planted invoices have of all.
    expect(outOfOrder.planted).toBeGreaterThan(0);
    expect(outOfOrder.planted / outOfOrder.all).toBeLessThan(PLANTED_OUT_OF_ORDER_BOUND);
  });
});
