import { chartOfAccounts, type Account } from "./accounts.js";
import { expectedFindings } from "./anomalies.js";
import { monthAt, monthsUntil } from "./calendar.js";
import {
  createClients,
  fiscalYears,
  postingCount,
  type ClientRow,
  type FiscalYearRow
} from "./clients.js";
import { personalAccounts } from "./counterparties.js";
import { monthOfPostings, type Posting } from "./postings.js";
import type { Industry } from "./profiles.js";
import type { AccountingRuleId } from "./rules.js";

/** The seed of the data the sample server serves. Changing it changes every row. */
const ACCOUNTING_SEED = 0x4b1d7e63;
/**
 * The last month the sample serves when it is given none: the month it was last brought up to.
 * It is served whole, to its last day, because the sample knows a month and no day of today.
 */
const LAST_MONTH = "2026-10";
/** The months at the end of the range that are still open. The ones before are locked (festgeschrieben). */
const OPEN_MONTHS = 3;

/**
 * What the sample answers. The tools refuse a client or a month it does not have before they
 * ask (see tools.ts); asked for one all the same, it throws.
 */
export interface AccountingSample {
  /** The months that have bookings, as a request names them (`YYYY-MM`), oldest first. */
  months: readonly string[];
  /** Every client, by `client_id`. The ids are consecutive. */
  clients: ClientRow[];
  fiscalYears(client_id: number): FiscalYearRow[];
  accounts(client_id: number): Account[];
  postingCount(client_id: number, month: string): number;
  /** The month's bookings from `offset` on, at most `limit`, by date and then as generated. */
  postings(client_id: number, month: string, offset: number, limit: number): Posting[];
  /** How many bookings of the month break each rule of rules.ts. */
  expectedFindings(client_id: number, month: string): Record<AccountingRuleId, number>;
  /** What kind of business the client is, which no row says: the key to judging its books. */
  businessOf(client_id: number): { industry: Industry; legalForm: string };
}

/**
 * The accounting sample: the books of 600 invented clients of one tax consultancy, as the
 * Exampledata interface over DATEV data serves them. Everything follows from the seed, and the
 * books end with `lastMonth` (`YYYY-MM`): no later month has bookings.
 */
export function createAccountingSample({
  seed = ACCOUNTING_SEED,
  lastMonth = LAST_MONTH
}: { seed?: number; lastMonth?: string } = {}): AccountingSample {
  const months = monthsUntil(lastMonth);
  const clients = createClients(seed);
  const clientsById = new Map(clients.map((client) => [client.row.client_id, client]));

  function clientOf(client_id: number) {
    const client = clientsById.get(client_id);
    if (!client) throw new Error(`No accounting client has the client_id ${client_id}.`);
    return client;
  }

  function monthOf(month: string) {
    const index = months.indexOf(month);
    if (index === -1) {
      throw new Error(`The sample has bookings for the months ${months[0]} to ${lastMonth} only.`);
    }
    return monthAt(index);
  }

  return {
    months,
    clients: clients.map((client) => client.row),
    fiscalYears: (client_id) => fiscalYears(clientOf(client_id), monthAt(months.length - 1)),
    accounts(client_id) {
      const client = clientOf(client_id);
      return chartOfAccounts(client.skr, personalAccounts(client));
    },
    postingCount: (client_id, month) =>
      postingCount(seed, clientOf(client_id), monthOf(month).index),
    postings(client_id, month, offset, limit) {
      const period = monthOf(month);
      const locked = period.index < months.length - OPEN_MONTHS;
      return monthOfPostings(seed, clientOf(client_id), period, locked).rows(offset, limit);
    },
    expectedFindings: (client_id, month) =>
      expectedFindings(seed, clientOf(client_id), monthOf(month).index),
    businessOf(client_id) {
      const { industry, legalForm } = clientOf(client_id);
      return { industry, legalForm };
    }
  };
}
