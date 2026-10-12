import { chartOfAccounts, type Account } from "./accounts.js";
import { FIRST_MONTH, LAST_MONTH, sampleMonth } from "./calendar.js";
import { createClients, fiscalYears, type ClientRow, type FiscalYearRow } from "./clients.js";
import { monthOfPostings, type Posting } from "./postings.js";
import type { AccountingRuleId } from "./rules.js";

/** The seed of the data the sample server serves. Changing it changes every row. */
const ACCOUNTING_SEED = 0x4b1d7e63;

/** A request names a client or a month the sample does not have. The message is one plain sentence. */
export class AccountingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingRequestError";
  }
}

/** What the sample answers. A client or a month it does not have throws `AccountingRequestError`. */
export interface AccountingSample {
  /** Every client, by `client_id`. */
  clients: ClientRow[];
  fiscalYears(client_id: number): FiscalYearRow[];
  accounts(client_id: number): Account[];
  postingCount(client_id: number, month: string): number;
  /** The month's bookings from `offset` on, at most `limit`, by date and then as generated. */
  postings(client_id: number, month: string, offset: number, limit: number): Posting[];
  /** How many bookings of the month break each rule of rules.ts. */
  expectedFindings(client_id: number, month: string): Record<AccountingRuleId, number>;
}

/**
 * The accounting sample: the books of 600 invented clients of one tax consultancy, as the
 * Exampledata interface over DATEV data serves them. Everything follows from the seed.
 */
export function createAccountingSample({
  seed = ACCOUNTING_SEED
}: { seed?: number } = {}): AccountingSample {
  const clients = createClients(seed);
  const clientsById = new Map(clients.map((client) => [client.row.client_id, client]));

  function clientOf(client_id: number) {
    const client = clientsById.get(client_id);
    if (!client) {
      throw new AccountingRequestError(`No accounting client has the client_id ${client_id}.`);
    }
    return client;
  }

  function monthOf(client_id: number, month: string) {
    const client = clientOf(client_id);
    const found = sampleMonth(month);
    if (!found) {
      throw new AccountingRequestError(
        `The sample has bookings for the months ${FIRST_MONTH} to ${LAST_MONTH} only.`
      );
    }
    return monthOfPostings(seed, client, found);
  }

  return {
    clients: clients.map((client) => client.row),
    fiscalYears: (client_id) => fiscalYears(clientOf(client_id)),
    accounts: (client_id) => chartOfAccounts(clientOf(client_id).skr),
    postingCount: (client_id, month) => monthOf(client_id, month).count,
    postings: (client_id, month, offset, limit) => monthOf(client_id, month).rows(offset, limit),
    expectedFindings: (client_id, month) => monthOf(client_id, month).expectedFindings()
  };
}
