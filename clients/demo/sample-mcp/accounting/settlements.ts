import { mixedSeed, pick, shuffled } from "../random.js";
import { discountAccount, type Account } from "./accounts.js";
import { evenDays, type Activity, type Booking } from "./booking.js";
import { PAYMENTS_PER_SPLIT, settlementBookings } from "./business.js";
import { STREAM } from "./clients.js";
import { drawsOf, plain, type Frame } from "./frame.js";

// How invoices are paid. The payment follows the invoice about two weeks later: the invoices
// of the first part of a month are paid in that month, the others in the next. So some are
// open at each month's end, and a payment names an invoice that exists, with its number, its
// counterparty and its amount.
//
// Most invoices are paid at once and in full. Of every few payments one is split in two
// bookings: the payment less a cash discount (Skonto) with the discount beside it on the same
// day, or a part payment with the rest a few payments later. And nobody pays in the strict
// order of the invoices, so a payment stands a few places before or behind its invoice's turn.

/** The share of invoices, the earliest of a month, that are paid in the same month. */
const SETTLED_IN_MONTH = 0.55;
/** The share of split payments that take a cash discount. The others are paid in two parts. */
const DISCOUNT_SHARE = 0.65;
/** The cash discounts in use, as shares of the invoice. */
const DISCOUNT_RATES = [0.02, 0.03];
/** The least and the most of an invoice that its first part pays. */
const FIRST_PART = { least: 0.3, most: 0.7 } as const;
/** How many payments in a row may swap their turns. */
const ORDER_WINDOW = 6;

/** What a payment needs to know of the invoice it pays. */
export interface Invoice {
  /** The personal account of the customer or supplier. */
  personal: Account;
  cents: number;
  /** The tax rate of the invoice, in percent. */
  taxRate: number;
  text: string;
  document: string;
}

/** Whose invoices are paid, and how. */
interface Side {
  from: "customers" | "suppliers";
  /** What tells the draws of the side's payments apart (see `ACTIVITY`). */
  activity: number;
  /** The word a payment in full starts with. */
  word: string;
  /** Whether a payer may take a cash discount. A tenant may not. */
  discounts: boolean;
  invoice(frame: Frame, rank: number): Invoice;
}

/** A month's invoices of a side. */
interface Invoiced {
  frame: Frame;
  count: number;
}

/** A side's payments of a month, and what a payment made once more is made of. */
export interface Settlements extends Activity {
  /** How many invoices the month before left open. The month pays them first. */
  carried: number;
  /** The payment in full of the invoice at `place` among them, as the month books it. */
  inFull(place: number): Booking;
}

/** What one booking pays of an invoice. */
type Part = "all" | "lessDiscount" | "discount" | "firstPart" | "rest";

/**
 * What the booking of a `part` pays of an invoice of `cents`, and the word its text starts
 * with where that is not the side's word for a payment. `draw`, in [0, 1), decides how large
 * a discount or a first part is.
 */
function paidOf(cents: number, part: Part, draw: number): { cents: number; word?: string } {
  const discount = Math.round(
    cents * pick(DISCOUNT_RATES, Math.floor(draw * DISCOUNT_RATES.length))
  );
  // A part payment is a sum in whole euros. An invoice is far above the two euros it needs.
  const firstPart =
    Math.round((cents * (FIRST_PART.least + (FIRST_PART.most - FIRST_PART.least) * draw)) / 100) *
    100;
  switch (part) {
    case "all":
      return { cents };
    case "lessDiscount":
      return { cents: cents - discount };
    case "discount":
      return { cents: discount, word: "Skonto" };
    case "firstPart":
      return { cents: firstPart, word: "Teilzahlung" };
    case "rest":
      return { cents: cents - firstPart, word: "Restzahlung" };
  }
}

/** How many of `count` invoices of a month are paid in that month. */
function settledInMonth(count: number): number {
  return Math.floor(SETTLED_IN_MONTH * count);
}

/**
 * The bookings of a month that pay the side's invoices: first the invoices the month before
 * left open, then the first ones of the month itself, each `PAYMENTS_PER_SPLIT` payments
 * with one that is split in two bookings. `dayAt` gives the day of a point of the month.
 */
export function settlements(
  side: Side,
  previous: Invoiced,
  current: Invoiced,
  dayAt: (point: number) => number
): Settlements {
  const { frame } = current;
  const paidBefore = settledInMonth(previous.count);
  const carried = previous.count - paidBefore;
  const payments = carried + settledInMonth(current.count);
  const count = settlementBookings(payments);
  const splits = Math.floor(payments / PAYMENTS_PER_SPLIT);
  const rowsPerSplit = settlementBookings(PAYMENTS_PER_SPLIT);
  // An invoice of the month itself is paid at least `carried` payments after the month began,
  // which is about two weeks. Half of that is the most a payment may come early, so it still
  // lies days after its invoice.
  const window = Math.min(ORDER_WINDOW, Math.floor(carried / 2));

  /** The invoice at `place` among those the month pays: the ones left open first. */
  function invoiceOf(place: number): Invoice {
    return place < carried
      ? side.invoice(previous.frame, paidBefore + place)
      : side.invoice(frame, place - carried);
  }

  /** The invoice the payment at `turn` pays: the one whose turn it is, or one of its neighbours. */
  function invoiceAt(turn: number): Invoice {
    return invoiceOf(window < 2 ? turn : swapped(turn));
  }

  /** The place `turn` takes when the turns of each `window` payments in a row are shuffled. */
  function swapped(turn: number): number {
    const start = turn - (turn % window);
    return (
      start +
      shuffled(
        turn - start,
        Math.min(window, payments - start),
        mixedSeed(
          frame.seed,
          STREAM.paymentOrder,
          frame.client.row.client_id,
          frame.period.index,
          side.activity,
          start
        )
      )
    );
  }

  /** How the split payment at `turn` is split: whether it takes a discount, and the draw for its amounts. */
  function splitAt(turn: number) {
    const random = drawsOf(frame, side.activity, turn);
    return { discounted: side.discounts && random() < DISCOUNT_SHARE, draw: random() };
  }

  /**
   * The payment's turn and the part of its invoice that the booking at `rank` pays. The first
   * payment of every `PAYMENTS_PER_SPLIT` is the split one: its discount follows it at once,
   * the rest of a part payment stands behind the other payments of the group.
   */
  function at(rank: number): { turn: number; part: Part } {
    const split = Math.floor(rank / rowsPerSplit);
    // Behind the last whole group every payment is one booking.
    if (split >= splits) return { turn: rank - splits, part: "all" };
    const first = split * PAYMENTS_PER_SPLIT;
    const place = rank % rowsPerSplit;
    if (splitAt(first).discounted) {
      if (place === 0) return { turn: first, part: "lessDiscount" };
      return place === 1
        ? { turn: first, part: "discount" }
        : { turn: first + place - 1, part: "all" };
    }
    if (place === 0) return { turn: first, part: "firstPart" };
    return place === PAYMENTS_PER_SPLIT
      ? { turn: first, part: "rest" }
      : { turn: first + place, part: "all" };
  }

  /** The booking that pays a `part` of an invoice. `draw` decides how large a discount or a first part is. */
  function payment(invoice: Invoice, part: Part, draw: number): Booking {
    const paid = paidOf(invoice.cents, part, draw);
    // A discount takes the bank's place in the booking of its payment. Its account corrects
    // the tax of the invoice by itself.
    const money =
      part === "discount"
        ? discountAccount(
            frame.ledger,
            side.from === "customers" ? "granted" : "received",
            invoice.taxRate
          )
        : frame.ledger.bank;
    return {
      ...plain,
      ...(side.from === "customers"
        ? { account: money, contra: invoice.personal }
        : { account: invoice.personal, contra: money }),
      side: "S",
      vatKey: 0,
      cents: paid.cents,
      text: `${paid.word ?? side.word} ${invoice.text}`,
      document: invoice.document
    };
  }

  const evenDay = evenDays(count, dayAt);
  return {
    count,
    // A discount is booked on the day of its payment, the booking before it.
    day: (rank) => evenDay(at(rank).part === "discount" ? rank - 1 : rank),
    booking(rank) {
      const { turn, part } = at(rank);
      return payment(invoiceAt(turn), part, splitAt(turn).draw);
    },
    carried,
    inFull: (place) => payment(invoiceOf(place), "all", 0)
  };
}
