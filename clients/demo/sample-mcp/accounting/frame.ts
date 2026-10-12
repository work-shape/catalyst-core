import { mixedSeed, pick, seededGenerator, shuffled } from "../random.js";
import { LEDGERS, type Ledger } from "./accounts.js";
import { monthAt, type SampleMonth } from "./calendar.js";
import { postingCount, STREAM, type SampleClient } from "./clients.js";
import { documentLink, type Issued } from "./documents.js";

// A client's month as its bookings are drawn from it: how many documents of each kind the
// month has, and the draws, amounts and links of one booking. Every booking is a pure
// function of the seed, the client, the month, the kind of booking and its rank in the kind.

export type Random = () => number;

/** What tells the draws and the document links of the kinds of bookings apart. */
export const ACTIVITY = {
  salesInvoices: 1,
  tillReports: 2,
  purchasesOnAccount: 3,
  directPurchases: 4,
  payroll: 5,
  customerPayments: 6,
  supplierPayments: 7,
  deposits: 8
} as const;

/**
 * The bookings of a month that are planted and not part of the client's business, each as
 * the point of the month, from 0 to 1, at which it is dated and its document is numbered.
 */
export interface PlantedPoints {
  /** In the order the bookings are planted. */
  bookings: readonly number[];
  /** Those of them that are sales invoices, which take numbers of the client's own range. */
  salesInvoices: readonly number[];
}

/** A client's month as far as the bookings of another month need it. */
export interface Frame {
  seed: number;
  client: SampleClient;
  ledger: Ledger;
  period: SampleMonth;
  /** The month's revenue as a multiple of the usual month's, by the season of the industry. */
  level: number;
  /** How many documents of each kind the client's business has in the month. */
  issued: {
    salesInvoices: number;
    tillReports: number;
    /** A till report is one booking for each tax rate of the till. */
    tillBookings: number;
    supplierInvoices: number;
  };
  planted: PlantedPoints;
}

export function frameOf(
  seed: number,
  client: SampleClient,
  monthIndex: number,
  plantedIn: (monthIndex: number) => PlantedPoints
): Frame {
  const { business, usualPostingCount } = client;
  const { till } = business.profile;
  const planted = plantedIn(monthIndex);
  const volume =
    (postingCount(seed, client, monthIndex) - planted.bookings.length) / usualPostingCount;
  const period = monthAt(monthIndex);
  const tillLines = till === null ? 0 : till.lines(period.year).length;
  const tillReports =
    till === null ? 0 : Math.max(1, Math.round((business.usual.tillBookings * volume) / tillLines));
  return {
    seed,
    client,
    ledger: LEDGERS[client.skr],
    period,
    level: pick(business.profile.season, period.month - 1),
    issued: {
      salesInvoices: Math.max(2, Math.round(business.usual.salesInvoices * volume)),
      tillReports,
      tillBookings: tillReports * tillLines,
      supplierInvoices: Math.max(2, Math.round(business.usual.supplierInvoices * volume))
    },
    planted
  };
}

/** The draws of the booking at `rank` of a kind, or of whatever else `rank` numbers in it. */
export function drawsOf(
  frame: Frame,
  activity: number,
  rank: number,
  monthIndex = frame.period.index
): Random {
  return seededGenerator(
    mixedSeed(frame.seed, STREAM.booking, frame.client.row.client_id, monthIndex, activity, rank)
  );
}

/** The two even draws of a booking: for its account, and for its amount. */
export const LINE = 0;
export const AMOUNT = 1;

/**
 * A draw in [0, 1) for the booking at `rank` of an activity's `count` bookings. Together the
 * draws of a month cover the range evenly, each booking in a share of its own, so the split
 * over accounts and the month's total come out as the profile says however few bookings
 * there are. `what` tells the draws of one booking apart.
 */
export function evenDraw(
  frame: Frame,
  activity: number,
  what: number,
  rank: number,
  count: number,
  random: Random
): number {
  // A planted booking has a rank behind the month's own and draws freely.
  if (rank >= count) return random();
  const { seed, client, period } = frame;
  const share = shuffled(
    rank,
    count,
    mixedSeed(seed, STREAM.evenDraw, client.row.client_id, period.index, activity, what)
  );
  return (share + random()) / count;
}

export function linkOf(frame: Frame, activity: number, rank: number): string {
  return documentLink(
    frame.seed,
    STREAM.documentLink,
    frame.client.row.client_id,
    frame.period.index,
    activity,
    rank
  );
}

/**
 * What a draw in [0, 1) makes of a usual amount, as a multiple of it: the largest is `spread`
 * times the smallest, and over even draws the mean is the usual amount.
 */
export function spreadAround(draw: number, spread: number): number {
  return (Math.log(spread) / (spread - 1)) * Math.pow(spread, draw);
}

/** A net amount around the usual one, as gross cents at the tax rate. */
export function grossCents(usualEuros: number, rate: number, draw: number, spread: number) {
  return Math.max(1, Math.round(usualEuros * spreadAround(draw, spread) * (100 + rate)));
}

/** What most bookings say alike. */
export const plain = {
  generalReversal: false,
  costCentre: "",
  documentLink: "",
  origin: "RE"
} as const;

/** What `countOf` counts in the months of the frame's year before its own, and since the sample's first month. */
export function issuedBefore(
  frame: Frame,
  plantedIn: (monthIndex: number) => PlantedPoints,
  countOf: (month: Frame) => number
): Issued {
  const { index, month } = frame.period;
  const between = (from: number, to: number) => {
    let sum = 0;
    for (let other = from; other < to; other += 1) {
      sum += countOf(frameOf(frame.seed, frame.client, other, plantedIn));
    }
    return sum;
  };
  return {
    thisYear: between(index - (month - 1), index),
    ever: index >= 0 ? between(0, index) : -between(index, 0)
  };
}
