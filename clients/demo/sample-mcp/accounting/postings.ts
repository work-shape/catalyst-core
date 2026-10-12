import { mixedSeed, pick, seededGenerator } from "../random.js";
import { LEDGERS, vatRate, type Account, type AccountRole, type Ledger } from "./accounts.js";
import { dayEnds, isoDate, type SampleMonth } from "./calendar.js";
import { fiscalYearOf, postingCount, STREAM, type SampleClient } from "./clients.js";
import { ACCOUNTING_RULES, type AccountingRuleId } from "./rules.js";

// One client's bookings of one month. Nothing is stored: a booking is a pure function of the
// seed, the client, the month and the booking's place in the month, so a page costs time in
// proportion to the page and not to the month.
//
// A month is clean except for the bookings its plan names. A planted booking breaks exactly
// one rule of rules.ts, and no clean booking breaks any, which holds by construction:
//
// - Every booking has a document number or a text that holds its place in the month, so two
//   bookings are alike only where the plan copies one.
// - A booking without a document is a small bank fee, far below the threshold of a round amount.
// - An expense is booked in debit, with a key that fits it, on an open account, with a cost
//   centre when the client uses them. An expense in credit is a general reversal.
// - A booking's date follows from its place, so the month is in date order as it is generated.

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
  record_type: string;
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

/** The chance that a month holds bookings that break a given rule. */
const RULE_PRESENCE = 0.6;
/** A month plants up to two bookings per rule, and one more for each so many bookings. */
const POSTINGS_PER_FURTHER_FINDING = 2_500;
/** How many days before or after the month a planted date may lie. */
const OUTSIDE_DAYS = 5;
/** The share of clean expense bookings that are general reversals. */
const GENERAL_REVERSAL_SHARE = 0.01;
/** The months of the range that are locked (festgeschrieben); the last three are still open. */
const LOCKED_MONTHS = 33;

interface Template {
  weight: number;
  account: AccountRole;
  contras: readonly AccountRole[];
  side: Posting["debit_credit_indicator"];
  /** The BU-Schlüssel a booking draws from. An automatic account applies its own. */
  vatKeys: readonly number[];
  euros: readonly [minimum: number, maximum: number];
  /** Amounts are whole multiples of this, as a rent or a cash withdrawal is. */
  roundingUnitEuros?: number;
  texts: readonly string[];
  /** The prefix of the document number, or `null` for a booking without a document. */
  document: string | null;
}

const TEMPLATES: readonly Template[] = [
  {
    weight: 22,
    account: "revenue19",
    contras: ["receivables", "receivables", "receivables", "cash"],
    side: "H",
    vatKeys: [0],
    euros: [15, 4_800],
    texts: ["Ausgangsrechnung", "Warenverkauf", "Lieferung laut Auftrag", "Leistung laut Vertrag"],
    document: "AR"
  },
  {
    weight: 5,
    account: "revenue7",
    contras: ["receivables", "cash"],
    side: "H",
    vatKeys: [0],
    euros: [8, 1_900],
    texts: ["Warenverkauf ermäßigt", "Ausgangsrechnung 7 %"],
    document: "AR"
  },
  {
    weight: 2,
    account: "revenueTaxFree",
    contras: ["receivables"],
    side: "H",
    vatKeys: [0],
    euros: [200, 9_000],
    texts: ["Innergemeinschaftliche Lieferung", "Ausfuhrlieferung"],
    document: "AR"
  },
  {
    weight: 4,
    account: "revenue",
    contras: ["receivables", "cash"],
    side: "H",
    vatKeys: [3, 3, 3, 2],
    euros: [15, 4_800],
    texts: ["Erlöse laut Rechnung", "Sonstige Erlöse"],
    document: "AR"
  },
  {
    weight: 12,
    account: "goods19",
    contras: ["payables"],
    side: "S",
    vatKeys: [0],
    euros: [40, 7_500],
    texts: ["Wareneinkauf", "Eingangsrechnung Ware", "Materiallieferung"],
    document: "ER"
  },
  {
    weight: 3,
    account: "goods7",
    contras: ["payables"],
    side: "S",
    vatKeys: [0],
    euros: [20, 2_400],
    texts: ["Wareneinkauf ermäßigt", "Eingangsrechnung Ware 7 %"],
    document: "ER"
  },
  {
    weight: 2,
    account: "goods",
    contras: ["payables"],
    side: "S",
    vatKeys: [9, 9, 8],
    euros: [40, 7_500],
    texts: ["Wareneinkauf", "Hilfsstoffe"],
    document: "ER"
  },
  {
    weight: 4,
    account: "vehicle",
    contras: ["payables", "bank", "cash"],
    side: "S",
    vatKeys: [9],
    euros: [20, 320],
    texts: ["Tankrechnung", "Kraftstoff", "Fahrzeugpflege"],
    document: "ER"
  },
  {
    weight: 1,
    account: "vehicleRepairs",
    contras: ["payables"],
    side: "S",
    vatKeys: [9],
    euros: [80, 2_400],
    texts: ["Werkstattrechnung", "Inspektion", "Reifenwechsel"],
    document: "ER"
  },
  {
    weight: 2,
    account: "advertising",
    contras: ["payables"],
    side: "S",
    vatKeys: [9],
    euros: [50, 3_000],
    texts: ["Anzeigenschaltung", "Druck Werbemittel", "Messestand"],
    document: "ER"
  },
  {
    weight: 2,
    account: "telephone",
    contras: ["payables", "bank"],
    side: "S",
    vatKeys: [9],
    euros: [20, 260],
    texts: ["Telefon und Internet", "Mobilfunk"],
    document: "ER"
  },
  {
    weight: 4,
    account: "office",
    contras: ["payables", "cash"],
    side: "S",
    vatKeys: [9],
    euros: [5, 380],
    texts: ["Büromaterial", "Druckerpapier und Toner", "Ordner und Stifte"],
    document: "ER"
  },
  {
    weight: 1.5,
    account: "legal",
    contras: ["payables"],
    side: "S",
    vatKeys: [9],
    euros: [150, 3_500],
    texts: ["Steuerberatung", "Rechtsberatung", "Jahresabschlusskosten"],
    document: "ER"
  },
  {
    weight: 1.5,
    account: "utilities",
    contras: ["payables", "bank"],
    side: "S",
    vatKeys: [9],
    euros: [60, 1_400],
    texts: ["Stromabschlag", "Gasabschlag", "Wasser und Abwasser"],
    document: "ER"
  },
  {
    weight: 2,
    account: "hospitality",
    contras: ["cash", "bank"],
    side: "S",
    vatKeys: [9],
    euros: [18, 320],
    texts: ["Bewirtung Geschäftspartner", "Geschäftsessen"],
    document: "KB"
  },
  {
    weight: 2,
    account: "travel",
    contras: ["cash", "bank", "payables"],
    side: "S",
    vatKeys: [9, 8, 0],
    euros: [12, 640],
    texts: ["Hotelübernachtung", "Bahnfahrt", "Reisekostenabrechnung"],
    document: "RK"
  },
  {
    weight: 1,
    account: "books",
    contras: ["payables", "cash"],
    side: "S",
    vatKeys: [8],
    euros: [8, 180],
    texts: ["Fachzeitschrift", "Fachbuch"],
    document: "ER"
  },
  {
    weight: 1,
    account: "postage",
    contras: ["cash", "bank"],
    side: "S",
    vatKeys: [0],
    euros: [2, 90],
    texts: ["Porto", "Paketversand"],
    document: "KB"
  },
  {
    weight: 1,
    account: "insurance",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [40, 1_800],
    texts: ["Betriebshaftpflicht", "Kfz-Versicherung", "Inhaltsversicherung"],
    document: "VS"
  },
  {
    weight: 4,
    account: "wages",
    contras: ["wagePayables"],
    side: "S",
    vatKeys: [0],
    euros: [1_800, 6_200],
    texts: ["Gehalt", "Lohn und Gehalt"],
    document: "LG"
  },
  {
    weight: 2,
    account: "socialSecurity",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [400, 2_600],
    texts: ["Sozialversicherungsbeiträge", "Krankenkassenbeitrag"],
    document: "LG"
  },
  {
    weight: 1.5,
    account: "rent",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [600, 4_500],
    roundingUnitEuros: 50,
    texts: ["Miete Geschäftsräume", "Miete Lager"],
    document: "DA"
  },
  {
    weight: 2,
    account: "bankFees",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [2, 60],
    texts: ["Kontoführungsgebühr", "Buchungspostenentgelt"],
    document: null
  },
  {
    weight: 9,
    account: "bank",
    contras: ["receivables"],
    side: "S",
    vatKeys: [0],
    euros: [15, 4_800],
    texts: ["Zahlungseingang Kunde", "Überweisung Kunde"],
    document: "KA"
  },
  {
    weight: 7,
    account: "payables",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [40, 7_500],
    texts: ["Zahlung Lieferant", "Überweisung Lieferantenrechnung"],
    document: "KA"
  },
  {
    weight: 2,
    account: "wagePayables",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [1_800, 6_200],
    texts: ["Gehaltszahlung"],
    document: "KA"
  },
  {
    weight: 1,
    account: "cashTransit",
    contras: ["bank"],
    side: "S",
    vatKeys: [0],
    euros: [500, 5_000],
    roundingUnitEuros: 100,
    texts: ["Bargeldabhebung", "Bareinzahlung Bank"],
    document: "KA"
  }
];
const TEMPLATE_WEIGHT = TEMPLATES.reduce((sum, template) => sum + template.weight, 0);

/** What one booking says, before it is written as a row. */
interface Booking {
  account: Account;
  contra: Account;
  side: Posting["debit_credit_indicator"];
  vatKey: number;
  cents: number;
  text: string;
  /** Empty for a booking without a document. */
  document: string;
  generalReversal: boolean;
  costCentre: string;
}

interface Month {
  seed: number;
  client: SampleClient;
  period: SampleMonth;
  count: number;
  ledger: Ledger;
  dayEnds: readonly number[];
  /** The places of the planted bookings and the rule each one breaks. */
  planted: ReadonlyMap<number, AccountingRuleId>;
  /** How many planted bookings at the start of the month are dated before it. */
  early: number;
  /** How many planted bookings at the end of the month are dated after it. */
  late: number;
}

type Random = () => number;

function drawn<T>(items: readonly T[], random: Random): T {
  return pick(items, Math.floor(random() * items.length));
}

/** An amount in cents, spread evenly over the orders of magnitude between the bounds. */
function amountCents(random: Random, [minimum, maximum]: Template["euros"], unitEuros = 0.01) {
  const euros = minimum * Math.pow(maximum / minimum, random());
  return Math.max(1, Math.round(euros / unitEuros)) * Math.round(unitEuros * 100);
}

/** The day of the month, from 0, of the booking at `index`. It never falls as `index` rises. */
function dayOf(month: Month, index: number): number {
  const place = (index + 0.5) / month.count;
  const day = month.dayEnds.findIndex((end) => place < end);
  return day === -1 ? month.dayEnds.length - 1 : day;
}

/** The date of the booking at `index`: its day, or a day outside the month where the plan says so. */
function dateOf(month: Month, index: number): string {
  if (index < month.early) {
    return isoDate(month.period, -1 - Math.min(OUTSIDE_DAYS - 1, month.early - 1 - index));
  }
  const firstLate = month.count - month.late;
  if (index >= firstLate) {
    return isoDate(month.period, month.period.days + Math.min(OUTSIDE_DAYS - 1, index - firstLate));
  }
  return isoDate(month.period, dayOf(month, index));
}

function documentNumber({ period }: Month, index: number, prefix: string): string {
  const yearAndMonth = `${String(period.year).slice(2)}${String(period.month).padStart(2, "0")}`;
  return `${prefix}${yearAndMonth}-${String(index + 1).padStart(6, "0")}`;
}

/** The cost centre an account's booking carries: one of the client's for an expense, else none. */
function costCentreOf({ client }: Month, account: Account, random: Random): string {
  return account.account_class === "expense" && client.costCentres.length > 0
    ? drawn(client.costCentres, random)
    : "";
}

function cleanBooking(month: Month, index: number, random: Random): Booking {
  let ticket = random() * TEMPLATE_WEIGHT;
  const template =
    TEMPLATES.find((candidate) => (ticket -= candidate.weight) < 0) ?? pick(TEMPLATES, 0);
  const account = month.ledger[template.account];
  const reversed =
    account.account_class === "expense" &&
    template.document !== null &&
    random() < GENERAL_REVERSAL_SHARE;
  const text = drawn(template.texts, random);
  return {
    account,
    contra: month.ledger[drawn(template.contras, random)],
    side: reversed ? "H" : template.side,
    vatKey: drawn(template.vatKeys, random),
    cents: amountCents(random, template.euros, template.roundingUnitEuros),
    text: reversed ? `Storno ${text}` : text,
    document: template.document === null ? "" : documentNumber(month, index, template.document),
    generalReversal: reversed,
    costCentre: costCentreOf(month, account, random)
  };
}

/** A booking that breaks `rule` and no other: an ordinary expense invoice with one thing wrong. */
function plantedBooking(
  month: Month,
  index: number,
  rule: Exclude<AccountingRuleId, "duplicate-posting" | "date-outside-month">,
  random: Random
): Booking {
  const { ledger } = month;
  const invoice: Booking = {
    account: ledger.office,
    contra: ledger.payables,
    side: "S",
    vatKey: 9,
    cents: amountCents(random, [20, 900]),
    text: "Eingangsrechnung",
    document: documentNumber(month, index, "ER"),
    generalReversal: false,
    costCentre: costCentreOf(month, ledger.office, random)
  };
  switch (rule) {
    case "vat-key-account-mismatch": {
      const { inputVatKeys, vatKeys } = ACCOUNTING_RULES[rule].parameters;
      return random() < 0.5
        ? { ...invoice, vatKey: drawn(vatKeys, random) }
        : {
            ...invoice,
            account: ledger.revenue,
            contra: ledger.receivables,
            side: "H",
            vatKey: drawn(inputVatKeys, random),
            text: "Erlöse laut Rechnung",
            document: documentNumber(month, index, "AR"),
            costCentre: ""
          };
    }
    case "blocked-account":
      return random() < 0.5
        ? { ...invoice, account: ledger.otherExpenses, text: "Sonstiger Aufwand" }
        : { ...invoice, contra: ledger.clearing, text: "Auslage" };
    case "round-amount-no-document": {
      const { thresholdEuros, roundingUnitEuros } = ACCOUNTING_RULES[rule].parameters;
      return {
        ...invoice,
        account: ledger.legal,
        contra: ledger.bank,
        vatKey: 0,
        cents: amountCents(random, [thresholdEuros, 8 * thresholdEuros], roundingUnitEuros),
        text: "Abschlagszahlung",
        document: ""
      };
    }
    case "expense-in-credit":
      return { ...invoice, side: "H" };
    case "missing-cost-centre":
      return { ...invoice, costCentre: "" };
  }
}

function posting(month: Month, index: number): Posting {
  const rule = month.planted.get(index);
  // A duplicate is the booking before it, word for word. The plan keeps that one clean.
  if (rule === "duplicate-posting") return posting(month, index - 1);
  const { client } = month;
  const random = seededGenerator(
    mixedSeed(month.seed, STREAM.posting, client.row.client_id, month.period.index, index)
  );
  const booking =
    rule === undefined || rule === "date-outside-month"
      ? cleanBooking(month, index, random)
      : plantedBooking(month, index, rule, random);
  const date = dateOf(month, index);
  const automaticKey = booking.account.automatic_vat_key;
  const rate = vatRate(automaticKey ?? booking.vatKey);
  const taxCents = Math.round((booking.cents * rate) / (100 + rate));
  return {
    client_id: client.row.client_id,
    date,
    delivery_date: booking.account.account_class === "revenue" ? date : null,
    document_date: date,
    fiscal_year: fiscalYearOf(client, month.period),
    account_number: booking.account.account_number,
    contra_account_number: booking.contra.account_number,
    posting_description:
      booking.document === "" ? `${booking.text} Pos. ${index + 1}` : booking.text,
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
    record_type: "posting",
    accounting_transaction_key: automaticKey === null ? booking.vatKey : 0,
    general_reversal: booking.generalReversal ? 1 : 0,
    follow_up_index: 0,
    follow_up_type: "",
    gross_net_indicator: "B",
    document_link: "",
    kost1: booking.costCentre,
    kost2: "",
    capitalisation_number: month.period.index < LOCKED_MONTHS ? month.period.index + 1 : 0
  };
}

/**
 * Where the month's planted bookings lie. It costs time in proportion to their number. A
 * booking dated outside the month lies at the month's start or end, where its date keeps the
 * order. Every other one takes a free place, and a duplicate also keeps the place before it
 * free, so that it copies a clean booking and with it that booking's date.
 */
function plan(month: Pick<Month, "seed" | "client" | "period" | "count">) {
  const { count, client } = month;
  const random = seededGenerator(
    mixedSeed(month.seed, STREAM.plan, client.row.client_id, month.period.index)
  );
  const findingCount = () =>
    random() < RULE_PRESENCE
      ? 1 + Math.floor(random() * (2 + count / POSTINGS_PER_FURTHER_FINDING))
      : 0;
  const planted = new Map<number, AccountingRuleId>();
  const originals = new Set<number>();
  const free = (index: number) => !planted.has(index) && !originals.has(index);

  const outside = findingCount();
  const early = Math.ceil(outside / 2);
  const late = outside - early;
  for (let index = 0; index < early; index += 1) planted.set(index, "date-outside-month");
  for (let index = count - late; index < count; index += 1) {
    planted.set(index, "date-outside-month");
  }

  /** Ends, because the planted bookings are a small share of even the smallest month. */
  function place(rule: AccountingRuleId) {
    for (let remaining = findingCount(); remaining > 0;) {
      const index = early + Math.floor(random() * (count - early - late));
      if (!free(index)) continue;
      if (rule === "duplicate-posting") {
        const original = index - 1;
        if (original < early || !free(original)) continue;
        originals.add(original);
      }
      planted.set(index, rule);
      remaining -= 1;
    }
  }
  place("duplicate-posting");
  place("vat-key-account-mismatch");
  place("blocked-account");
  place("round-amount-no-document");
  place("expense-in-credit");
  if (client.costCentres.length > 0) place("missing-cost-centre");
  return { planted, early, late };
}

/** One client's month: how many bookings it has, what was planted, and any run of its rows. */
export function monthOfPostings(seed: number, client: SampleClient, period: SampleMonth) {
  const frame = {
    seed,
    client,
    period,
    count: postingCount(seed, client, period),
    ledger: LEDGERS[client.skr],
    dayEnds: dayEnds(period)
  };
  const month: Month = { ...frame, ...plan(frame) };
  return {
    count: month.count,
    /** How many bookings break each rule, counted from the plan and not by reading the rows. */
    expectedFindings(): Record<AccountingRuleId, number> {
      const findings: Record<AccountingRuleId, number> = {
        "duplicate-posting": 0,
        "vat-key-account-mismatch": 0,
        "blocked-account": 0,
        "round-amount-no-document": 0,
        "date-outside-month": 0,
        "expense-in-credit": 0,
        "missing-cost-centre": 0
      };
      for (const rule of month.planted.values()) findings[rule] += 1;
      return findings;
    },
    /** The bookings from `offset` on, at most `limit` of them, in the month's order. */
    rows(offset: number, limit: number): Posting[] {
      const length = Math.max(0, Math.min(limit, month.count - offset));
      return Array.from({ length }, (_, index) => posting(month, offset + index));
    }
  };
}
