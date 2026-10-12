import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_MAXIMUM_PAGE_SIZE,
  ACCOUNTING_RULES,
  SIZE_GROUPS
} from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./support/assertions";
import {
  cents,
  chartOf,
  everyPosting,
  isCreditor,
  isDebtor,
  MONTH,
  MONTHS,
  sample,
  type Posting
} from "./support/sample-accounting";

// Whether the books of the accounting sample are those of real businesses: who the clients
// are, what they earn and spend, whom they deal with and how an invoice is settled.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Two months that follow one another, to see what carries over from one to the next. */
const SEPTEMBER = "2026-09";
const OCTOBER = "2026-10";
const YEAR = Array.from({ length: 12 }, (_, month) => `2025-${String(month + 1).padStart(2, "0")}`);
const OWNER_RUN_FORMS = ["Einzelunternehmen", "Freiberufler", "GbR", "e. K."];
const INDUSTRIES = [
  "retail",
  "crafts",
  "restaurant",
  "medicalPractice",
  "propertyManagement",
  "consulting",
  "manufacturing",
  "freelancer"
] as const;
type Industry = (typeof INDUSTRIES)[number];

/** The first clients of an industry, by `client_id`, whose month has at most `maximum` bookings. */
function clientsOf(industry: Industry, howMany: number, maximum = 1_500): number[] {
  return sample.clients
    .map(({ client_id }) => client_id)
    .filter(
      (id) =>
        sample.businessOf(id).industry === industry && sample.postingCount(id, MONTH) <= maximum
    )
    .slice(0, howMany);
}

/** A period's net revenue and net expenses, as the accounts' classes and the booking sides say. */
function profitAndLoss(clientId: number, months: readonly string[]) {
  const chart = chartOf(clientId);
  let revenue = 0;
  let expenses = 0;
  for (const month of months) {
    for (const row of everyPosting(clientId, month)) {
      const accountClass = required(chart.get(row.account_number)).account_class;
      const credit = row.debit_credit_indicator === "H" ? 1 : -1;
      if (accountClass === "revenue") revenue += credit * cents(row.net_amount);
      if (accountClass === "expense") expenses -= credit * cents(row.net_amount);
    }
  }
  return { revenue, expenses, margin: (revenue - expenses) / revenue };
}

function median(values: number[]): number {
  return required([...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]);
}

/** The digits of a document number as one number, to compare two numbers of one format. */
const numberOf = (document: string) => Number(document.replace(/\D/gu, ""));
/** The format of a document number: the number with every digit replaced. */
const formatOf = (document: string) => document.replace(/\d/gu, "9");

describe("demo sample accounting books", () => {
  it("has the client list of a real firm: mostly sole traders and freelancers, and volume that fits the legal form", () => {
    const forms = new Map<string, number>();
    for (const { client_id } of sample.clients) {
      const { legalForm, industry } = sample.businessOf(client_id);
      forms.set(legalForm, (forms.get(legalForm) ?? 0) + 1);
      const most = Math.max(...MONTHS.map((month) => sample.postingCount(client_id, month)));
      // A sole trader, a freelancer, a partnership or a UG has no large ledger.
      if ([...OWNER_RUN_FORMS, "UG (haftungsbeschränkt)"].includes(legalForm)) {
        expect(most, `${legalForm} ${client_id}`).toBeLessThanOrEqual(4_000);
      }
      // The largest months belong to the forms and industries that produce them.
      if (most === 100_000) {
        expect(["GmbH", "GmbH & Co. KG", "AG"]).toContain(legalForm);
        expect(["retail", "manufacturing"]).toContain(industry);
      }
      if (["freelancer", "medicalPractice", "propertyManagement"].includes(industry)) {
        expect(most, `${industry} ${client_id}`).toBeLessThanOrEqual(4_000);
      }
    }
    expect(Object.fromEntries(forms)).toEqual({
      Einzelunternehmen: 150,
      Freiberufler: 125,
      GmbH: 110,
      GbR: 70,
      "e. K.": 65,
      "GmbH & Co. KG": 45,
      "UG (haftungsbeschränkt)": 25,
      AG: 7,
      eG: 3
    });
    expect(
      new Set(sample.clients.map(({ client_id }) => sample.businessOf(client_id).industry))
    ).toEqual(new Set(INDUSTRIES));
  });

  it("lists the clients in no alphabetical order and with mandates that began over many years", () => {
    const names = sample.clients.map(({ name }) => name);
    // In an alphabetical list every name follows a smaller one. Here about half do.
    const rising = names.filter((name, index) => index > 0 && name > required(names[index - 1]));
    expect(rising.length).toBeGreaterThan(200);
    expect(rising.length).toBeLessThan(400);
    const years = new Set(sample.clients.map(({ created_at }) => created_at.slice(0, 4)));
    expect(years.size).toBeGreaterThanOrEqual(15);
    for (const { created_at } of sample.clients) expect(created_at < "2024-01-01").toBe(true);
  });

  it("gives each industry margins of its own: most clients profitable, some not, none absurd", () => {
    const margins = new Map<Industry, number[]>(
      INDUSTRIES.map((industry) => [
        industry,
        clientsOf(industry, 8).map((id) => profitAndLoss(id, YEAR).margin)
      ])
    );
    const all = [...margins.values()].flat();
    expect(all).toHaveLength(8 * INDUSTRIES.length);
    for (const [industry, values] of margins) {
      for (const margin of values) {
        expect(margin, industry).toBeGreaterThan(-0.5);
        expect(margin, industry).toBeLessThan(0.75);
      }
      expect(median(values), industry).toBeGreaterThan(0);
    }
    const profitable = all.filter((margin) => margin > 0).length / all.length;
    expect(profitable).toBeGreaterThan(0.7);
    expect(profitable).toBeLessThan(1);
    // Where the owner's income is the profit, the margin is far above a trader's.
    const medianOf = (industry: Industry) => median(required(margins.get(industry)));
    expect(medianOf("freelancer")).toBeGreaterThan(medianOf("retail") + 0.15);
    expect(medianOf("medicalPractice")).toBeGreaterThan(medianOf("manufacturing") + 0.15);
    expect(medianOf("retail")).toBeLessThan(0.2);
  }, 120_000);

  it("relates debit and credit plausibly in each month and taxes each industry as its law says", () => {
    const share = (rows: Posting[], test: (row: Posting) => boolean) =>
      rows.filter(test).length / rows.length;
    for (const industry of INDUSTRIES) {
      for (const clientId of clientsOf(industry, 3, 4_000)) {
        const chart = chartOf(clientId);
        const classOf = (row: Posting) => required(chart.get(row.account_number)).account_class;
        const labelOf = (number: number) => required(chart.get(number)).label;
        for (const month of [SEPTEMBER, "2025-03"]) {
          const { revenue, expenses } = profitAndLoss(clientId, [month]);
          expect(revenue, `${industry} ${clientId} ${month}`).toBeGreaterThan(0);
          expect(expenses / revenue, `${industry} ${clientId} ${month}`).toBeGreaterThan(0.2);
          expect(expenses / revenue, `${industry} ${clientId} ${month}`).toBeLessThan(2.5);

          const rows = everyPosting(clientId, month);
          const sales = rows.filter((row) => classOf(row) === "revenue");
          const purchases = rows.filter(
            (row) =>
              classOf(row) === "expense" && row.document_link !== "" && row.record_type === "RE"
          );
          const rates = new Set(sales.map(({ tax_rate }) => tax_rate));
          if (industry === "medicalPractice") {
            expect(share(sales, ({ tax_rate }) => tax_rate === 0)).toBeGreaterThan(0.8);
            expect(share(purchases, ({ tax_rate }) => tax_rate > 0)).toBeLessThan(0.25);
          } else if (industry === "propertyManagement") {
            expect(
              share(sales, (row) => labelOf(row.account_number).includes("§ 4 Nr. 12 UStG"))
            ).toBeGreaterThan(0.6);
            expect(share(purchases, ({ tax_rate }) => tax_rate > 0)).toBeLessThan(0.5);
          } else {
            expect(share(purchases, ({ tax_rate }) => tax_rate > 0)).toBeGreaterThan(0.5);
          }
          if (industry === "restaurant") expect(rates).toEqual(new Set([7, 19]));
          if (industry === "retail") {
            expect(
              share(sales, (row) => labelOf(row.contra_account_number) === "Kasse")
            ).toBeGreaterThan(0.2);
          }

          // The payroll runs once a month: one journal, booked on one day, with wages, the
          // employer's social security and the wage tax owed.
          const payroll = rows.filter(({ record_type }) => record_type === "LO");
          if (payroll.length === 0) continue;
          expect(new Set(payroll.map(({ document_field_1 }) => document_field_1)).size).toBe(1);
          expect(new Set(payroll.map(({ document_link }) => document_link)).size).toBe(1);
          expect(new Set(payroll.map(({ date }) => date)).size).toBe(1);
          expect(new Set(payroll.map((row) => labelOf(row.account_number)))).toEqual(
            new Set(["Löhne und Gehälter", "Gesetzliche soziale Aufwendungen"])
          );
          expect(new Set(payroll.map((row) => labelOf(row.contra_account_number)))).toEqual(
            new Set([
              "Verbindlichkeiten aus Lohn und Gehalt",
              "Verbindlichkeiten aus Lohn- und Kirchensteuer",
              "Verbindlichkeiten im Rahmen der sozialen Sicherheit"
            ])
          );
        }
      }
    }
  }, 120_000);

  it("gives a client its own suppliers and customers that recur, and document numbers that move forward", () => {
    const [clientId] = clientsOf("crafts", 100, 4_000).filter(
      (id) => sample.postingCount(id, SEPTEMBER) >= 300
    );
    const chart = chartOf(required(clientId));
    const months = [SEPTEMBER, OCTOBER].map((month) => everyPosting(required(clientId), month));
    const [september, october] = months.map((rows) =>
      // A purchase on account: an expense against a creditor, with its document. A planted
      // duplicate repeats the booking before it and is no second invoice.
      rows.filter(
        (row, index) =>
          isCreditor(row.contra_account_number) &&
          required(chart.get(row.account_number)).account_class === "expense" &&
          row.document_field_1 !== "" &&
          JSON.stringify(row) !== JSON.stringify(rows[index - 1])
      )
    );
    let outOfOrder = 0;
    const byCreditor = (rows: Posting[]) => {
      const groups = new Map<number, Posting[]>();
      for (const row of rows) {
        groups.set(row.contra_account_number, [
          ...(groups.get(row.contra_account_number) ?? []),
          row
        ]);
      }
      return groups;
    };
    const before = byCreditor(required(september));
    const after = byCreditor(required(october));

    // A few suppliers do much of the business, many do a little, and most come back.
    const sizes = [...after.values()]
      .map((rows) => rows.length)
      .sort((left, right) => right - left);
    expect(sizes.length).toBeGreaterThanOrEqual(8);
    expect(sizes.slice(0, 5).reduce((sum, size) => sum + size, 0)).toBeGreaterThan(
      required(october).length * 0.25
    );
    expect(sizes.filter((size) => size <= 2).length).toBeGreaterThanOrEqual(3);
    const returning = required(october).filter((row) => before.has(row.contra_account_number));
    expect(returning.length).toBeGreaterThan(required(october).length * 0.6);

    for (const [creditor, rows] of after) {
      const { label } = required(chart.get(creditor));
      const earlier = before.get(creditor) ?? [];
      // The booking text names the supplier and the number of its invoice.
      for (const row of rows) {
        expect(row.posting_description).toBe(`ER ${row.document_field_1} ${label}`);
      }
      // A supplier keeps its number format, gives no number twice, and its numbers rise from
      // day to day and from month to month. Only a planted purchase has a number that does
      // not fit its day: it carries the supplier's number behind the month's last.
      const formats = new Set([...earlier, ...rows].map((row) => formatOf(row.document_field_1)));
      expect(formats.size, label).toBe(1);
      const numbers = [...earlier, ...rows].map((row) => numberOf(row.document_field_1));
      expect(new Set(numbers).size).toBe(numbers.length);
      for (const [index, row] of rows.entries()) {
        const previous = rows[index - 1];
        if (
          previous &&
          previous.date < row.date &&
          numberOf(row.document_field_1) < numberOf(previous.document_field_1)
        ) {
          outOfOrder += 1;
        }
      }
      for (const row of earlier) {
        expect(numberOf(row.document_field_1)).toBeLessThan(
          numberOf(required(rows[0]).document_field_1)
        );
      }
    }
    expect(outOfOrder).toBeLessThanOrEqual(
      Object.values(sample.expectedFindings(required(clientId), OCTOBER)).reduce(
        (sum, count) => sum + count,
        0
      )
    );
    // Suppliers do not share one format.
    expect(
      new Set(required(october).map((row) => formatOf(row.document_field_1))).size
    ).toBeGreaterThan(1);

    // No document number is the booking's position in the month.
    for (const rows of months) {
      for (const [index, row] of rows.entries()) {
        expect(row.document_field_1.endsWith(String(index + 1).padStart(6, "0"))).toBe(false);
      }
    }

    // The client numbers its own invoices in one range without a gap, across the months.
    const ownNumbers = months.map((rows) =>
      [
        ...new Set(
          rows
            .filter(
              (row) =>
                isDebtor(row.contra_account_number) &&
                required(chart.get(row.account_number)).account_class === "revenue"
            )
            .map((row) => numberOf(row.document_field_1))
        )
      ].sort((left, right) => left - right)
    );
    for (const numbers of ownNumbers) {
      expect(numbers.length).toBeGreaterThan(1);
      expect(required(numbers.at(-1)) - required(numbers[0])).toBe(numbers.length - 1);
    }
    expect(required(required(ownNumbers[1])[0])).toBe(required(required(ownNumbers[0]).at(-1)) + 1);
    // Customers recur as well.
    const customers = months.map(
      (rows) => new Set(rows.map((row) => row.contra_account_number).filter(isDebtor))
    );
    expect(
      [...required(customers[1])].filter((customer) => required(customers[0]).has(customer)).length
    ).toBeGreaterThan(required(customers[1]).size * 0.5);
  });

  it("books receivables and payables through personal accounts: the invoice first, the payment later, some open at month end", () => {
    const planted = (clientId: number, month: string) =>
      Object.values(sample.expectedFindings(clientId, month)).reduce(
        (sum, count) => sum + count,
        0
      );
    for (const industry of ["crafts", "manufacturing", "medicalPractice"] as const) {
      const [clientId] = clientsOf(industry, 1, 4_000);
      const chart = chartOf(required(clientId));
      const classOf = (number: number) => required(chart.get(number)).account_class;
      const labelOf = (number: number) => required(chart.get(number)).label;
      const [september, october] = [SEPTEMBER, OCTOBER].map((month) =>
        everyPosting(required(clientId), month)
      );
      const collective = [
        "Forderungen aus Lieferungen und Leistungen",
        "Verbindlichkeiten aus Lieferungen und Leistungen"
      ];
      const invoices = new Map<string, Posting>();
      const paid = new Set<string>();
      const keyOf = (personal: number, row: Posting) => `${personal} ${row.document_field_1}`;
      let openAtMonthEnd = 0;
      for (const rows of [required(september), required(october)]) {
        const paidBefore = paid.size;
        for (const [index, row] of rows.entries()) {
          // A planted duplicate repeats the booking before it and settles nothing.
          if (JSON.stringify(row) === JSON.stringify(rows[index - 1])) continue;
          // Nothing is booked on the collective accounts themselves.
          expect(collective).not.toContain(labelOf(row.account_number));
          expect(collective).not.toContain(labelOf(row.contra_account_number));
          const invoiced =
            classOf(row.account_number) === "revenue" || classOf(row.account_number) === "expense";
          if (invoiced && row.contra_account_number > 9_999) {
            // A sale goes against a debtor, a purchase against a creditor. The one exception
            // is planted: a purchase booked on a revenue account with an input VAT key.
            if (
              isDebtor(row.contra_account_number) !==
              (classOf(row.account_number) === "revenue")
            ) {
              expect(
                ACCOUNTING_RULES["vat-key-account-mismatch"].parameters.inputVatKeys
              ).toContain(row.accounting_transaction_key);
            }
            invoices.set(keyOf(row.contra_account_number, row), row);
          }
          const receipt =
            labelOf(row.account_number) === "Bank" && isDebtor(row.contra_account_number);
          const payment =
            isCreditor(row.account_number) && labelOf(row.contra_account_number) === "Bank";
          if (!receipt && !payment) continue;
          const key = keyOf(receipt ? row.contra_account_number : row.account_number, row);
          const invoice = invoices.get(key);
          // September's first payments settle invoices of August, which this test did not read.
          if (rows === september && invoice === undefined) continue;
          expect(invoice, `${industry} ${row.posting_description}`).toBeDefined();
          expect(row.amount).toBe(required(invoice).amount);
          expect(row.date > required(invoice).date, row.posting_description).toBe(true);
          expect(row.debit_credit_indicator).toBe("S");
          expect(paid.has(key)).toBe(false);
          paid.add(key);
        }
        if (rows === september) {
          openAtMonthEnd = invoices.size - paid.size;
          expect(paid.size - paidBefore).toBeGreaterThan(0);
        }
      }
      // Some of September's invoices are open at its end, and October settles them all but
      // the planted ones, which nobody pays.
      expect(openAtMonthEnd).toBeGreaterThan(0);
      const septemberInvoices = [...invoices].filter(([, row]) => row.date.startsWith(SEPTEMBER));
      const stillOpen = septemberInvoices.filter(([key]) => !paid.has(key)).length;
      expect(stillOpen).toBeLessThanOrEqual(planted(required(clientId), SEPTEMBER));
      expect(openAtMonthEnd).toBeGreaterThan(stillOpen);
    }
  });

  it("states in the README the figures the code gives", () => {
    const readme = readFileSync(resolve(root, "clients/demo/README.md"), "utf8");
    for (const group of SIZE_GROUPS) {
      const bookings =
        group.minimum === group.maximum
          ? `exactly ${group.minimum.toLocaleString("en-US")}`
          : `${group.minimum.toLocaleString("en-US")} to ${group.maximum.toLocaleString("en-US")}`;
      expect(readme).toMatch(
        new RegExp(`\\| ${group.name} +\\| ${group.clients} +\\| ${bookings} +\\|`, "u")
      );
    }
    const withCostCentres = sample.clients.filter(({ client_id }) =>
      sample
        .postings(client_id, MONTH, 0, ACCOUNTING_MAXIMUM_PAGE_SIZE)
        .some(({ kost1 }) => kost1 !== "")
    ).length;
    expect(readme).toContain(`${withCostCentres} of the 600 clients book with cost centres`);
    const deviating = sample.clients.filter(
      ({ client_id }) =>
        required(sample.fiscalYears(client_id)[0]).fiscal_year_start % 10_000 !== 101
    ).length;
    expect(readme).toContain(`${deviating} have a fiscal year that does not start in January`);
    expect(readme).toContain(`at most ${ACCOUNTING_MAXIMUM_PAGE_SIZE.toLocaleString("en-US")}`);
  });
});
