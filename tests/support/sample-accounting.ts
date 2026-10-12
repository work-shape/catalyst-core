import type { z } from "zod";
import {
  createAccountingSample,
  SIZE_GROUPS,
  type accountingOutputSchemas
} from "@vivd-catalyst/demo/sample-mcp";
import { required } from "./assertions";

// What the tests of the demo's accounting sample share: the data of the server's own seed, as
// the generator gives it without a server, and how to read it.

export type Posting = z.output<typeof accountingOutputSchemas.list_postings>["rows"][number];
export type Account = z.output<typeof accountingOutputSchemas.list_accounts>["rows"][number];

export const sample = createAccountingSample();
export const MONTHS = ["2024-02", "2026-10"] as const;
export const [MONTH] = MONTHS;

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

export function everyPosting(clientId: number, month: string): Posting[] {
  return sample.postings(clientId, month, 0, sample.postingCount(clientId, month));
}

export const cents = (euros: number) => Math.round(euros * 100);

export const isDebtor = (account: number) => account >= 10_000 && account <= 69_999;
export const isCreditor = (account: number) => account >= 70_000 && account <= 99_999;

export function chartOf(clientId: number): Map<number, Account> {
  return new Map(sample.accounts(clientId).map((account) => [account.account_number, account]));
}
