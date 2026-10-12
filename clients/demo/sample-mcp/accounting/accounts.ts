// The chart of accounts of a sample client: a subset of DATEV's SKR03 or SKR04, by the
// client's `skr`. Both charts hold the same accounts under their own numbers, so a booking is
// written against a role (`bank`, `rent`) and gets the number of the client's chart.

type AccountClass = "asset" | "liability" | "revenue" | "expense";
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
    receivables: account(1400, 1200, "Forderungen aus Lieferungen und Leistungen", "asset"),
    inputVat7: account(1571, 1401, "Abziehbare Vorsteuer 7 %", "asset"),
    inputVat19: account(1576, 1406, "Abziehbare Vorsteuer 19 %", "asset"),
    clearing: account(1590, 1370, "Durchlaufende Posten", "asset", { blocked: true }),
    payables: account(1600, 3300, "Verbindlichkeiten aus Lieferungen und Leistungen", "liability"),
    wagePayables: account(1740, 3720, "Verbindlichkeiten aus Lohn und Gehalt", "liability"),
    vat7: account(1771, 3801, "Umsatzsteuer 7 %", "liability"),
    vat19: account(1776, 3806, "Umsatzsteuer 19 %", "liability"),
    revenueTaxFree: account(8120, 4120, "Steuerfreie Umsätze", "revenue"),
    revenue: account(8200, 4200, "Erlöse", "revenue"),
    revenue7: account(8300, 4300, "Erlöse 7 % USt", "revenue", { automatic_vat_key: 2 }),
    revenue19: account(8400, 4400, "Erlöse 19 % USt", "revenue", { automatic_vat_key: 3 }),
    goods: account(3200, 5200, "Wareneingang", "expense"),
    goods7: account(3300, 5300, "Wareneingang 7 % Vorsteuer", "expense", { automatic_vat_key: 8 }),
    goods19: account(3400, 5400, "Wareneingang 19 % Vorsteuer", "expense", {
      automatic_vat_key: 9
    }),
    wages: account(4120, 6020, "Gehälter", "expense"),
    socialSecurity: account(4130, 6110, "Gesetzliche soziale Aufwendungen", "expense"),
    rent: account(4210, 6310, "Miete", "expense"),
    utilities: account(4240, 6325, "Gas, Strom, Wasser", "expense"),
    insurance: account(4360, 6400, "Versicherungen", "expense"),
    vehicle: account(4530, 6530, "Laufende Kfz-Betriebskosten", "expense"),
    vehicleRepairs: account(4540, 6540, "Kfz-Reparaturen", "expense"),
    advertising: account(4600, 6600, "Werbekosten", "expense"),
    hospitality: account(4650, 6640, "Bewirtungskosten", "expense"),
    travel: account(4660, 6650, "Reisekosten Arbeitnehmer", "expense"),
    otherExpenses: account(4900, 6300, "Sonstige betriebliche Aufwendungen", "expense", {
      blocked: true
    }),
    postage: account(4910, 6800, "Porto", "expense"),
    telephone: account(4920, 6805, "Telefon", "expense"),
    office: account(4930, 6815, "Bürobedarf", "expense"),
    books: account(4940, 6820, "Zeitschriften, Bücher", "expense"),
    legal: account(4950, 6825, "Rechts- und Beratungskosten", "expense"),
    bankFees: account(4970, 6855, "Nebenkosten des Geldverkehrs", "expense")
  };
}

export type Ledger = Readonly<ReturnType<typeof ledger>>;
export type AccountRole = keyof Ledger;

/** The accounts of each chart by their role. */
export const LEDGERS: Readonly<Record<Skr, Ledger>> = { 3: ledger(3), 4: ledger(4) };

/** A chart as `list_accounts` answers it: every account, by its number. */
export function chartOfAccounts(skr: Skr): Account[] {
  return Object.values(LEDGERS[skr]).sort(
    (left, right) => left.account_number - right.account_number
  );
}
