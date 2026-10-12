import type { Account } from "./accounts.js";

/** What one booking says, before it is written as a row. */
export interface Booking {
  account: Account;
  contra: Account;
  side: "S" | "H";
  vatKey: number;
  cents: number;
  text: string;
  /** Empty for a booking without a document number. */
  document: string;
  /** The link to the document behind the booking, or empty where no document is kept. */
  documentLink: string;
  /** Where the booking comes from: `RE` for the accounting itself, `LO` for the payroll. */
  origin: "RE" | "LO";
  generalReversal: boolean;
  costCentre: string;
}

/**
 * One kind of bookings of a client's month, such as its sales invoices or its payroll run.
 * A booking is named by its rank among them, and nothing of it is kept.
 */
export interface Activity {
  count: number;
  /**
   * Where in the month the booking at `rank` is dated, from 0 (the start of the first day) to
   * 1 (the end of the last). It never falls as `rank` rises.
   */
  place(rank: number): number;
  booking(rank: number): Booking;
}

/** Bookings spread evenly over the month. */
export function evenPlace(count: number): Activity["place"] {
  return (rank) => (rank + 0.5) / count;
}
