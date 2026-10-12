import { mixedSeed, pick, seededGenerator } from "../random.js";
import type { Skr } from "./accounts.js";
import { business, type Business } from "./business.js";
import { compactDate, FIRST_MONTH, type SampleMonth } from "./calendar.js";
import { INDUSTRIES, PROFILES, SIZE_NAMES, type Industry, type Profile } from "./profiles.js";

// The clients (Mandanten) of one invented tax consultancy: who they are, how they keep their
// books and how many bookings each has in a month. The list is the one of a real firm: mostly
// sole traders and freelancers, then partnerships and small companies, a few large ones. Every
// name is built from invented words.

type SizeName = (typeof SIZE_NAMES)[number];

/** The bounds of a month's ledger by size. A client's count stays inside them in every month. */
const SIZE_BOUNDS: Readonly<Record<SizeName, { minimum: number; maximum: number }>> = {
  micro: { minimum: 50, maximum: 250 },
  small: { minimum: 300, maximum: 4_000 },
  medium: { minimum: 10_000, maximum: 60_000 },
  large: { minimum: 100_000, maximum: 100_000 }
};

interface LegalForm {
  name: string;
  /** The owner draws the profit and no wage: a sole trader, a freelancer, a partner. */
  ownerRun: boolean;
  /** How many clients of the form have a ledger of each size. Volume follows the form. */
  clients: Readonly<Partial<Record<SizeName, number>>>;
  /** How likely each industry is for a client of the form. */
  industries: Readonly<Partial<Record<Industry, number>>>;
  /** The client's name out of its two invented words and the trade of its industry. */
  title(first: string, second: string, trade: string): string;
}

const tradeAndPerson = (first: string, second: string, trade: string) =>
  `${trade} ${second} ${first}`;
const company = (suffix: string) => (first: string, second: string, trade: string) =>
  `${first} ${second} ${trade} ${suffix}`;

/** The legal forms of the clients, the most frequent first. The README shows this table. */
const LEGAL_FORMS: readonly LegalForm[] = [
  {
    name: "Einzelunternehmen",
    ownerRun: true,
    clients: { micro: 130, small: 20 },
    industries: { crafts: 40, retail: 25, restaurant: 25, propertyManagement: 5, consulting: 5 },
    title: tradeAndPerson
  },
  {
    name: "Freiberufler",
    ownerRun: true,
    clients: { micro: 115, small: 10 },
    industries: { freelancer: 55, medicalPractice: 30, consulting: 15 },
    title: tradeAndPerson
  },
  {
    name: "GmbH",
    ownerRun: false,
    clients: { small: 70, medium: 37, large: 3 },
    industries: {
      retail: 22,
      manufacturing: 22,
      crafts: 18,
      consulting: 16,
      propertyManagement: 9,
      restaurant: 8,
      medicalPractice: 5
    },
    title: company("GmbH")
  },
  {
    name: "GbR",
    ownerRun: true,
    clients: { micro: 50, small: 20 },
    industries: {
      propertyManagement: 30,
      medicalPractice: 20,
      freelancer: 20,
      crafts: 15,
      restaurant: 10,
      consulting: 5
    },
    title: (first, second, trade) => `${trade} ${first} & ${second} GbR`
  },
  {
    name: "e. K.",
    ownerRun: true,
    clients: { micro: 25, small: 40 },
    industries: { retail: 55, crafts: 15, restaurant: 15, manufacturing: 10, consulting: 5 },
    title: company("e. K.")
  },
  {
    name: "GmbH & Co. KG",
    ownerRun: false,
    clients: { small: 12, medium: 30, large: 3 },
    industries: { manufacturing: 40, retail: 30, propertyManagement: 20, crafts: 10 },
    title: company("GmbH & Co. KG")
  },
  {
    name: "UG (haftungsbeschränkt)",
    ownerRun: false,
    clients: { micro: 15, small: 10 },
    industries: { consulting: 35, retail: 30, crafts: 20, restaurant: 15 },
    title: company("UG (haftungsbeschränkt)")
  },
  {
    name: "AG",
    ownerRun: false,
    clients: { medium: 5, large: 2 },
    industries: { manufacturing: 60, retail: 40 },
    title: company("AG")
  },
  {
    name: "eG",
    ownerRun: false,
    clients: { small: 2, medium: 1 },
    industries: { propertyManagement: 60, retail: 40 },
    title: company("eG")
  }
];

/** How the clients spread over the sizes of a month's ledger. The README shows this table. */
export const SIZE_GROUPS = SIZE_NAMES.map((name) => ({
  name,
  clients: LEGAL_FORMS.reduce((sum, form) => sum + (form.clients[name] ?? 0), 0),
  ...SIZE_BOUNDS[name]
}));
type SizeGroup = (typeof SIZE_GROUPS)[number];

/** How far a month's count may lie from the client's usual count, as a share of it. */
const MONTHLY_VARIATION = 0.08;
/** The share of clients with a fiscal year that does not start in January. */
const DEVIATING_FISCAL_YEAR_SHARE = 0.08;
const DEVIATING_START_MONTHS = [4, 7, 10];
const COST_CENTRES = ["100", "200", "300", "400", "500"];
/** The share of clients of each size that book with cost centres. */
const COST_CENTRE_SHARE: Readonly<Record<SizeName, number>> = {
  micro: 0.03,
  small: 0.2,
  medium: 0.6,
  large: 0.9
};
const CONSULTANT_NUMBER = 2_906_417;
const FIRST_CLIENT_ID = 1001;
const DAY_MS = 86_400_000;
/** The first day a client may have come to the consultancy, and how many days the last may lie after it. */
const FIRST_MANDATE_DAY = Date.UTC(2004, 0, 1, 8);
const MANDATE_DAYS = 7_000;

/** What separates the draws of one seed, so that no two kinds of data share a sequence. */
export const STREAM = {
  order: 1,
  client: 2,
  postingCount: 3,
  findings: 4,
  plan: 5,
  booking: 6,
  evenDraw: 7,
  schedule: 8,
  documentLink: 9
} as const;

const FIRST_WORDS = [
  "Aldurvek",
  "Benmorit",
  "Calvuneth",
  "Dornavil",
  "Elmurask",
  "Farnubel",
  "Gelvoran",
  "Halmudin",
  "Ilvareth",
  "Jorvanek",
  "Kelmurod",
  "Lanvurik",
  "Mosdarun",
  "Nelvarik",
  "Orlumeth",
  "Pravunel",
  "Quendaril",
  "Rasmolin",
  "Selvudar",
  "Talmerok",
  "Ulvaneth",
  "Varmolik",
  "Welduran",
  "Xanvirol",
  "Yelmarun",
  "Zorvaleth",
  "Brimvolan",
  "Crestunav",
  "Dulmerith",
  "Eskvaron"
];
const SECOND_WORDS = [
  "Arvendo",
  "Bulmera",
  "Cendruvi",
  "Dalvumi",
  "Erkolan",
  "Fimbura",
  "Golvane",
  "Hirmeto",
  "Ilduvan",
  "Jelmora",
  "Kurvelo",
  "Lomvari",
  "Mertulo",
  "Nalvike",
  "Orbenu",
  "Pelkura",
  "Rumvelo",
  "Sildano",
  "Tervumi",
  "Ulkaren"
];

export interface ClientRow {
  client_id: number;
  master_client_id: string;
  client_number: number;
  company_id: string;
  name: string;
  created_at: string;
}

export interface FiscalYearRow {
  client_id: number;
  fiscal_year: number;
  year: number;
  fiscal_year_start: number;
  fiscal_year_end: number;
  name: string;
  company_name: string;
  client_name: string;
  national_law: string;
  base_currency: string;
  skr: Skr;
  account_length: number;
  size_class_code: number;
  consultant_number: number;
  client_number: number;
  inactive: 0 | 1;
}

export interface SampleClient {
  row: ClientRow;
  legalForm: string;
  industry: Industry;
  skr: Skr;
  /** 1 to 12. */
  fiscalYearStartMonth: number;
  /** Empty for a client that books without cost centres. */
  costCentres: readonly string[];
  size: SizeGroup;
  /** The count of a month before its variation. */
  usualPostingCount: number;
  business: Business;
}

type Random = () => number;

/** `items` in an order the draws decide. */
function inSeededOrder<T>(items: readonly T[], random: Random): T[] {
  const ordered = [...items];
  for (let last = ordered.length - 1; last > 0; last -= 1) {
    const other = Math.floor(random() * (last + 1));
    const moved = pick(ordered, last);
    ordered[last] = pick(ordered, other);
    ordered[other] = moved;
  }
  return ordered;
}

/** One of the form's industries that produce a ledger of the size, by the form's weights. */
function industryOf(form: LegalForm, size: SizeName, random: Random): Industry {
  const candidates = INDUSTRIES.filter((industry) => {
    const sizes: readonly SizeName[] = PROFILES[industry].sizes;
    return form.industries[industry] !== undefined && sizes.includes(size);
  });
  const weightOf = (industry: Industry) => form.industries[industry] ?? 0;
  let ticket = random() * candidates.reduce((sum, industry) => sum + weightOf(industry), 0);
  return (
    candidates.find((industry) => (ticket -= weightOf(industry)) < 0) ??
    pick(candidates, candidates.length - 1)
  );
}

export function createClients(seed: number): SampleClient[] {
  const order = seededGenerator(mixedSeed(seed, STREAM.order));
  // The seed decides which client has which form and size, and which pair of words. Each
  // pair occurs once, so every name is distinct, and the names follow no alphabet.
  const places = inSeededOrder(
    LEGAL_FORMS.flatMap((form) =>
      SIZE_GROUPS.flatMap((size) =>
        Array.from({ length: form.clients[size.name] ?? 0 }, () => ({ form, size }))
      )
    ),
    order
  );
  const wordPairs = inSeededOrder(
    places.map((_, index) => index),
    order
  );
  return places.map(({ form, size }, index) => {
    const random = seededGenerator(mixedSeed(seed, STREAM.client, index));
    const number = String(index + 1).padStart(4, "0");
    const industry = industryOf(form, size.name, random);
    const profile: Profile = PROFILES[industry];
    const wordPair = pick(wordPairs, index);
    const client_id = FIRST_CLIENT_ID + index;
    // Spread evenly over the orders of magnitude of the size, so small ledgers are common.
    const usualPostingCount = Math.round(
      size.minimum * Math.pow(size.maximum / size.minimum, random())
    );
    return {
      row: {
        client_id,
        master_client_id: `MC-${number}`,
        client_number: 10_000 + (index + 1) * 10,
        company_id: `CO-${number}`,
        name: form.title(
          pick(FIRST_WORDS, wordPair),
          pick(SECOND_WORDS, Math.floor(wordPair / FIRST_WORDS.length)),
          pick(profile.trades, Math.floor(random() * profile.trades.length))
        ),
        created_at: new Date(
          FIRST_MANDATE_DAY + Math.floor(random() * MANDATE_DAYS) * DAY_MS
        ).toISOString()
      },
      legalForm: form.name,
      industry,
      skr: random() < 0.6 ? 3 : 4,
      fiscalYearStartMonth:
        random() < DEVIATING_FISCAL_YEAR_SHARE
          ? pick(DEVIATING_START_MONTHS, Math.floor(random() * DEVIATING_START_MONTHS.length))
          : 1,
      costCentres:
        random() < COST_CENTRE_SHARE[size.name]
          ? COST_CENTRES.slice(0, 2 + Math.floor(random() * (COST_CENTRES.length - 1)))
          : [],
      size,
      usualPostingCount,
      business: business(profile, form.ownerRun, usualPostingCount, random)
    };
  });
}

/** How many bookings the client has in a month. `monthIndex` counts from the first month of the range. */
export function postingCount(seed: number, client: SampleClient, monthIndex: number): number {
  const random = seededGenerator(
    mixedSeed(seed, STREAM.postingCount, client.row.client_id, monthIndex)
  );
  const varied = client.usualPostingCount * (1 + MONTHLY_VARIATION * (2 * random() - 1));
  return Math.min(client.size.maximum, Math.max(client.size.minimum, Math.round(varied)));
}

/** The start of the fiscal year the month belongs to, as `YYYYMMDD`. */
export function fiscalYearOf(client: SampleClient, month: SampleMonth): string {
  const startYear = month.month >= client.fiscalYearStartMonth ? month.year : month.year - 1;
  return compactDate(startYear, client.fiscalYearStartMonth, 1);
}

/** The client's fiscal years that hold a month of the sample's range, which ends with `lastMonth`, oldest first. */
export function fiscalYears(client: SampleClient, lastMonth: SampleMonth): FiscalYearRow[] {
  const startMonth = client.fiscalYearStartMonth;
  const firstYear = Number(FIRST_MONTH.slice(0, 4)) - (startMonth === 1 ? 0 : 1);
  const lastYear = Number(fiscalYearOf(client, lastMonth).slice(0, 4));
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => {
    const year = firstYear + index;
    const start = Number(compactDate(year, startMonth, 1));
    // Day 0 of the start month of the next year is the last day of the month before it.
    const end = new Date(Date.UTC(year + 1, startMonth - 1, 0));
    return {
      client_id: client.row.client_id,
      fiscal_year: start,
      year,
      fiscal_year_start: start,
      fiscal_year_end: Number(
        compactDate(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())
      ),
      name: client.row.name,
      company_name: client.row.name,
      client_name: client.row.name,
      national_law: "HGB",
      base_currency: "EUR",
      skr: client.skr,
      account_length: 4,
      size_class_code: 2 + SIZE_GROUPS.indexOf(client.size),
      consultant_number: CONSULTANT_NUMBER,
      client_number: client.row.client_number,
      inactive: 0
    };
  });
}
