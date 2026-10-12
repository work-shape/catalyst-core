import { mixedSeed } from "../random.js";
import { MONTHS_PER_YEAR, twoDigits, type SampleMonth } from "./calendar.js";

// The numbers and links of documents. A supplier numbers its invoices in its own format and
// its numbers rise over the months. A client numbers what it issues itself in one running
// range. No number is a booking's place in the month.

/** How many formats a supplier's invoice numbers come in. */
const SUPPLIER_FORMATS = 4;
/** A supplier issues at least as many numbers a month as its client's month may have bookings, and up to this many times more. */
const SUPPLIER_VOLUMES = 12;
/** The months a supplier with one running range has numbered before the sample's first month, at least. */
const SUPPLIER_HISTORY_MONTHS = 14;

function padded(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * The number of a supplier's invoice. The supplier's counter runs through a fixed span of
 * numbers each month, and the invoice at `slot` of the month's `slots` takes the number the
 * counter has reached then: later in the month or in a later month it is higher, and two
 * slots never share one, because the span is no smaller than `capacity`, the most bookings
 * the client's month may have. Some suppliers start again each year, others count on.
 */
export function supplierDocument(
  supplierKey: number,
  capacity: number,
  month: SampleMonth,
  slot: number,
  slots: number
): string {
  const monthly = capacity * (1 + (supplierKey % SUPPLIER_VOLUMES));
  // Each slot has a run of numbers of its own, and the invoice takes any one of the run.
  const run = Math.floor(monthly / slots);
  const inMonth =
    Math.floor((slot * monthly) / slots) + (mixedSeed(supplierKey, month.index, slot) % run);
  const inYear = padded(
    (month.month - 1) * monthly + inMonth + 1,
    String(MONTHS_PER_YEAR * monthly).length
  );
  const history = SUPPLIER_HISTORY_MONTHS + (mixedSeed(supplierKey, 2) % 240);
  const ever = (history + month.index) * monthly + inMonth;
  const shortYear = twoDigits(month.year % 100);
  switch (mixedSeed(supplierKey, 1) % SUPPLIER_FORMATS) {
    case 0:
      return `RE${shortYear}${inYear}`;
    case 1:
      return `${month.year}-${inYear}`;
    case 2:
      return `R-${ever}`;
    default:
      return String(ever);
  }
}

/** What a client has issued in its running range before a document: since January, and since the sample's first month. */
export interface Issued {
  thisYear: number;
  ever: number;
}

/**
 * The number of a sales invoice in the client's own range. Each client keeps one of three
 * formats: two start again each year, one counts on from the invoices of the years before.
 */
export function invoiceDocument(
  clientKey: number,
  month: SampleMonth,
  issued: Issued,
  usualInvoicesAMonth: number
): string {
  switch (clientKey % 3) {
    case 0:
      return `${month.year}-${padded(issued.thisYear + 1, 5)}`;
    case 1:
      return `${twoDigits(month.year % 100)}${padded(issued.thisYear + 1, 6)}`;
    default:
      return String((24 + (clientKey % 96)) * usualInvoicesAMonth + issued.ever + 1);
  }
}

/** The number of a document of the year that carries a prefix, such as a till report. */
export function yearlyDocument(prefix: string, month: SampleMonth, issuedThisYear: number): string {
  return `${prefix}${twoDigits(month.year % 100)}-${padded(issuedThisYear + 1, 5)}`;
}

/**
 * The link to a document (Beleglink) as a GUID, drawn from what names the document. It is the
 * same whenever it is asked for, and the lines of one document share it.
 */
export function documentLink(...parts: number[]): string {
  const hex = [0, 1, 2, 3]
    .map((word) =>
      mixedSeed(...parts, word)
        .toString(16)
        .padStart(8, "0")
    )
    .join("")
    .toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}
