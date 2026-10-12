import { mixedSeed, pick, seededGenerator, shuffled, weighted } from "../random.js";
import { LEDGERS, vatRate, type Account, type Ledger } from "./accounts.js";
import { evenPlace, type Activity, type Booking } from "./booking.js";
import { TILL_BOOKINGS_PER_DEPOSIT, type Purchase } from "./business.js";
import { monthAt, periodLabel, type SampleMonth } from "./calendar.js";
import { postingCount, STREAM, type SampleClient } from "./clients.js";
import { customerOf, frequentPlace, supplierOf } from "./counterparties.js";
import {
  documentLink,
  invoiceDocument,
  supplierDocument,
  yearlyDocument,
  type Issued
} from "./documents.js";
import { BOOKINGS_PER_PAYSLIP, payrollBookingCount, payrollTotals, payslip } from "./payroll.js";

// The clean bookings of a client's month, as the activities of its business: it writes
// invoices and is paid, takes money through the till, buys on account and pays, buys by direct
// debit and in cash, runs the payroll and has its standing orders. Each booking is a pure
// function of the seed, the client, the month, the activity and the booking's rank in it.
//
// An invoice goes through the personal account of its customer or supplier, and the payment
// that settles it follows about two weeks later: the invoices of the first part of a month
// are paid in that month, the others in the next. So some are open at each month's end, and a
// payment names an invoice that exists, with its number, its counterparty and its amount.

/** The share of a month's invoices, the earliest ones, that are paid in the same month. */
const SETTLED_IN_MONTH = 0.55;
/** The share of direct purchases that are general reversals: a direct debit that was returned. */
const GENERAL_REVERSAL_SHARE = 0.01;
/** A till is booked once a day, so a client has one till for each so many till bookings a month. */
const TILL_BOOKINGS_PER_TILL = 26;
/** How many times its smallest amount the largest amount of a kind is: of a purchase, a sale and a flat's rent. */
const PURCHASE_SPREAD = 20;
const SALE_SPREAD = 8;
const RENT_SPREAD = 3;
/** The month a rent roll is drawn for: a flat keeps its tenant and its rent in every month. */
const EVERY_MONTH = 0;

/** What tells the draws and the document links of the activities apart. */
const ACTIVITY = {
  salesInvoices: 1,
  tillBookings: 2,
  purchasesOnAccount: 3,
  directPurchases: 4,
  payroll: 5
} as const;

type Random = () => number;
type Channel = keyof SampleClient["business"]["purchases"];

/** A client's month as far as the bookings of another month need it. */
interface Frame {
  seed: number;
  client: SampleClient;
  ledger: Ledger;
  period: SampleMonth;
  /** The month's revenue as a multiple of the usual month's, by the season of the industry. */
  level: number;
  /** How many documents of each kind the month has. */
  issued: { salesInvoices: number; tillBookings: number; supplierInvoices: number };
}

/** How many bookings of a month are planted and not part of the client's business. */
type PlantedCount = (monthIndex: number) => number;

function frameOf(
  seed: number,
  client: SampleClient,
  monthIndex: number,
  plantedCount: PlantedCount
): Frame {
  const { business, usualPostingCount } = client;
  const volume =
    (postingCount(seed, client, monthIndex) - plantedCount(monthIndex)) / usualPostingCount;
  const period = monthAt(monthIndex);
  return {
    seed,
    client,
    ledger: LEDGERS[client.skr],
    period,
    level: pick(business.profile.season, period.month - 1),
    issued: {
      salesInvoices: Math.max(2, Math.round(business.usual.salesInvoices * volume)),
      tillBookings:
        business.usual.tillBookings === 0
          ? 0
          : Math.max(1, Math.round(business.usual.tillBookings * volume)),
      supplierInvoices: Math.max(2, Math.round(business.usual.supplierInvoices * volume))
    }
  };
}

function drawsOf(frame: Frame, activity: number, rank: number, monthIndex = frame.period.index) {
  return seededGenerator(
    mixedSeed(frame.seed, STREAM.booking, frame.client.row.client_id, monthIndex, activity, rank)
  );
}

/** The two even draws of a booking: for its account, and for its amount. */
const LINE = 0;
const AMOUNT = 1;

/**
 * A draw in [0, 1) for the booking at `rank` of an activity's `count` bookings. Together the
 * draws of a month cover the range evenly, each booking in a share of its own, so the split
 * over accounts and the month's total come out as the profile says however few bookings
 * there are. `what` tells the draws of one booking apart.
 */
function evenDraw(
  frame: Frame,
  activity: number,
  what: number,
  rank: number,
  count: number,
  random: Random
): number {
  // A planted purchase stands behind the month's own and draws freely.
  if (rank >= count) return random();
  const { seed, client, period } = frame;
  const share = shuffled(
    rank,
    count,
    mixedSeed(seed, STREAM.evenDraw, client.row.client_id, period.index, activity, what)
  );
  return (share + random()) / count;
}

function linkOf(frame: Frame, activity: number, rank: number): string {
  return documentLink(
    frame.seed,
    STREAM.documentLink,
    frame.client.row.client_id,
    frame.period.index,
    activity,
    rank
  );
}

/** A net amount around the usual one, as gross cents at the tax rate. Its mean is the usual amount. */
function grossCents(usualEuros: number, rate: number, draw: number, spread: number) {
  const lowest = Math.log(spread) / (spread - 1);
  const netEuros = usualEuros * lowest * Math.pow(spread, draw);
  return Math.max(1, Math.round(netEuros * (100 + rate)));
}

/** The cost centre an account's booking carries: one of the client's for an expense, else none. */
function costCentreOf(client: SampleClient, account: Account, draw: number): string {
  return account.account_class === "expense" && client.costCentres.length > 0
    ? pick(client.costCentres, Math.floor(draw * client.costCentres.length))
    : "";
}

const plain = { generalReversal: false, costCentre: "", documentLink: "", origin: "RE" } as const;

/** How many of `count` invoices of a month are paid in that month. */
function settledInMonth(count: number): number {
  return Math.floor(SETTLED_IN_MONTH * count);
}

/**
 * The payments of a month, where `payment` gives the one for the invoice at a rank of a
 * month: first for the invoices the month before left open, then for the first ones of the
 * month itself. Each payment lies after its invoice, since both are spread evenly over their
 * month.
 */
function settlements(
  previous: { frame: Frame; count: number },
  current: { frame: Frame; count: number },
  payment: (frame: Frame, rank: number) => Booking
): Activity {
  const paidBefore = settledInMonth(previous.count);
  const carried = previous.count - paidBefore;
  const count = carried + settledInMonth(current.count);
  return {
    count,
    place: evenPlace(count),
    booking: (rank) =>
      rank < carried
        ? payment(previous.frame, paidBefore + rank)
        : payment(current.frame, rank - carried)
  };
}

/** What `countOf` has counted in the months from `from` up to but not `to`. */
function issuedBetween(
  frame: Frame,
  plantedCount: PlantedCount,
  from: number,
  to: number,
  countOf: (issued: Frame["issued"]) => number
): number {
  let sum = 0;
  for (let index = from; index < to; index += 1) {
    sum += countOf(frameOf(frame.seed, frame.client, index, plantedCount).issued);
  }
  return sum;
}

/** What the client has issued in a running range before the frame's month. */
function issuedBefore(
  frame: Frame,
  plantedCount: PlantedCount,
  countOf: (issued: Frame["issued"]) => number
): Issued {
  const { index, month } = frame.period;
  const between = (from: number, to: number) =>
    issuedBetween(frame, plantedCount, from, to, countOf);
  return {
    thisYear: between(index - (month - 1), index),
    ever: index >= 0 ? between(0, index) : -between(index, 0)
  };
}

/** A sales invoice of the frame's month, as the invoice and its payment book it. */
function salesInvoice(frame: Frame, before: Issued, rank: number) {
  const { client, ledger, period } = frame;
  const { invoices } = client.business.profile;
  const random = drawsOf(
    frame,
    ACTIVITY.salesInvoices,
    rank,
    invoices.rentRoll ? EVERY_MONTH : period.index
  );
  const customer = customerOf(
    client,
    invoices.rentRoll
      ? rank % client.business.customers
      : frequentPlace(client.business.customers, random())
  );
  // A flat keeps its line and its rent. Any other invoice shares the month evenly with the rest.
  const draw = (what: number) =>
    invoices.rentRoll
      ? random()
      : evenDraw(frame, ACTIVITY.salesInvoices, what, rank, frame.issued.salesInvoices, random);
  const line = weighted(invoices.lines(period.year), ({ share }) => share, draw(LINE));
  const account = ledger[line.account];
  const document = invoiceDocument(
    client.row.client_id,
    period,
    { thisYear: before.thisYear + rank, ever: before.ever + rank },
    client.business.usual.salesInvoices
  );
  return {
    account,
    customer,
    vatKey: line.vatKey,
    cents: grossCents(
      invoices.euros * frame.level,
      vatRate(account.automatic_vat_key ?? line.vatKey),
      draw(AMOUNT),
      invoices.rentRoll ? RENT_SPREAD : SALE_SPREAD
    ),
    document,
    text: invoices.rentRoll
      ? `Miete ${periodLabel(period)} WE ${String(rank + 1).padStart(4, "0")} ${customer.name}`
      : `AR ${document} ${customer.name}`
  };
}

/** The account a counterparty's invoice is booked against. */
function personalAccountOf({ name, account }: { name: string; account: Account | null }): Account {
  if (account === null) throw new Error(`${name} has no personal account.`);
  return account;
}

function salesInvoiceBooking(frame: Frame, before: Issued, rank: number): Booking {
  const invoice = salesInvoice(frame, before, rank);
  return {
    ...plain,
    account: invoice.account,
    contra: personalAccountOf(invoice.customer),
    side: "H",
    vatKey: invoice.vatKey,
    cents: invoice.cents,
    text: invoice.text,
    document: invoice.document,
    documentLink: linkOf(frame, ACTIVITY.salesInvoices, rank)
  };
}

function customerPayment(frame: Frame, before: Issued, rank: number): Booking {
  const invoice = salesInvoice(frame, before, rank);
  return {
    ...plain,
    account: frame.ledger.bank,
    contra: personalAccountOf(invoice.customer),
    side: "S",
    vatKey: 0,
    cents: invoice.cents,
    text: `Zahlungseingang ${invoice.text}`,
    document: invoice.document
  };
}

/** One till's takings of a day at one tax rate, booked with the number of the till report. */
function tillBooking(frame: Frame, before: Issued, rank: number): Booking {
  const { client, ledger, period } = frame;
  const { till } = client.business.profile;
  if (till === null) throw new Error("A client without a till has no till bookings.");
  const random = drawsOf(frame, ACTIVITY.tillBookings, rank);
  const draw = (what: number) =>
    evenDraw(frame, ACTIVITY.tillBookings, what, rank, frame.issued.tillBookings, random);
  const line = weighted(till.lines(period.year), ({ share }) => share, draw(LINE));
  const account = ledger[line.account];
  const tills = Math.max(
    1,
    Math.round(client.business.usual.tillBookings / TILL_BOOKINGS_PER_TILL)
  );
  return {
    ...plain,
    account,
    contra: ledger.cash,
    side: "H",
    vatKey: line.vatKey,
    cents: grossCents(
      till.euros * frame.level,
      vatRate(account.automatic_vat_key ?? line.vatKey),
      draw(AMOUNT),
      SALE_SPREAD
    ),
    text: `Tageseinnahmen Kasse ${1 + Math.floor(random() * tills)}`,
    document: yearlyDocument("Z", period, before.thisYear + rank),
    documentLink: linkOf(frame, ACTIVITY.tillBookings, rank)
  };
}

/** The till's cash brought to the bank, in whole fifties and with the number of the deposit slip. */
function cashDeposit(frame: Frame, before: Issued, rank: number): Booking {
  const { client, ledger, period } = frame;
  const usualEuros =
    (client.business.profile.till?.euros ?? 0) * TILL_BOOKINGS_PER_DEPOSIT * frame.level;
  const document = yearlyDocument("EZ", period, before.thisYear + rank);
  return {
    ...plain,
    account: ledger.bank,
    contra: ledger.cash,
    side: "S",
    vatKey: 0,
    cents: Math.max(1, Math.round(usualEuros / 50)) * 5_000,
    text: `Bareinzahlung ${document}`,
    document
  };
}

/**
 * A purchase of the frame's month through one channel, which has `count` of them. `slots` is
 * how many purchases the channel may number in the month, which the supplier's number is
 * taken from. `purchase` names the kind, and is drawn by the weights of the client's
 * purchases when left out.
 */
function purchaseOf(
  frame: Frame,
  channel: Channel,
  rank: number,
  { count, slots }: { count: number; slots: number },
  purchase?: Purchase
) {
  const { client, ledger, period } = frame;
  const activity = channel === "onAccount" ? ACTIVITY.purchasesOnAccount : ACTIVITY.directPurchases;
  const random = drawsOf(frame, activity, rank);
  const draw = (what: number) => evenDraw(frame, activity, what, rank, count, random);
  const drawn = weighted(client.business.purchases[channel], ({ weight }) => weight, draw(LINE));
  const { kind, euros, suppliers } = purchase ?? drawn;
  const supplier = supplierOf(client, purchase ?? drawn, frequentPlace(suppliers, random()));
  const account = ledger[kind.account];
  // An automatic account always carries its tax. On any other account the purchase is
  // deductible by the share of the client's industry, and booked gross without a key if not.
  const deductible = random() < client.business.profile.inputVatShare;
  const vatKey = account.automatic_vat_key === null && deductible ? kind.vatKey : 0;
  return {
    kind,
    account,
    supplier,
    vatKey,
    cents: grossCents(
      euros * (kind.seasonal ? frame.level : 1),
      vatRate(account.automatic_vat_key ?? vatKey),
      draw(AMOUNT),
      PURCHASE_SPREAD
    ),
    document: supplierDocument(supplier.key, client.size.maximum, period, rank, slots),
    costCentre: costCentreOf(client, account, random()),
    documentLink: linkOf(frame, activity, rank),
    random
  };
}

function supplierInvoiceBooking(
  frame: Frame,
  rank: number,
  slots: number,
  purchase?: Purchase
): Booking {
  const invoice = purchaseOf(
    frame,
    "onAccount",
    rank,
    { count: frame.issued.supplierInvoices, slots },
    purchase
  );
  return {
    ...plain,
    account: invoice.account,
    contra: personalAccountOf(invoice.supplier),
    side: "S",
    vatKey: invoice.vatKey,
    cents: invoice.cents,
    text: `ER ${invoice.document} ${invoice.supplier.name}`,
    document: invoice.document,
    documentLink: invoice.documentLink,
    costCentre: invoice.costCentre
  };
}

function supplierPayment(frame: Frame, rank: number, slots: number): Booking {
  const invoice = supplierInvoiceBooking(frame, rank, slots);
  return {
    ...plain,
    account: invoice.contra,
    contra: frame.ledger.bank,
    side: "S",
    vatKey: 0,
    cents: invoice.cents,
    text: `Zahlung ${invoice.text}`,
    document: invoice.document
  };
}

function directPurchase(frame: Frame, rank: number, count: number): Booking {
  const bought = purchaseOf(frame, "direct", rank, { count, slots: count });
  const byDebit = bought.kind.settlement === "bank";
  const text = `${byDebit ? "Lastschrift" : "Barbeleg"} ${bought.supplier.name} ${bought.document}`;
  const reversed = bought.random() < GENERAL_REVERSAL_SHARE;
  return {
    ...plain,
    account: bought.account,
    contra: byDebit ? frame.ledger.bank : frame.ledger.cash,
    side: reversed ? "H" : "S",
    vatKey: bought.vatKey,
    cents: bought.cents,
    text: reversed ? `Storno ${text}` : text,
    document: bought.document,
    documentLink: bought.documentLink,
    generalReversal: reversed,
    costCentre: bought.costCentre
  };
}

/** The number of the month's bank statement, which a booking from the statement carries. */
function statementDocument(period: SampleMonth): string {
  return `KA ${periodLabel(period)}`;
}

/**
 * The payroll run of the month: the wage tax of the month before is paid on the 10th, the
 * payslips are booked near the end, then the health insurers and the net wages are paid. The
 * lines of the payslips are one document, the payroll journal, and come from the payroll.
 */
function payrollRun(frame: Frame): Activity {
  const { client, ledger, period } = frame;
  const { employees, wageLevel } = client.business;
  const totals = payrollTotals(wageLevel, employees);
  const label = periodLabel(period);
  const payslipLines = employees * (BOOKINGS_PER_PAYSLIP - 1);
  const journal = {
    document: `LO ${label}`,
    documentLink: linkOf(frame, ACTIVITY.payroll, 0),
    origin: "LO"
  } as const;
  const transfer = { ...plain, contra: ledger.bank, side: "S", vatKey: 0 } as const;
  const statement = statementDocument(period);
  const staffNumber = (employee: number) => `Pers.-Nr. ${String(employee + 1).padStart(4, "0")}`;

  function payslipLine(employee: number, line: number): Booking {
    const slip = payslip(wageLevel, employee);
    const lines = [
      { cents: slip.netCents, contra: ledger.wagePayables, what: "Auszahlungsbetrag" },
      { cents: slip.wageTaxCents, contra: ledger.wageTaxPayables, what: "Lohnsteuer" },
      {
        cents: slip.employeeShareCents,
        contra: ledger.socialSecurityPayables,
        what: "SV Arbeitnehmeranteil"
      },
      {
        cents: slip.employerShareCents,
        contra: ledger.socialSecurityPayables,
        what: "SV Arbeitgeberanteil",
        account: ledger.socialSecurity
      }
    ];
    const { cents, contra, what, account = ledger.wages } = pick(lines, line);
    return {
      ...plain,
      ...journal,
      account,
      contra,
      side: "S",
      vatKey: 0,
      cents,
      text: `Lohn ${label} ${staffNumber(employee)} ${what}`,
      costCentre: client.costCentres.length > 0 ? pick(client.costCentres, employee) : ""
    };
  }

  return {
    count: payrollBookingCount(employees),
    place: (rank) =>
      rank === 0 ? 0.3 : rank <= payslipLines ? 0.84 : rank === payslipLines + 1 ? 0.9 : 0.95,
    booking(rank) {
      if (rank === 0) {
        return {
          ...transfer,
          account: ledger.wageTaxPayables,
          cents: totals.wageTaxCents,
          text: `Lohnsteuer ${periodLabel(monthAt(period.index - 1))}`,
          document: statement
        };
      }
      if (rank <= payslipLines) {
        const line = rank - 1;
        return payslipLine(
          Math.floor(line / (BOOKINGS_PER_PAYSLIP - 1)),
          line % (BOOKINGS_PER_PAYSLIP - 1)
        );
      }
      if (rank === payslipLines + 1) {
        return {
          ...transfer,
          account: ledger.socialSecurityPayables,
          cents: totals.socialSecurityCents,
          text: `Sozialversicherung ${label}`,
          document: statement
        };
      }
      const employee = rank - payslipLines - 2;
      return {
        ...transfer,
        account: ledger.wagePayables,
        cents: payslip(wageLevel, employee).netCents,
        text: `Lohn ${label} ${staffNumber(employee)} Überweisung`,
        document: statement
      };
    }
  };
}

/** The client's standing orders, each once in the month and paid from the bank. */
function standingOrders(frame: Frame): Activity {
  const { client, ledger, period } = frame;
  const orders = client.business.standingOrders;
  return {
    count: orders.length,
    place: (rank) => pick(orders, rank).place,
    booking(rank) {
      const order = pick(orders, rank);
      const account = ledger[order.account];
      return {
        ...plain,
        account,
        contra: ledger.bank,
        side: "S",
        vatKey: 0,
        cents: Math.round(order.euros * 100),
        text: order.text(periodLabel(period)),
        document: order.onStatement ? statementDocument(period) : "",
        costCentre: costCentreOf(client, account, 0)
      };
    }
  };
}

/**
 * The activities of a client's month and the purchase a planted booking is made of. Together
 * they have the month's count less its planted bookings: the direct purchases take the
 * bookings the others leave.
 */
export function activitiesOf(
  seed: number,
  client: SampleClient,
  period: SampleMonth,
  plantedCount: PlantedCount
) {
  const frame = frameOf(seed, client, period.index, plantedCount);
  const previous = frameOf(seed, client, period.index - 1, plantedCount);
  const { issued } = frame;
  // A planted booking is a purchase on account behind the month's last one, so the suppliers
  // number the month's purchases and the planted ones together.
  const invoiceSlots = (month: Frame) =>
    month.issued.supplierInvoices + plantedCount(month.period.index);
  const invoicesBefore = (month: Frame) =>
    issuedBefore(month, plantedCount, ({ salesInvoices }) => salesInvoices);
  const numbering = new Map(
    [frame, previous].map((month) => [
      month,
      { invoicesBefore: invoicesBefore(month), invoiceSlots: invoiceSlots(month) }
    ])
  );
  const numberingOf = (month: Frame) => {
    const found = numbering.get(month);
    if (found === undefined) throw new Error("Only this month and the one before are numbered.");
    return found;
  };
  const tillBefore = issuedBefore(frame, plantedCount, (month) => month.tillBookings);
  const deposits = (month: Frame["issued"]) =>
    Math.floor(month.tillBookings / TILL_BOOKINGS_PER_DEPOSIT);
  const depositsBefore = issuedBefore(frame, plantedCount, deposits);
  const office = client.business.purchases.onAccount.find(({ kind }) => kind.account === "office");

  const settled: Activity[] = [
    {
      count: issued.salesInvoices,
      place: evenPlace(issued.salesInvoices),
      booking: (rank) => salesInvoiceBooking(frame, numberingOf(frame).invoicesBefore, rank)
    },
    settlements(
      { frame: previous, count: previous.issued.salesInvoices },
      { frame, count: issued.salesInvoices },
      (invoiced, rank) => customerPayment(invoiced, numberingOf(invoiced).invoicesBefore, rank)
    ),
    {
      count: issued.tillBookings,
      place: evenPlace(issued.tillBookings),
      booking: (rank) => tillBooking(frame, tillBefore, rank)
    },
    {
      count: deposits(issued),
      place: evenPlace(deposits(issued)),
      booking: (rank) => cashDeposit(frame, depositsBefore, rank)
    },
    {
      count: issued.supplierInvoices,
      place: evenPlace(issued.supplierInvoices),
      booking: (rank) => supplierInvoiceBooking(frame, rank, numberingOf(frame).invoiceSlots)
    },
    settlements(
      { frame: previous, count: previous.issued.supplierInvoices },
      { frame, count: issued.supplierInvoices },
      (invoiced, rank) => supplierPayment(invoiced, rank, numberingOf(invoiced).invoiceSlots)
    ),
    payrollRun(frame),
    standingOrders(frame)
  ];
  const directCount =
    postingCount(seed, client, period.index) -
    plantedCount(period.index) -
    settled.reduce((sum, activity) => sum + activity.count, 0);
  if (directCount < 0) {
    throw new Error(
      `The month ${periodLabel(period)} of client ${client.row.client_id} has more bookings than its count.`
    );
  }
  return {
    activities: [
      ...settled,
      {
        count: directCount,
        place: evenPlace(directCount),
        booking: (rank: number) => directPurchase(frame, rank, directCount)
      }
    ],
    /** The office purchase on account at `ordinal` behind the month's last purchase. */
    plantedPurchase(ordinal: number): Booking {
      if (office === undefined) throw new Error("A client without office purchases has none.");
      return supplierInvoiceBooking(
        frame,
        issued.supplierInvoices + ordinal,
        numberingOf(frame).invoiceSlots,
        office
      );
    }
  };
}
