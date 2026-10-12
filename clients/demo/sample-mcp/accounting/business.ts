import type { AccountRole } from "./accounts.js";
import { employeeCostEuros, payrollBookingCount } from "./payroll.js";
import { EXPENSE_KINDS, type ExpenseKind, type Profile } from "./profiles.js";

// What a client's usual month holds. The profile of the industry says what a euro of revenue
// costs and how large one booking is, so a euro of revenue stands for a fixed number of
// bookings. The client's ledger has a given size, and from it follow the revenue, the head
// count and how many invoices, till bookings and purchases a month has. A small ledger is a
// small business, and expenses relate to revenue as the client's margin says.

/** The share of clients that lose money, and the bounds of their margin. */
const LOSS_SHARE = 0.12;
const LOSS_MARGIN = [-0.12, -0.01] as const;
/**
 * The least of a usual month that is purchases paid by direct debit or in cash and standing
 * orders: a share of its bookings, and a number of them in a small month. The direct
 * purchases take the bookings every other kind leaves, so a month always has its exact count,
 * and this room is what the other kinds may vary by from month to month.
 */
const DIRECT_SHARE_MINIMUM = 0.12;
const DIRECT_BOOKINGS_MINIMUM = 20;
/** The till's cash goes to the bank once in this many till bookings. */
export const TILL_BOOKINGS_PER_DEPOSIT = 5;
/** One payment in this many is booked in two bookings: less a cash discount, or in two parts. */
export const PAYMENTS_PER_SPLIT = 8;
const SUPPLIERS_PER_PURCHASE = 0.25;
const SUPPLIERS_MAXIMUM = 150;
const CUSTOMERS_PER_INVOICE = 0.6;
const CUSTOMERS_MAXIMUM = 2_000;
/** What an owner draws of the usual month's profit. */
const WITHDRAWN_SHARE_OF_PROFIT = 0.7;
const SMALLEST_WITHDRAWAL_EUROS = 500;
/** The least an employee works, as a share of full time. */
const SMALLEST_EMPLOYMENT = 0.4;

type Random = () => number;

/** How many bookings pay `invoices` invoices. */
export function settlementBookings(invoices: number): number {
  return invoices + Math.floor(invoices / PAYMENTS_PER_SPLIT);
}

/** One kind of purchase of a client. */
export interface Purchase {
  kind: ExpenseKind;
  /** How many of them a euro of revenue stands for: the chance among the purchases of one channel. */
  weight: number;
  /** The usual net amount of one, in euros. */
  euros: number;
  /** How many suppliers the client buys it from. */
  suppliers: number;
}

/** A booking that comes once a month with the same amount. */
export interface StandingOrder {
  /** The booking text for a month named as `MM/YYYY`. */
  text(period: string): string;
  account: AccountRole;
  euros: number;
  /** Where in the month it is dated, from 0 to 1. */
  place: number;
  /** Booked with the number of the bank statement. A bank charge has no document number. */
  onStatement: boolean;
}

export interface Business {
  profile: Profile;
  /** The owner draws the profit and no wage. */
  ownerRun: boolean;
  /** The profit as a share of the net revenue, as planned. A month's bookings come close to it. */
  margin: number;
  /** The net revenue of a usual month, in euros. */
  revenueEuros: number;
  /** The client's wages as a multiple of the sample's wage bands. */
  wageLevel: number;
  employees: number;
  /** How many bookings of each kind a usual month has. */
  usual: { salesInvoices: number; tillBookings: number; supplierInvoices: number };
  customers: number;
  purchases: { onAccount: readonly Purchase[]; direct: readonly Purchase[] };
  /** The office supplies, which every client buys on account. */
  officePurchase: Purchase;
  /**
   * The accounts of the purchases on account that the client's industry does not make. The
   * consultancy has closed them in the client's chart.
   */
  blockedAccounts: readonly AccountRole[];
  standingOrders: readonly StandingOrder[];
}

function between([lowest, highest]: readonly [number, number], random: Random): number {
  return lowest + (highest - lowest) * random();
}

function standingOrders(
  profile: Profile,
  ownerRun: boolean,
  facts: { rentEuros: number; profitEuros: number; usualPostingCount: number },
  random: Random
): StandingOrder[] {
  const orders: StandingOrder[] = [];
  if (profile.rent > 0) {
    orders.push({
      text: (period) => `Miete ${period} ${profile.premises}`,
      account: "rent",
      euros: Math.max(1, Math.round(facts.rentEuros / 10)) * 10,
      place: 0.02,
      onStatement: true
    });
  }
  if (ownerRun) {
    orders.push(
      {
        text: (period) => `Krankenversicherung privat ${period}`,
        account: "privateWithdrawals",
        euros: Math.round(between([350, 880], random) * 100) / 100,
        place: 0.04,
        onStatement: true
      },
      {
        text: (period) => `Privatentnahme ${period}`,
        account: "privateWithdrawals",
        euros: Math.max(
          SMALLEST_WITHDRAWAL_EUROS,
          Math.round((facts.profitEuros * WITHDRAWN_SHARE_OF_PROFIT) / 50) * 50
        ),
        place: 0.5,
        onStatement: true
      }
    );
  }
  orders.push({
    text: (period) => `Kontoführung ${period}`,
    account: "bankFees",
    // Far below the amount from which a round booking without a document is a finding.
    euros: 9.9 + 0.12 * Math.min(facts.usualPostingCount, 5_000),
    place: 0.98,
    onStatement: false
  });
  return orders;
}

/** The business of a client of the profile whose usual month has `usualPostingCount` bookings. */
export function business(
  profile: Profile,
  ownerRun: boolean,
  usualPostingCount: number,
  random: Random
): Business {
  const margin =
    random() < LOSS_SHARE
      ? between(LOSS_MARGIN, random)
      : between(ownerRun ? profile.margin.ownerRun : profile.margin.company, random);
  const usualWageLevel = profile.wageLevel * between([0.9, 1.1], random);
  const kinds = EXPENSE_KINDS.flatMap((kind) => {
    const percent: number | undefined = profile.costs[kind.account];
    return percent === undefined ? [] : [{ kind, percent }];
  });
  // The profile's costs are scaled as a whole to what the client's margin leaves of a euro.
  const costOfRevenue =
    (1 - margin) /
    (kinds.reduce((sum, { percent }) => sum + percent, 0) + profile.payroll + profile.rent);
  const perEuro = kinds.map(({ kind, percent }) => ({
    kind,
    weight: (percent * costOfRevenue) / kind.euros
  }));
  const onAccount = perEuro.filter(({ kind }) => kind.settlement === "account");
  const direct = perEuro.filter(({ kind }) => kind.settlement !== "account");
  const total = (purchases: typeof perEuro) =>
    purchases.reduce((sum, { weight }) => sum + weight, 0);
  const tillShare = profile.till?.share ?? 0;
  const perEuroOf = {
    salesInvoices: (1 - tillShare) / profile.invoices.euros,
    tillBookings: profile.till === null ? 0 : tillShare / profile.till.euros,
    supplierInvoices: total(onAccount),
    employees: (profile.payroll * costOfRevenue) / employeeCostEuros(usualWageLevel)
  };
  // An invoice is booked when it is written and when it is paid.
  const bookingsPerInvoice = 1 + settlementBookings(PAYMENTS_PER_SPLIT) / PAYMENTS_PER_SPLIT;
  const settledPerEuro =
    bookingsPerInvoice * perEuroOf.salesInvoices +
    perEuroOf.tillBookings * (1 + 1 / TILL_BOOKINGS_PER_DEPOSIT) +
    bookingsPerInvoice * perEuroOf.supplierInvoices +
    payrollBookingCount(1) * perEuroOf.employees;
  const directBookingsMinimum = Math.max(
    DIRECT_SHARE_MINIMUM * usualPostingCount,
    DIRECT_BOOKINGS_MINIMUM
  );
  const revenueEuros = Math.min(
    usualPostingCount / (settledPerEuro + total(direct)),
    (usualPostingCount - directBookingsMinimum) / settledPerEuro
  );
  const usual = {
    salesInvoices: Math.max(2, Math.round(revenueEuros * perEuroOf.salesInvoices)),
    tillBookings:
      profile.till === null ? 0 : Math.max(1, Math.round(revenueEuros * perEuroOf.tillBookings)),
    supplierInvoices: Math.max(2, Math.round(revenueEuros * perEuroOf.supplierInvoices))
  };
  // The payroll costs what the profile says with a whole number of employees: where the
  // money stands for half an employee or for one and a half, one works part time or earns
  // more. Less than the smallest employment is no employee.
  const fullTimeEmployees = revenueEuros * perEuroOf.employees;
  const employees =
    fullTimeEmployees < SMALLEST_EMPLOYMENT ? 0 : Math.max(1, Math.round(fullTimeEmployees));
  const wageLevel = employees === 0 ? 0 : (usualWageLevel * fullTimeEmployees) / employees;
  const orders = standingOrders(
    profile,
    ownerRun,
    {
      rentEuros: revenueEuros * profile.rent * costOfRevenue,
      profitEuros: revenueEuros * margin,
      usualPostingCount
    },
    random
  );
  const directBookings =
    usualPostingCount -
    usual.salesInvoices -
    settlementBookings(usual.salesInvoices) -
    usual.tillBookings -
    Math.floor(usual.tillBookings / TILL_BOOKINGS_PER_DEPOSIT) -
    usual.supplierInvoices -
    settlementBookings(usual.supplierInvoices) -
    payrollBookingCount(employees) -
    orders.length;
  // The direct purchases fill what is left of the month, so their amounts are stretched to
  // cost what the profile says however many they are.
  const directStretch = (revenueEuros * total(direct)) / Math.max(1, directBookings);
  const purchase =
    (stretch: number) =>
    ({ kind, weight }: (typeof perEuro)[number]) => ({
      kind,
      weight,
      euros: kind.euros * stretch,
      suppliers: Math.min(
        SUPPLIERS_MAXIMUM,
        Math.max(1, Math.ceil(revenueEuros * weight * SUPPLIERS_PER_PURCHASE))
      )
    });
  const purchasesOnAccount = onAccount.map(purchase(1));
  const officePurchase = purchasesOnAccount.find(({ kind }) => kind.account === "office");
  if (officePurchase === undefined) throw new Error("Every industry buys office supplies.");
  return {
    profile,
    ownerRun,
    margin,
    revenueEuros,
    wageLevel,
    employees,
    usual,
    customers: profile.invoices.rentRoll
      ? Math.min(CUSTOMERS_MAXIMUM, usual.salesInvoices)
      : Math.min(CUSTOMERS_MAXIMUM, Math.ceil(usual.salesInvoices * CUSTOMERS_PER_INVOICE)),
    purchases: { onAccount: purchasesOnAccount, direct: direct.map(purchase(directStretch)) },
    officePurchase,
    blockedAccounts: EXPENSE_KINDS.filter(
      (kind) => kind.settlement === "account" && !kinds.some((bought) => bought.kind === kind)
    ).map(({ account }) => account),
    standingOrders: orders
  };
}
