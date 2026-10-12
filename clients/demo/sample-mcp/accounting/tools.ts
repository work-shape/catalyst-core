import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolResult } from "../result.js";
import { FIRST_MONTH, LAST_MONTH, SAMPLE_MONTHS } from "./calendar.js";
import type { AccountingSample } from "./sample.js";

// The tools of `/accounting/mcp`. They mirror the reading endpoints of the Exampledata
// Enterprise API: the same row fields, and its paging by `page` and `page_size` with no total
// and no next marker, so a caller reads on until a page is short or empty.

export const ACCOUNTING_DEFAULT_PAGE_SIZE = 100;
/**
 * The most rows one page holds. It keeps the largest page of bookings, measured at 1.40 MiB,
 * under three quarters of what one call of a Connection may answer (2 MiB, with the rows
 * counted twice: structured and as text). A larger `page_size` is refused as invalid input.
 */
export const ACCOUNTING_MAXIMUM_PAGE_SIZE = 1_000;

const compactDateSchema = z.number().int().min(10_000_101).max(99_991_231);
const flagSchema = z.union([z.literal(0), z.literal(1)]);
const euroSchema = z.number().nonnegative();
const clientSchema = z.strictObject({
  client_id: z.number().int(),
  master_client_id: z.string(),
  client_number: z.number().int(),
  company_id: z.string(),
  name: z.string(),
  created_at: z.iso.datetime()
});
const fiscalYearSchema = z.strictObject({
  client_id: z.number().int(),
  fiscal_year: compactDateSchema,
  year: z.number().int(),
  fiscal_year_start: compactDateSchema,
  fiscal_year_end: compactDateSchema,
  name: z.string(),
  company_name: z.string(),
  client_name: z.string(),
  national_law: z.string(),
  base_currency: z.string(),
  skr: z.union([z.literal(3), z.literal(4)]),
  account_length: z.number().int(),
  size_class_code: z.number().int().min(2).max(5),
  consultant_number: z.number().int(),
  client_number: z.number().int(),
  inactive: flagSchema
});
const postingSchema = z.strictObject({
  client_id: z.number().int(),
  date: z.iso.date(),
  delivery_date: z.iso.date().nullable(),
  document_date: z.iso.date(),
  fiscal_year: z.string().regex(/^\d{8}$/u),
  account_number: z.number().int(),
  contra_account_number: z.number().int(),
  posting_description: z.string(),
  tax_rate: z.number().nonnegative(),
  net_amount: euroSchema,
  tax_amount: euroSchema,
  contra_account_tax_rate: z.number().nonnegative(),
  document_field_1: z.string(),
  document_field_2: z.string(),
  amount: euroSchema,
  debit_credit_indicator: z.enum(["S", "H"]),
  currency_code: z.string(),
  exchange_rate: z.number().positive(),
  record_type: z.enum(["RE", "LO"]),
  accounting_transaction_key: z.number().int().nonnegative(),
  general_reversal: flagSchema,
  follow_up_index: z.number().int().nonnegative(),
  follow_up_type: z.string(),
  gross_net_indicator: z.enum(["B", "N"]),
  document_link: z.string(),
  kost1: z.string(),
  kost2: z.string(),
  capitalisation_number: z.number().int().nonnegative()
});
const accountSchema = z.strictObject({
  account_number: z.number().int(),
  label: z.string(),
  account_class: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  automatic_vat_key: z.number().int().nullable(),
  blocked: z.boolean()
});
export const accountingOutputSchemas = {
  list_accounting_clients: z.strictObject({ rows: z.array(clientSchema) }),
  list_fiscal_years: z.strictObject({ rows: z.array(fiscalYearSchema) }),
  list_postings: z.strictObject({ rows: z.array(postingSchema) }),
  list_accounts: z.strictObject({ rows: z.array(accountSchema) })
};

const paging = {
  page: z.number().int().min(1).default(1),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(ACCOUNTING_MAXIMUM_PAGE_SIZE)
    .default(ACCOUNTING_DEFAULT_PAGE_SIZE)
};
const PAGING_ADVICE = `Rows come in pages: page starts at 1, page_size is at most ${ACCOUNTING_MAXIMUM_PAGE_SIZE} and ${ACCOUNTING_DEFAULT_PAGE_SIZE} when left out. There is no total: ask for page 1, 2, 3 and so on with the same page_size, and stop at the first page with fewer rows than page_size.`;

/**
 * The input of the tools that name a client or a month. The sample's clients have consecutive
 * ids and its months are a fixed range, so the schema itself holds both ranges: a caller that
 * validates against the advertised schema, as a Connection does, refuses any other client or
 * month as invalid input before it calls, and the server refuses it the same way with a
 * sentence that names the range.
 */
function selectors(sample: AccountingSample) {
  const ids = sample.clients.map(({ client_id }) => client_id);
  const [first, last] = [Math.min(...ids), Math.max(...ids)];
  const outside = `client_id must be a whole number from ${first} to ${last}, the clients of the sample.`;
  return {
    client_id: z.number().int().min(first, outside).max(last, outside),
    month: z.enum(
      SAMPLE_MONTHS,
      `month must be a month from ${FIRST_MONTH} to ${LAST_MONTH} as YYYY-MM.`
    )
  };
}

export function registerAccountingTools(server: McpServer, sample: AccountingSample): void {
  const { client_id, month } = selectors(sample);
  const answer = (rows: unknown[]) => toolResult({ rows });
  server.registerTool(
    "list_accounting_clients",
    {
      title: "List accounting clients",
      description: `List the clients (Mandanten) whose books can be read, ordered by client_id. Use it first: every other tool needs a client_id from here. ${PAGING_ADVICE}`,
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject(paging),
      outputSchema: accountingOutputSchemas.list_accounting_clients
    },
    ({ page, page_size }) => answer(sample.clients.slice((page - 1) * page_size, page * page_size))
  );

  server.registerTool(
    "list_fiscal_years",
    {
      title: "List fiscal years",
      description:
        "List the fiscal years (Wirtschaftsjahre) of one client, oldest first, with what its books are kept by: the chart of accounts (skr 3 or 4), the account length, the consultant number and the client number. Use it to learn which chart a client books on and whether its fiscal year is the calendar year. All rows come at once.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ client_id }),
      outputSchema: accountingOutputSchemas.list_fiscal_years
    },
    (input) => answer(sample.fiscalYears(input.client_id))
  );

  server.registerTool(
    "list_postings",
    {
      title: "List postings",
      description: `List the bookings of one client in one month (YYYY-MM, from ${FIRST_MONTH} to ${LAST_MONTH}), ordered by date and stable between calls. A month holds between fifty and 100,000 bookings, so read it page by page with the largest page_size. ${PAGING_ADVICE} Amounts are euros with two decimals; net_amount plus tax_amount is amount. A booking has no id and no field that is unique: document_link names the document behind it, which several bookings may share.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ client_id, month, ...paging }),
      outputSchema: accountingOutputSchemas.list_postings
    },
    (input) =>
      answer(
        sample.postings(
          input.client_id,
          input.month,
          (input.page - 1) * input.page_size,
          input.page_size
        )
      )
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List the chart of accounts of one client, ordered by account_number: the four-digit general ledger accounts, then the client's personal accounts, a debtor for each customer (10000 to 69999) and a creditor for each supplier (70000 to 99999). Each account has its German label, which for a personal account is the name of the customer or supplier, its class (asset, liability, equity, revenue or expense), the BU-Schlüssel an automatic account applies by itself, and whether the account is blocked for bookings. Use it to judge the account_number and contra_account_number of a booking. All rows come at once, a few thousand for the largest client.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ client_id }),
      outputSchema: accountingOutputSchemas.list_accounts
    },
    (input) => answer(sample.accounts(input.client_id))
  );
}
