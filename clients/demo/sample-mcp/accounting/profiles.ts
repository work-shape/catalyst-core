import type { AccountRole } from "./accounts.js";
import type { Week } from "./calendar.js";

// What kind of business a client is. A profile says where the revenue comes from, what it is
// spent on and how the year runs, in money: shares of the net revenue and the usual size of one
// booking. How many bookings of each kind a client has follows from that (see business.ts), so
// a client's books add up to a business of its industry whatever its size.

/** How a purchase is paid: on account through the supplier's creditor, by direct debit, or in cash. */
type Settlement = "account" | "bank" | "cash";

interface ExpenseKindFacts {
  account: AccountRole;
  /** The usual net amount of one booking, in euros. */
  euros: number;
  settlement: Settlement;
  /** The BU-Schlüssel of a deductible purchase. An automatic account applies its own. */
  vatKey: 0 | 8 | 9;
  /** Rises and falls with the revenue over the year, as goods do and a telephone bill does not. */
  seasonal: boolean;
  /** What a supplier of it is called after its invented name. */
  trades: readonly string[];
}

const KINDS = [
  {
    account: "goods19",
    euros: 1_400,
    settlement: "account",
    vatKey: 0,
    seasonal: true,
    trades: ["Großhandel", "Handelskontor", "Warenvertrieb"]
  },
  {
    account: "goods7",
    euros: 620,
    settlement: "account",
    vatKey: 0,
    seasonal: true,
    trades: ["Lebensmittelgroßhandel", "Frischdienst", "Feinkostvertrieb"]
  },
  {
    account: "goods",
    euros: 900,
    settlement: "account",
    vatKey: 9,
    seasonal: true,
    trades: ["Baustoffe", "Werkstoffhandel", "Industriebedarf"]
  },
  {
    account: "subcontractors",
    euros: 2_800,
    settlement: "account",
    vatKey: 9,
    seasonal: true,
    trades: ["Montageservice", "Ingenieurbüro", "Dienstleistungen"]
  },
  {
    account: "supplies",
    euros: 320,
    settlement: "account",
    vatKey: 9,
    seasonal: true,
    trades: ["Praxisbedarf", "Laborbedarf", "Betriebsbedarf"]
  },
  {
    account: "tools",
    euros: 180,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Werkzeughandel", "Eisenwaren"]
  },
  {
    account: "machineRepairs",
    euros: 950,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Maschinenservice", "Anlagentechnik"]
  },
  {
    account: "premisesRepairs",
    euros: 700,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Haustechnik", "Malerbetrieb", "Sanitärtechnik"]
  },
  {
    account: "cleaning",
    euros: 380,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Gebäudereinigung", "Reinigungsservice"]
  },
  {
    account: "vehicleRepairs",
    euros: 650,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Kfz-Werkstatt", "Autohaus"]
  },
  {
    account: "advertising",
    euros: 480,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Werbeagentur", "Druckerei", "Medienhaus"]
  },
  {
    account: "office",
    euros: 70,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Bürobedarf", "Bürotechnik"]
  },
  {
    account: "legal",
    euros: 900,
    settlement: "account",
    vatKey: 9,
    seasonal: false,
    trades: ["Steuerberatung", "Rechtsanwälte", "Wirtschaftsprüfung"]
  },
  {
    account: "books",
    euros: 60,
    settlement: "account",
    vatKey: 8,
    seasonal: false,
    trades: ["Fachverlag", "Buchhandlung"]
  },
  {
    account: "utilities",
    euros: 520,
    settlement: "bank",
    vatKey: 9,
    seasonal: false,
    trades: ["Stadtwerke", "Energieversorgung"]
  },
  {
    account: "telephone",
    euros: 95,
    settlement: "bank",
    vatKey: 9,
    seasonal: false,
    trades: ["Telekommunikation", "Netzdienste"]
  },
  {
    account: "insurance",
    euros: 310,
    settlement: "bank",
    vatKey: 0,
    seasonal: false,
    trades: ["Versicherung", "Versicherungsmakler"]
  },
  {
    account: "licences",
    euros: 45,
    settlement: "bank",
    vatKey: 9,
    seasonal: false,
    trades: ["Softwarehaus", "Datendienste"]
  },
  {
    account: "vehicle",
    euros: 85,
    settlement: "bank",
    vatKey: 9,
    seasonal: false,
    trades: ["Tankstelle", "Autohof"]
  },
  {
    account: "travel",
    euros: 210,
    settlement: "bank",
    vatKey: 8,
    seasonal: false,
    trades: ["Hotel", "Gästehaus"]
  },
  {
    account: "hospitality",
    euros: 95,
    settlement: "cash",
    vatKey: 9,
    seasonal: false,
    trades: ["Gasthaus", "Bistro"]
  },
  {
    account: "postage",
    euros: 28,
    settlement: "cash",
    vatKey: 0,
    seasonal: false,
    trades: ["Postagentur", "Kurierdienst"]
  }
] as const satisfies readonly ExpenseKindFacts[];

type ExpenseRole = (typeof KINDS)[number]["account"];
export type ExpenseKind = ExpenseKindFacts & { account: ExpenseRole };

/** The purchases of the sample, each booked on the account it names. */
export const EXPENSE_KINDS: readonly ExpenseKind[] = KINDS;

/** One revenue account of a profile and the share of the revenue of its channel booked on it. */
interface RevenueLine {
  account: AccountRole;
  share: number;
  /** The BU-Schlüssel of a booking on an account that applies none by itself. */
  vatKey: 0 | 2 | 3;
}

interface RevenueChannel {
  /** The usual net amount of one booking, in euros. */
  euros: number;
  /** The lines of a year. The tax law of a year decides them where an industry's rate changed. */
  lines(year: number): readonly RevenueLine[];
}

export const SIZE_NAMES = ["micro", "small", "medium", "large"] as const;
type SizeName = (typeof SIZE_NAMES)[number];

/** The bounds of a margin: the profit as a share of the net revenue. */
type MarginRange = readonly [lowest: number, highest: number];

export interface Profile {
  /** What a client of the industry is called after its invented name. */
  trades: readonly string[];
  /** What it rents to work in. */
  premises: string;
  /** The sizes of a month's ledger the industry produces. */
  sizes: readonly SizeName[];
  /** What is invoiced to a customer and paid later. */
  invoices: RevenueChannel & {
    /** Customers are private people, named as a debtor list names them. */
    privateCustomers: boolean;
    /** Every customer is invoiced once a month with the same amount, as a tenant is. */
    rentRoll: boolean;
  };
  /**
   * What goes through the till, `null` without one: its share of the revenue and the week it
   * is open. A till reports once a day it is open, in one booking for each of its lines.
   */
  till: (RevenueChannel & { share: number; week: Week }) | null;
  /** What a year costs, each as a share of the revenue in percent, before the client's margin. */
  costs: Readonly<Partial<Record<ExpenseRole, number>>>;
  payroll: number;
  rent: number;
  /** A gross wage as a multiple of the sample's wage bands. */
  wageLevel: number;
  /**
   * The margin of a profitable client. An owner-run business pays its owner no wage, so its
   * profit is the owner's income and its margin is higher than a company's.
   */
  margin: { company: MarginRange; ownerRun: MarginRange };
  /** The revenue of each month of the year, January first, as a multiple of the usual month. */
  season: readonly number[];
  /** The share of purchases whose input VAT the client may deduct. */
  inputVatShare: number;
}

const taxed19 = (): readonly RevenueLine[] => [{ account: "revenue19", share: 1, vatKey: 0 }];
const ownKey19 = (): readonly RevenueLine[] => [
  { account: "revenue", share: 0.7, vatKey: 3 },
  { account: "revenue19", share: 0.3, vatKey: 0 }
];

const EVEN_YEAR = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const OFFICE_YEAR = [0.95, 1, 1.05, 1, 1, 1.05, 0.95, 0.8, 1.05, 1.1, 1.1, 0.95];

export const INDUSTRIES = [
  "retail",
  "crafts",
  "restaurant",
  "medicalPractice",
  "propertyManagement",
  "consulting",
  "manufacturing",
  "freelancer"
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const PROFILES = {
  retail: {
    trades: ["Fachhandel", "Fachmarkt", "Feinkost", "Versandhandel"],
    premises: "Ladenlokal",
    sizes: ["micro", "small", "medium", "large"],
    invoices: {
      euros: 420,
      lines: () => [
        { account: "revenue19", share: 0.8, vatKey: 0 },
        { account: "revenue7", share: 0.2, vatKey: 0 }
      ],
      privateCustomers: false,
      rentRoll: false
    },
    till: {
      share: 0.6,
      euros: 450,
      lines: () => [
        { account: "revenue19", share: 0.75, vatKey: 0 },
        { account: "revenue7", share: 0.25, vatKey: 0 }
      ],
      // A shop is closed on Sundays and public holidays, and Saturday is its best day.
      week: { days: [1, 1, 1, 1, 1.1, 1.4, 0], holiday: 0 }
    },
    costs: {
      goods19: 48,
      goods7: 12,
      advertising: 2.5,
      utilities: 1.5,
      vehicle: 1.2,
      insurance: 0.7,
      legal: 0.8,
      licences: 0.6,
      cleaning: 0.5,
      office: 0.5,
      postage: 0.5,
      telephone: 0.4
    },
    payroll: 16,
    rent: 6,
    wageLevel: 0.85,
    margin: { company: [0.01, 0.07], ownerRun: [0.05, 0.16] },
    season: [0.85, 0.85, 0.95, 1, 1, 0.95, 0.9, 0.9, 1, 1.05, 1.2, 1.35],
    inputVatShare: 1
  },
  crafts: {
    trades: ["Malerbetrieb", "Elektrotechnik", "Tischlerei", "Sanitär und Heizung", "Dachbau"],
    premises: "Werkstatt",
    sizes: ["micro", "small", "medium"],
    invoices: { euros: 2_400, lines: taxed19, privateCustomers: false, rentRoll: false },
    // What is sold over the counter of the workshop, on working days.
    till: {
      share: 0.06,
      euros: 380,
      lines: taxed19,
      week: { days: [1, 1, 1, 1, 1, 0.3, 0], holiday: 0 }
    },
    costs: {
      goods: 22,
      goods19: 8,
      subcontractors: 9,
      vehicle: 3,
      tools: 2.5,
      vehicleRepairs: 1.5,
      insurance: 1.5,
      legal: 1,
      advertising: 1,
      office: 0.5,
      telephone: 0.5,
      licences: 0.3
    },
    payroll: 30,
    rent: 3,
    wageLevel: 1,
    margin: { company: [0.03, 0.1], ownerRun: [0.12, 0.3] },
    season: [0.7, 0.75, 0.95, 1.05, 1.1, 1.15, 1.1, 1, 1.15, 1.15, 1.05, 0.85],
    inputVatShare: 1
  },
  restaurant: {
    trades: ["Gasthaus", "Restaurant", "Wirtshaus", "Bistro"],
    premises: "Gaststätte",
    // One house or a few: a restaurant has no ledger of tens of thousands of bookings a
    // month, which would be the staff of a corporation.
    sizes: ["micro", "small"],
    invoices: { euros: 1_100, lines: taxed19, privateCustomers: false, rentRoll: false },
    till: {
      share: 0.92,
      euros: 750,
      // A day's report has the food and the drinks. Food eaten in the restaurant was taxed at
      // 19 % until the end of 2025 and at 7 % from 2026. Before that only food taken away had
      // the reduced rate. Drinks stay at 19 %.
      lines: (year) =>
        year < 2026
          ? [
              { account: "revenue19", share: 0.8, vatKey: 0 },
              { account: "revenue7", share: 0.2, vatKey: 0 }
            ]
          : [
              { account: "revenue19", share: 0.35, vatKey: 0 },
              { account: "revenue7", share: 0.65, vatKey: 0 }
            ],
      // Open every day, public holidays as well, with the weekend as the best days.
      week: { days: [0.6, 0.8, 0.9, 1, 1.3, 1.6, 1.3], holiday: 1.3 }
    },
    costs: {
      goods7: 22,
      goods19: 9,
      utilities: 4.5,
      supplies: 1.5,
      cleaning: 1.2,
      machineRepairs: 1,
      advertising: 1,
      insurance: 1,
      legal: 1,
      licences: 0.5,
      vehicle: 0.5,
      office: 0.3,
      telephone: 0.3,
      postage: 0.1
    },
    payroll: 33,
    rent: 9,
    wageLevel: 0.75,
    margin: { company: [0.01, 0.07], ownerRun: [0.06, 0.18] },
    season: [0.8, 0.8, 0.9, 1, 1.1, 1.15, 1.15, 1.1, 1.05, 0.95, 0.9, 1.1],
    inputVatShare: 1
  },
  medicalPractice: {
    trades: ["Hausarztpraxis", "Zahnarztpraxis", "Praxis für Physiotherapie", "Facharztpraxis"],
    premises: "Praxisräume",
    sizes: ["micro", "small"],
    invoices: {
      euros: 950,
      // Treatment is exempt under § 4 Nr. 14 UStG. A small part, such as cosmetic services,
      // is taxed.
      lines: () => [
        { account: "revenueExempt", share: 0.96, vatKey: 0 },
        { account: "revenue19", share: 0.04, vatKey: 0 }
      ],
      privateCustomers: true,
      rentRoll: false
    },
    till: null,
    costs: {
      supplies: 6,
      subcontractors: 4,
      office: 2,
      machineRepairs: 1.5,
      vehicle: 1.5,
      insurance: 1.2,
      legal: 1.2,
      cleaning: 1,
      travel: 1,
      licences: 0.8,
      utilities: 0.8,
      telephone: 0.8,
      books: 0.8,
      postage: 0.3
    },
    payroll: 27,
    rent: 5,
    wageLevel: 0.9,
    margin: { company: [0.05, 0.15], ownerRun: [0.28, 0.5] },
    season: [1.05, 1.05, 1.05, 1, 1, 0.95, 0.9, 0.85, 1, 1.05, 1.1, 1],
    inputVatShare: 0.05
  },
  propertyManagement: {
    trades: ["Grundbesitz", "Grundverwaltung", "Wohnbau", "Liegenschaften"],
    premises: "Büro",
    sizes: ["micro", "small"],
    invoices: {
      euros: 820,
      // Letting a flat is exempt under § 4 Nr. 12 UStG. Commercial rent is taxed by option.
      lines: () => [
        { account: "revenueRentExempt", share: 0.82, vatKey: 0 },
        { account: "revenue19", share: 0.18, vatKey: 0 }
      ],
      privateCustomers: true,
      rentRoll: true
    },
    till: null,
    costs: {
      premisesRepairs: 18,
      utilities: 9,
      cleaning: 4,
      insurance: 3,
      legal: 2.5,
      advertising: 0.5,
      licences: 0.5,
      vehicle: 0.5,
      office: 0.4,
      telephone: 0.3,
      postage: 0.3
    },
    payroll: 6,
    rent: 0,
    wageLevel: 1,
    margin: { company: [0.1, 0.28], ownerRun: [0.2, 0.4] },
    season: EVEN_YEAR,
    inputVatShare: 0.18
  },
  consulting: {
    trades: ["Unternehmensberatung", "Consulting", "IT-Beratung", "Personalberatung"],
    premises: "Büro",
    sizes: ["micro", "small", "medium"],
    invoices: { euros: 5_200, lines: ownKey19, privateCustomers: false, rentRoll: false },
    till: null,
    costs: {
      subcontractors: 12,
      travel: 4,
      advertising: 2,
      vehicle: 1.5,
      legal: 1.5,
      hospitality: 1,
      insurance: 1,
      licences: 1,
      telephone: 0.8,
      office: 0.8,
      books: 0.4
    },
    payroll: 48,
    rent: 5,
    wageLevel: 1.5,
    margin: { company: [0.04, 0.14], ownerRun: [0.25, 0.5] },
    season: OFFICE_YEAR,
    inputVatShare: 1
  },
  manufacturing: {
    trades: ["Maschinenbau", "Metallverarbeitung", "Kunststofftechnik", "Gerätebau"],
    premises: "Produktionshalle",
    sizes: ["small", "medium", "large"],
    invoices: {
      euros: 7_800,
      lines: () => [
        { account: "revenue19", share: 0.72, vatKey: 0 },
        { account: "revenueIntraCommunity", share: 0.18, vatKey: 0 },
        { account: "revenueExport", share: 0.1, vatKey: 0 }
      ],
      privateCustomers: false,
      rentRoll: false
    },
    till: null,
    costs: {
      goods19: 38,
      goods: 6,
      subcontractors: 5,
      utilities: 3.5,
      machineRepairs: 3,
      insurance: 1.2,
      tools: 1,
      advertising: 1,
      vehicle: 0.8,
      legal: 0.8,
      travel: 0.6,
      licences: 0.4,
      office: 0.3,
      telephone: 0.2
    },
    payroll: 26,
    rent: 2.5,
    wageLevel: 1.1,
    margin: { company: [0.02, 0.1], ownerRun: [0.08, 0.2] },
    season: OFFICE_YEAR,
    inputVatShare: 1
  },
  freelancer: {
    trades: ["Architekturbüro", "Ingenieurbüro", "Übersetzungsbüro", "Sachverständigenbüro"],
    premises: "Büro",
    sizes: ["micro", "small"],
    invoices: { euros: 2_300, lines: ownKey19, privateCustomers: false, rentRoll: false },
    till: null,
    costs: {
      subcontractors: 6,
      travel: 4,
      vehicle: 3,
      insurance: 2,
      legal: 2,
      telephone: 1.5,
      office: 1.5,
      advertising: 1.5,
      licences: 1.5,
      books: 1.2,
      hospitality: 1
    },
    payroll: 6,
    rent: 6,
    wageLevel: 0.9,
    margin: { company: [0.1, 0.25], ownerRun: [0.35, 0.62] },
    season: OFFICE_YEAR,
    inputVatShare: 1
  }
} as const satisfies Record<Industry, Profile>;
