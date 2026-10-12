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
  /** The day of the month (from 0) the booking at `rank` is dated on. It never falls as `rank` rises. */
  day(rank: number): number;
  booking(rank: number): Booking;
}

/**
 * The days of `count` bookings spread evenly over the month, where `dayAt` gives the day of a
 * point of the month from 0 to 1 (see calendar.ts).
 */
export function evenDays(count: number, dayAt: (point: number) => number): Activity["day"] {
  return (rank) => dayAt((rank + 0.5) / count);
}
