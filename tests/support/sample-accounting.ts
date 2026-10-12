import type { z } from "zod";
import {
  ACCOUNTING_RULES,
  createAccountingSample,
  SIZE_GROUPS,
  type accountingOutputSchemas
} from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./assertions";

// What the tests of the demo's accounting sample share: the data of the server's own seed, as
// the generator gives it without a server, and how to read it.

export type Posting = z.output<typeof accountingOutputSchemas.list_postings>["rows"][number];
export type Account = z.output<typeof accountingOutputSchemas.list_accounts>["rows"][number];
export type RuleId = keyof typeof ACCOUNTING_RULES;

export const sample = createAccountingSample();
export const MONTHS = ["2024-02", "2026-09"] as const;
export const [MONTH] = MONTHS;

export const INDUSTRIES = [
  "retail",
  "crafts",
  "restaurant",
  "medicalPractice",
  "propertyManagement",
  "consulting",
  "manufacturing",
  "freelancer"
] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** The nine public holidays all of Germany keeps, in the years of the sample. */
export const PUBLIC_HOLIDAYS: readonly string[] = [
  ...["01-01", "03-29", "04-01", "05-01", "05-09", "05-20", "10-03", "12-25", "12-26"].map(
    (day) => `2024-${day}`
  ),
  ...["01-01", "04-18", "04-21", "05-01", "05-29", "06-09", "10-03", "12-25", "12-26"].map(
    (day) => `2025-${day}`
  ),
  ...["01-01", "04-03", "04-06", "05-01", "05-14", "05-25", "10-03", "12-25", "12-26"].map(
    (day) => `2026-${day}`
  )
];

export function sizeGroupOf(count: number) {
  return required(SIZE_GROUPS.find((group) => count >= group.minimum && count <= group.maximum));
}

/** The client ids of a size group, the ones with the fewest bookings in `MONTH` first. */
export function clientIdsOf(group: (typeof SIZE_GROUPS)[number]["name"]): number[] {
  return sample.clients
    .map(({ client_id }) => ({ client_id, count: sample.postingCount(client_id, MONTH) }))
    .filter(({ count }) => sizeGroupOf(count).name === group)
    .sort((left, right) => left.count - right.count)
    .map(({ client_id }) => client_id);
}

/** The first clients of an industry, by `client_id`, whose month has at most `maximum` bookings. */
export function clientsOf(industry: Industry, howMany: number, maximum = 1_500): number[] {
  return sample.clients
    .map(({ client_id }) => client_id)
    .filter(
      (id) =>
        sample.businessOf(id).industry === industry && sample.postingCount(id, MONTH) <= maximum
    )
    .slice(0, howMany);
}

export function everyPosting(clientId: number, month: string): Posting[] {
  return sample.postings(clientId, month, 0, sample.postingCount(clientId, month));
}

export const cents = (euros: number) => Math.round(euros * 100);

export const isDebtor = (account: number) => account >= 10_000 && account <= 69_999;
export const isCreditor = (account: number) => account >= 70_000 && account <= 99_999;

/** The day of the week of a date as `YYYY-MM-DD`: 0 for Sunday to 6 for Saturday. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function chartOf(clientId: number): Map<number, Account> {
  return new Map(sample.accounts(clientId).map((account) => [account.account_number, account]));
}

/**
 * The places of the bookings that break each rule, checked as the rule's sentence in
 * `ACCOUNTING_RULES` says and with its parameters. It knows nothing of how the bookings were made.
 */
export function referenceFindings(
  rows: readonly Posting[],
  chart: ReadonlyMap<number, Account>,
  month: string
): Record<RuleId, number[]> {
  const accountOf = (number: number) => required(chart.get(number));
  const duplicate = ACCOUNTING_RULES["duplicate-posting"].parameters;
  const vat = ACCOUNTING_RULES["vat-key-account-mismatch"].parameters;
  const round = ACCOUNTING_RULES["round-amount-no-document"].parameters;
  const someBookingHasCostCentre = rows.some((row) => row.kost1 !== "");
  const seen = new Set<string>();
  const found: Record<RuleId, number[]> = {
    "duplicate-posting": [],
    "vat-key-account-mismatch": [],
    "blocked-account": [],
    "round-amount-no-document": [],
    "date-outside-month": [],
    "expense-in-credit": [],
    "missing-cost-centre": []
  };
  for (const [index, row] of rows.entries()) {
    const accountClass = accountOf(row.account_number).account_class;
    const key = row.accounting_transaction_key;

    const alike = JSON.stringify(duplicate.fields.map((field) => row[field]));
    if (seen.has(alike)) found["duplicate-posting"].push(index);
    seen.add(alike);

    if (
      (vat.inputVatKeys.some((inputKey) => inputKey === key) && accountClass === "revenue") ||
      (vat.vatKeys.some((vatKey) => vatKey === key) && accountClass === "expense")
    ) {
      found["vat-key-account-mismatch"].push(index);
    }
    if (accountOf(row.account_number).blocked || accountOf(row.contra_account_number).blocked) {
      found["blocked-account"].push(index);
    }
    if (
      row.document_field_1 === "" &&
      cents(row.amount) >= cents(round.thresholdEuros) &&
      cents(row.amount) % cents(round.roundingUnitEuros) === 0
    ) {
      found["round-amount-no-document"].push(index);
    }
    if (row.date < `${month}-01` || row.date > `${month}-31`) {
      found["date-outside-month"].push(index);
    }
    if (
      accountClass === "expense" &&
      row.debit_credit_indicator === "H" &&
      row.general_reversal === 0
    ) {
      found["expense-in-credit"].push(index);
    }
    if (accountClass === "expense" && row.kost1 === "" && someBookingHasCostCentre) {
      found["missing-cost-centre"].push(index);
    }
  }
  return found;
}
