import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolError, toolResult } from "../result.js";
import { FIRST_MONTH, LAST_MONTH } from "./calendar.js";
import { AccountingRequestError, type AccountingSample } from "./sample.js";

// The tools of `/accounting/mcp`. They mirror the reading endpoints of the Exampledata
// Enterprise API: the same row fields, and its paging by `page` and `page_size` with no total
// and no next marker, so a caller reads on until a page is short or empty.

export const ACCOUNTING_DEFAULT_PAGE_SIZE = 100;
/**
 * The most rows one page holds. It keeps the largest page of bookings, measured at 1.31 MiB,
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
  record_type: z.string(),
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
  account_class: z.enum(["asset", "liability", "revenue", "expense"]),
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
const clientId = z.number().int();
const PAGING_ADVICE = `Rows come in pages: page starts at 1, page_size is at most ${ACCOUNTING_MAXIMUM_PAGE_SIZE} and ${ACCOUNTING_DEFAULT_PAGE_SIZE} when left out. There is no total: ask for page 1, 2, 3 and so on with the same page_size, and stop at the first page with fewer rows than page_size.`;

/** The rows as a result, or the sentence of a request for a client or month that does not exist. */
function answer(rows: () => unknown[]) {
  try {
    return toolResult({ rows: rows() });
  } catch (error) {
    if (error instanceof AccountingRequestError) return toolError(error.message);
    throw error;
  }
}

export function registerAccountingTools(server: McpServer, sample: AccountingSample): void {
  server.registerTool(
    "list_accounting_clients",
    {
      title: "List accounting clients",
      description: `List the clients (Mandanten) whose books can be read, ordered by client_id. Use it first: every other tool needs a client_id from here. ${PAGING_ADVICE}`,
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject(paging),
      outputSchema: accountingOutputSchemas.list_accounting_clients
    },
    ({ page, page_size }) =>
      answer(() => sample.clients.slice((page - 1) * page_size, page * page_size))
  );

  server.registerTool(
    "list_fiscal_years",
    {
      title: "List fiscal years",
      description:
        "List the fiscal years (Wirtschaftsjahre) of one client, oldest first, with what its books are kept by: the chart of accounts (skr 3 or 4), the account length, the consultant number and the client number. Use it to learn which chart a client books on and whether its fiscal year is the calendar year. All rows come at once.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ client_id: clientId }),
      outputSchema: accountingOutputSchemas.list_fiscal_years
    },
    ({ client_id }) => answer(() => sample.fiscalYears(client_id))
  );

  server.registerTool(
    "list_postings",
    {
      title: "List postings",
      description: `List the bookings of one client in one month (YYYY-MM, from ${FIRST_MONTH} to ${LAST_MONTH}), ordered by date and stable between calls. A month holds between a few hundred and 100,000 bookings, so read it page by page with the largest page_size. ${PAGING_ADVICE} Amounts are euros with two decimals; net_amount plus tax_amount is amount. A booking has no id: its place in the month identifies it.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        client_id: clientId,
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
        ...paging
      }),
      outputSchema: accountingOutputSchemas.list_postings
    },
    ({ client_id, month, page, page_size }) =>
      answer(() => sample.postings(client_id, month, (page - 1) * page_size, page_size))
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List the chart of accounts of one client, ordered by account_number: each account's German label, its class (asset, liability, revenue or expense), the BU-Schlüssel an automatic account applies by itself, and whether the account is blocked for bookings. Use it to judge the account_number and contra_account_number of a booking. All rows come at once.",
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ client_id: clientId }),
      outputSchema: accountingOutputSchemas.list_accounts
    },
    ({ client_id }) => answer(() => sample.accounts(client_id))
  );
}
