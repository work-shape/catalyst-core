// The chart of accounts of a sample client: a subset of DATEV's SKR03 or SKR04, by the
// client's `skr`, and the client's personal accounts. Both charts hold the same general ledger
// accounts under their own numbers, so a booking is written against a role (`bank`, `rent`)
// and gets the number of the client's chart.
//
// The general ledger accounts have four digits. With that length both charts keep the personal
// accounts in the same five-digit ranges: a debtor (a customer) from 10000 to 69999, a creditor
// (a supplier) from 70000 to 99999.

type AccountClass = "asset" | "liability" | "equity" | "revenue" | "expense";
export type Skr = 3 | 4;

export interface Account {
  account_number: number;
  label: string;
  account_class: AccountClass;
  /** The BU-Schlüssel an automatic account applies by itself; a booking on it carries key 0. */
  automatic_vat_key: number | null;
  /** Closed for bookings. */
  blocked: boolean;
}

const FIRST_DEBTOR_ACCOUNT = 10_000;
const FIRST_CREDITOR_ACCOUNT = 70_000;

const VAT_KEY_RATES = new Map([
  [0, 0],
  [2, 7],
  [3, 19],
  [8, 7],
  [9, 19]
]);

/** The tax rate a BU-Schlüssel of the sample stands for, in percent. */
export function vatRate(key: number): number {
  const rate = VAT_KEY_RATES.get(key);
  if (rate === undefined) throw new Error(`The sample has no BU-Schlüssel ${key}.`);
  return rate;
}

function ledger(skr: Skr) {
  const account = (
    skr03: number,
    skr04: number,
    label: string,
    account_class: AccountClass,
    { automatic_vat_key = null, blocked = false }: Partial<Account> = {}
  ): Account => ({
    account_number: skr === 3 ? skr03 : skr04,
    label,
    account_class,
    automatic_vat_key,
    blocked
  });
  return {
    cash: account(1000, 1600, "Kasse", "asset"),
    bank: account(1200, 1800, "Bank", "asset"),
    cashTransit: account(1360, 1460, "Geldtransit", "asset"),
    // The two collective accounts carry the balances of the personal accounts and are not
    // booked on themselves.
    receivables: account(1400, 1200, "Forderungen aus Lieferungen und Leistungen", "asset"),
    inputVat7: account(1571, 1401, "Abziehbare Vorsteuer 7 %", "asset"),
    inputVat19: account(1576, 1406, "Abziehbare Vorsteuer 19 %", "asset"),
    clearing: account(1590, 1370, "Durchlaufende Posten", "asset", { blocked: true }),
    payables: account(1600, 3300, "Verbindlichkeiten aus Lieferungen und Leistungen", "liability"),
    wagePayables: account(1740, 3720, "Verbindlichkeiten aus Lohn und Gehalt", "liability"),
    wageTaxPayables: account(
      1741,
      3730,
      "Verbindlichkeiten aus Lohn- und Kirchensteuer",
      "liability"
    ),
    socialSecurityPayables: account(
      1742,
      3740,
      "Verbindlichkeiten im Rahmen der sozialen Sicherheit",
      "liability"
    ),
    vat7: account(1771, 3801, "Umsatzsteuer 7 %", "liability"),
    vat19: account(1776, 3806, "Umsatzsteuer 19 %", "liability"),
    privateWithdrawals: account(1800, 2100, "Privatentnahmen allgemein", "equity"),
    revenueExempt: account(8100, 4100, "Steuerfreie Umsätze § 4 Nr. 8 ff. UStG", "revenue"),
    revenueRentExempt: account(
      8105,
      4105,
      "Steuerfreie Umsätze nach § 4 Nr. 12 UStG (Vermietung und Verpachtung)",
      "revenue"
    ),
    revenueExport: account(8120, 4120, "Steuerfreie Umsätze § 4 Nr. 1a UStG", "revenue"),
    revenueIntraCommunity: account(
      8125,
      4125,
      "Steuerfreie innergemeinschaftliche Lieferungen § 4 Nr. 1b UStG",
      "revenue"
    ),
    revenue: account(8200, 4200, "Erlöse", "revenue"),
    revenue7: account(8300, 4300, "Erlöse 7 % USt", "revenue", { automatic_vat_key: 2 }),
    revenue19: account(8400, 4400, "Erlöse 19 % USt", "revenue", { automatic_vat_key: 3 }),
    subcontractors: account(3100, 5900, "Fremdleistungen", "expense"),
    goods: account(3200, 5200, "Wareneingang", "expense"),
    goods7: account(3300, 5300, "Wareneingang 7 % Vorsteuer", "expense", { automatic_vat_key: 8 }),
    goods19: account(3400, 5400, "Wareneingang 19 % Vorsteuer", "expense", {
      automatic_vat_key: 9
    }),
    wages: account(4100, 6000, "Löhne und Gehälter", "expense"),
    socialSecurity: account(4130, 6110, "Gesetzliche soziale Aufwendungen", "expense"),
    rent: account(4210, 6310, "Miete (unbewegliche Wirtschaftsgüter)", "expense"),
    utilities: account(4240, 6325, "Gas, Strom, Wasser", "expense"),
    cleaning: account(4250, 6330, "Reinigung", "expense"),
    premisesRepairs: account(4260, 6335, "Instandhaltung betrieblicher Räume", "expense"),
    insurance: account(4360, 6400, "Versicherungen", "expense"),
    vehicle: account(4530, 6530, "Laufende Kfz-Betriebskosten", "expense"),
    vehicleRepairs: account(4540, 6540, "Kfz-Reparaturen", "expense"),
    advertising: account(4600, 6600, "Werbekosten", "expense"),
    hospitality: account(4650, 6640, "Bewirtungskosten", "expense"),
    travel: account(4660, 6650, "Reisekosten Arbeitnehmer", "expense"),
    machineRepairs: account(
      4800,
      6460,
      "Reparaturen und Instandhaltungen von technischen Anlagen und Maschinen",
      "expense"
    ),
    otherExpenses: account(4900, 6300, "Sonstige betriebliche Aufwendungen", "expense", {
      blocked: true
    }),
    postage: account(4910, 6800, "Porto", "expense"),
    telephone: account(4920, 6805, "Telefon", "expense"),
    office: account(4930, 6815, "Bürobedarf", "expense"),
    books: account(4940, 6820, "Zeitschriften, Bücher", "expense"),
    legal: account(4950, 6825, "Rechts- und Beratungskosten", "expense"),
    licences: account(
      4964,
      6837,
      "Aufwendungen für die zeitlich befristete Überlassung von Rechten (Lizenzen, Konzessionen)",
      "expense"
    ),
    bankFees: account(4970, 6855, "Nebenkosten des Geldverkehrs", "expense"),
    supplies: account(4980, 6850, "Sonstiger Betriebsbedarf", "expense"),
    tools: account(4985, 6845, "Werkzeuge und Kleingeräte", "expense")
  };
}

export type Ledger = Readonly<ReturnType<typeof ledger>>;
export type AccountRole = keyof Ledger;

/** The general ledger accounts of each chart by their role. */
export const LEDGERS: Readonly<Record<Skr, Ledger>> = { 3: ledger(3), 4: ledger(4) };

/** The personal account of a customer (a debtor) or of a supplier (a creditor). */
export function personalAccount(
  kind: "debtor" | "creditor",
  /** Counted from 0 among the client's accounts of that kind. */
  index: number,
  label: string
): Account {
  return {
    account_number: (kind === "debtor" ? FIRST_DEBTOR_ACCOUNT : FIRST_CREDITOR_ACCOUNT) + index,
    label,
    account_class: kind === "debtor" ? "asset" : "liability",
    automatic_vat_key: null,
    blocked: false
  };
}

/** A chart as `list_accounts` answers it: the general ledger and the personal accounts, by number. */
export function chartOfAccounts(skr: Skr, personalAccounts: readonly Account[]): Account[] {
  return [...Object.values(LEDGERS[skr]), ...personalAccounts].sort(
    (left, right) => left.account_number - right.account_number
  );
}
