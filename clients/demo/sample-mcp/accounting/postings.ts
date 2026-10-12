import { mixedSeed, seededGenerator } from "../random.js";
import { LEDGERS, vatRate } from "./accounts.js";
import { activitiesOf } from "./activities.js";
import { plan, plantedBooking, plantedCount } from "./anomalies.js";
import type { Booking } from "./booking.js";
import { dayEnds, isoDate, type SampleMonth } from "./calendar.js";
import { fiscalYearOf, postingCount, STREAM, type SampleClient } from "./clients.js";
import { schedule } from "./schedule.js";

// One client's bookings of one month. Nothing is stored: a booking is a pure function of the
// seed, the client, the month and the booking's position in the month, so a page costs time in
// proportion to the page and not to the month.
//
// A month is the clean bookings of the client's business (activities.ts), in the order of
// their dates (schedule.ts), with the planted bookings standing between them (anomalies.ts).
// A planted booking breaks exactly one rule of rules.ts, and no clean booking breaks any,
// which holds by construction:
//
// - Two clean bookings are never alike. A sales invoice, a till report and a deposit have a
//   number of the client's own range, a purchase has a number its supplier gives once and a
//   text with the supplier's name, a payment carries the number of the one invoice it settles,
//   a payslip line names the employee and the line, and a standing order has its own text.
// - The only booking without a document number is the bank's monthly charge, far below the
//   amount from which a round booking is a finding.
// - An expense is booked in debit, with no key or an input VAT key, on an open account, with a
//   cost centre when the client uses them. An expense in credit is a general reversal.
// - A booking's date follows from its position, so the month is in date order as it is
//   generated, and every clean booking is dated inside the month.

export interface Posting {
  client_id: number;
  date: string;
  delivery_date: string | null;
  document_date: string;
  fiscal_year: string;
  account_number: number;
  contra_account_number: number;
  posting_description: string;
  tax_rate: number;
  net_amount: number;
  tax_amount: number;
  contra_account_tax_rate: number;
  document_field_1: string;
  document_field_2: string;
  amount: number;
  debit_credit_indicator: "S" | "H";
  currency_code: string;
  exchange_rate: number;
  record_type: Booking["origin"];
  accounting_transaction_key: number;
  general_reversal: 0 | 1;
  follow_up_index: number;
  follow_up_type: string;
  gross_net_indicator: "B" | "N";
  document_link: string;
  kost1: string;
  kost2: string;
  capitalisation_number: number;
}

/** What every booking of a client's month says alike. `locked` is whether the month is closed for changes. */
interface Month {
  client: SampleClient;
  period: SampleMonth;
  locked: boolean;
}

function row({ client, period, locked }: Month, date: string, booking: Booking): Posting {
  const automaticKey = booking.account.automatic_vat_key;
  const rate = vatRate(automaticKey ?? booking.vatKey);
  const taxCents = Math.round((booking.cents * rate) / (100 + rate));
  return {
    client_id: client.row.client_id,
    date,
    delivery_date: booking.account.account_class === "revenue" ? date : null,
    document_date: date,
    fiscal_year: fiscalYearOf(client, period),
    account_number: booking.account.account_number,
    contra_account_number: booking.contra.account_number,
    posting_description: booking.text,
    tax_rate: rate,
    net_amount: (booking.cents - taxCents) / 100,
    tax_amount: taxCents / 100,
    contra_account_tax_rate: 0,
    document_field_1: booking.document,
    document_field_2: "",
    amount: booking.cents / 100,
    debit_credit_indicator: booking.side,
    currency_code: "EUR",
    exchange_rate: 1,
    record_type: booking.origin,
    accounting_transaction_key: automaticKey === null ? booking.vatKey : 0,
    general_reversal: booking.generalReversal ? 1 : 0,
    // The sample holds no follow-up booking that the accounting system generates: every row
    // is an original.
    follow_up_index: 0,
    follow_up_type: "",
    gross_net_indicator: "B",
    document_link: booking.documentLink,
    kost1: booking.costCentre,
    kost2: "",
    capitalisation_number: locked ? period.index + 1 : 0
  };
}

/** Any run of the rows of one client's month. */
export function monthOfPostings(
  seed: number,
  client: SampleClient,
  period: SampleMonth,
  locked: boolean
) {
  const month = { client, period, locked };
  const clientId = client.row.client_id;
  const count = postingCount(seed, client, period.index);
  const { planted, plantedBefore } = plan(seed, client, period);
  const cleanCount = count - planted.size;
  const business = activitiesOf(seed, client, period, (monthIndex) =>
    plantedCount(seed, client, monthIndex)
  );
  const order = schedule(
    business.activities,
    dayEnds(period),
    mixedSeed(seed, STREAM.schedule, clientId, period.index)
  );
  const { activities } = business;

  function posting(position: number): Posting {
    const plantedHere = planted.get(position);
    // A duplicate is the booking before it, word for word. The plan keeps that one clean.
    if (plantedHere?.rule === "duplicate-posting") return posting(position - 1);
    const cleanBefore = position - plantedBefore(position);
    if (plantedHere === undefined) {
      const { day, activity, rank } = order.at(cleanBefore);
      const booking = activities[activity]?.booking(rank);
      if (booking === undefined) throw new Error(`The month has no activity ${activity}.`);
      return row(month, isoDate(period, day), booking);
    }
    // A planted booking is dated as the clean booking behind it, or as the month's last one.
    const day = plantedHere.outsideDays ?? order.at(Math.min(cleanBefore, cleanCount - 1)).day;
    const purchase = business.plantedPurchase(plantedHere.ordinal);
    return row(
      month,
      isoDate(period, day),
      plantedHere.rule === "date-outside-month"
        ? purchase
        : plantedBooking(
            purchase,
            plantedHere.rule,
            LEDGERS[client.skr],
            seededGenerator(mixedSeed(seed, STREAM.plan, clientId, period.index, position))
          )
    );
  }

  return {
    /** The bookings from `offset` on, at most `limit` of them, in the month's order. */
    rows(offset: number, limit: number): Posting[] {
      const length = Math.max(0, Math.min(limit, count - offset));
      return Array.from({ length }, (_, index) => posting(offset + index));
    }
  };
}
