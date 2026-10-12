import { pick, weighted } from "../random.js";
import { vatRate, type Account } from "./accounts.js";
import { evenDays, type Activity, type Booking } from "./booking.js";
import type { Purchase, StandingOrder } from "./business.js";
import {
  dayAt,
  dayWeights,
  monthAt,
  OFFICE_WEEK,
  periodLabel,
  type SampleMonth
} from "./calendar.js";
import { postingCount, type SampleClient } from "./clients.js";
import { customerOf, frequentPlace, supplierOf, type Counterparty } from "./counterparties.js";
import { invoiceDocument, supplierDocument, type Issued } from "./documents.js";
import {
  ACTIVITY,
  AMOUNT,
  drawsOf,
  evenDraw,
  frameOf,
  grossCents,
  issuedBefore,
  LINE,
  linkOf,
  plain,
  type Frame,
  type PlantedCounts
} from "./frame.js";
import { BOOKINGS_PER_PAYSLIP, payrollBookingCount, payrollTotals, payslip } from "./payroll.js";
import { settlements, type Invoice } from "./settlements.js";
import { tillActivities } from "./tills.js";

// The clean bookings of a client's month, as the activities of its business: it writes
// invoices and is paid (settlements.ts), takes money through the till (tills.ts), buys on
// account and pays, buys by direct debit and in cash, runs the payroll and has its standing
// orders. An invoice goes through the personal account of its customer or supplier. What is
// booked on which day follows the week of a ledger (calendar.ts): little at the weekend and
// nothing on a public holiday, except by a till that is open then.

/** The share of direct purchases that are general reversals: a direct debit that was returned. */
const GENERAL_REVERSAL_SHARE = 0.01;
/** How many times its smallest amount the largest amount of a kind is: of a purchase, a sale and a flat's rent. */
const PURCHASE_SPREAD = 20;
const SALE_SPREAD = 8;
const RENT_SPREAD = 3;
/** The month a rent roll is drawn for: a flat keeps its tenant and its rent in every month. */
const EVERY_MONTH = 0;
/** Where in the month the payroll run books, from 0 to 1: the wage tax of the month before, the payslips, the health insurers and the net wages. */
const PAYROLL_POINTS = { wageTax: 0.3, payslips: 0.84, socialSecurity: 0.9, wages: 0.95 } as const;

type Channel = keyof SampleClient["business"]["purchases"];

/** The cost centre an account's booking carries: one of the client's for an expense, else none. */
function costCentreOf(client: SampleClient, account: Account, draw: number): string {
  return account.account_class === "expense" && client.costCentres.length > 0
    ? pick(client.costCentres, Math.floor(draw * client.costCentres.length))
    : "";
}

/** The account a counterparty's invoice is booked against. */
function personalAccountOf({ name, account }: Counterparty): Account {
  if (account === null) throw new Error(`${name} has no personal account.`);
  return account;
}

/** An invoice as it is booked, and what its payment needs to know of it. */
function invoiced(booking: Booking, personal: Account): { booking: Booking; invoice: Invoice } {
  return {
    booking,
    invoice: {
      personal,
      cents: booking.cents,
      taxRate: vatRate(booking.account.automatic_vat_key ?? booking.vatKey),
      text: booking.text,
      document: booking.document
    }
  };
}

/** The sales invoice at `rank` of the frame's month. `before` is what the client has numbered before the month. */
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
  const personal = personalAccountOf(customer);
  return invoiced(
    {
      ...plain,
      account,
      contra: personal,
      side: "H",
      vatKey: line.vatKey,
      cents: grossCents(
        invoices.euros * frame.level,
        vatRate(account.automatic_vat_key ?? line.vatKey),
        draw(AMOUNT),
        invoices.rentRoll ? RENT_SPREAD : SALE_SPREAD
      ),
      text: invoices.rentRoll
        ? `Miete ${periodLabel(period)} WE ${String(rank + 1).padStart(4, "0")} ${customer.name}`
        : `AR ${document} ${customer.name}`,
      document,
      documentLink: linkOf(frame, ACTIVITY.salesInvoices, rank)
    },
    personal
  );
}

/**
 * A purchase of the frame's month through one channel, which has `count` of them. `slots` is
 * how many purchases the channel may number in the month, which the supplier's number is
 * taken from. The kind of purchase is drawn by the weights of the client's purchases and its
 * supplier from the suppliers of the kind, unless `from` names them.
 */
function purchaseOf(
  frame: Frame,
  channel: Channel,
  rank: number,
  { count, slots }: { count: number; slots: number },
  from?: { purchase: Purchase; supplier?: Counterparty }
) {
  const { client, ledger, period } = frame;
  const activity = channel === "onAccount" ? ACTIVITY.purchasesOnAccount : ACTIVITY.directPurchases;
  const random = drawsOf(frame, activity, rank);
  const draw = (what: number) => evenDraw(frame, activity, what, rank, count, random);
  const drawn = weighted(client.business.purchases[channel], ({ weight }) => weight, draw(LINE));
  const purchase = from?.purchase ?? drawn;
  const { kind, euros, suppliers } = purchase;
  const usualSupplier = supplierOf(client, purchase, frequentPlace(suppliers, random()));
  const supplier = from?.supplier ?? usualSupplier;
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

/** The supplier's invoice at `rank` of the frame's month, of `slots` the suppliers number in it. */
function supplierInvoice(
  frame: Frame,
  rank: number,
  slots: number,
  from?: { purchase: Purchase; supplier?: Counterparty }
) {
  const bought = purchaseOf(
    frame,
    "onAccount",
    rank,
    { count: frame.issued.supplierInvoices, slots },
    from
  );
  const personal = personalAccountOf(bought.supplier);
  return invoiced(
    {
      ...plain,
      account: bought.account,
      contra: personal,
      side: "S",
      vatKey: bought.vatKey,
      cents: bought.cents,
      text: `ER ${bought.document} ${bought.supplier.name}`,
      document: bought.document,
      documentLink: bought.documentLink,
      costCentre: bought.costCentre
    },
    personal
  );
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
 * The payroll run of the month: the wage tax of the month before is paid around the 10th,
 * the payslips are booked near the end, then the health insurers and the net wages are paid.
 * The lines of the payslips are one document, the payroll journal, and come from the payroll.
 */
function payrollRun(frame: Frame, officeDay: (point: number) => number): Activity {
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
    day: (rank) =>
      officeDay(
        rank === 0
          ? PAYROLL_POINTS.wageTax
          : rank <= payslipLines
            ? PAYROLL_POINTS.payslips
            : rank === payslipLines + 1
              ? PAYROLL_POINTS.socialSecurity
              : PAYROLL_POINTS.wages
      ),
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

/** A standing order of the frame's month, paid from the bank. */
function standingOrder({ client, ledger, period }: Frame, order: StandingOrder): Booking {
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

/**
 * The activities of a client's month and what a planted booking is made of. Together the
 * activities have the month's count less its planted bookings: the direct purchases take the
 * bookings the others leave. `plantedIn` says what is planted in a month.
 */
export function activitiesOf(
  seed: number,
  client: SampleClient,
  period: SampleMonth,
  plantedIn: (monthIndex: number) => PlantedCounts
) {
  const frame = frameOf(seed, client, period.index, plantedIn);
  const previous = frameOf(seed, client, period.index - 1, plantedIn);
  const { issued } = frame;
  const { officePurchase, standingOrders } = client.business;
  const officeDay = dayAt(dayWeights(period, OFFICE_WEEK));
  // A planted purchase stands behind the month's last one and a planted sales invoice behind
  // the month's last, so the suppliers and the client number them together with the month's own.
  const numbering = new Map(
    [frame, previous].map((month) => [
      month,
      {
        invoicesBefore: issuedBefore(
          month,
          plantedIn,
          (earlier) => earlier.issued.salesInvoices + earlier.planted.salesInvoices
        ),
        supplierSlots: month.issued.supplierInvoices + month.planted.bookings
      }
    ])
  );
  const numberingOf = (month: Frame) => {
    const found = numbering.get(month);
    if (found === undefined) throw new Error("Only this month and the one before are numbered.");
    return found;
  };
  const salesInvoiceOf = (month: Frame, rank: number) =>
    salesInvoice(month, numberingOf(month).invoicesBefore, rank);
  const supplierInvoiceOf = (month: Frame, rank: number) =>
    supplierInvoice(month, rank, numberingOf(month).supplierSlots);

  const settled: Activity[] = [
    {
      count: issued.salesInvoices,
      day: evenDays(issued.salesInvoices, officeDay),
      booking: (rank) => salesInvoiceOf(frame, rank).booking
    },
    settlements(
      {
        from: "customers",
        activity: ACTIVITY.customerPayments,
        word: "Zahlungseingang",
        discounts: !client.business.profile.invoices.rentRoll,
        invoice: (month, rank) => salesInvoiceOf(month, rank).invoice
      },
      { frame: previous, count: previous.issued.salesInvoices },
      { frame, count: issued.salesInvoices },
      officeDay
    ),
    ...tillActivities(frame, plantedIn),
    {
      count: issued.supplierInvoices,
      day: evenDays(issued.supplierInvoices, officeDay),
      booking: (rank) => supplierInvoiceOf(frame, rank).booking
    },
    settlements(
      {
        from: "suppliers",
        activity: ACTIVITY.supplierPayments,
        word: "Zahlung",
        discounts: true,
        invoice: (month, rank) => supplierInvoiceOf(month, rank).invoice
      },
      { frame: previous, count: previous.issued.supplierInvoices },
      { frame, count: issued.supplierInvoices },
      officeDay
    ),
    payrollRun(frame, officeDay),
    {
      count: standingOrders.length,
      day: (rank) => officeDay(pick(standingOrders, rank).place),
      booking: (rank) => standingOrder(frame, pick(standingOrders, rank))
    }
  ];
  const directCount =
    postingCount(seed, client, period.index) -
    frame.planted.bookings -
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
        day: evenDays(directCount, officeDay),
        booking: (rank: number) => directPurchase(frame, rank, directCount)
      }
    ],
    /** The ordinary bookings a planted one is made of. Each is one more than the month's own. */
    extra: {
      /**
       * The office purchase on account at `ordinal` behind the month's last purchase, from
       * the client's usual supplier unless one is named.
       */
      purchase: (ordinal: number, supplier?: Counterparty): Booking =>
        supplierInvoice(
          frame,
          issued.supplierInvoices + ordinal,
          numberingOf(frame).supplierSlots,
          { purchase: officePurchase, supplier }
        ).booking,
      /** The sales invoice at `ordinal` behind the month's last, with the next number of the client's range. */
      salesInvoice: (ordinal: number): Booking =>
        salesInvoiceOf(frame, issued.salesInvoices + ordinal).booking,
      /** The client's first standing order, as the month books it. */
      standingOrder: (): Booking => standingOrder(frame, pick(standingOrders, 0))
    }
  };
}

/** What a planted booking is made of (see `activitiesOf`). */
export type ExtraBookings = ReturnType<typeof activitiesOf>["extra"];
