import { mixedSeed, pick, seededGenerator } from "../random.js";
import type { Skr } from "./accounts.js";
import { compactDate, FIRST_MONTH, LAST_MONTH, type SampleMonth } from "./calendar.js";

// The clients (Mandanten) of one invented tax consultancy: who they are, how they keep their
// books and how many bookings each has in a month. Every name is built from invented words.

/**
 * How the clients spread over the sizes of a month's ledger. A client's count stays inside
 * its group's bounds in every month. The README shows this table.
 */
export const SIZE_GROUPS = [
  { name: "small", clients: 492, minimum: 200, maximum: 4_000 },
  { name: "medium", clients: 100, minimum: 10_000, maximum: 60_000 },
  { name: "large", clients: 8, minimum: 100_000, maximum: 100_000 }
] as const;
type SizeGroup = (typeof SIZE_GROUPS)[number];

/** How far a month's count may lie from the client's usual count, as a share of it. */
const MONTHLY_VARIATION = 0.08;
/** The share of clients with a fiscal year that does not start in January. */
const DEVIATING_FISCAL_YEAR_SHARE = 0.08;
const DEVIATING_START_MONTHS = [4, 7, 10];
const COST_CENTRES = ["100", "200", "300", "400", "500"];
const CONSULTANT_NUMBER = 2_906_417;
const FIRST_CLIENT_ID = 1001;
const DAY_MS = 86_400_000;

/** What separates the draws of one seed, so that no two kinds of data share a sequence. */
export const STREAM = { sizes: 1, client: 2, postingCount: 3, plan: 4, posting: 5 } as const;

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
const LEGAL_FORMS = [
  "GmbH",
  "GmbH",
  "GmbH",
  "UG (haftungsbeschränkt)",
  "GmbH & Co. KG",
  "KG",
  "OHG",
  "AG",
  "e. K.",
  "eG"
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
  skr: Skr;
  /** 1 to 12. */
  fiscalYearStartMonth: number;
  /** Empty for a client that books without cost centres. */
  costCentres: readonly string[];
  size: SizeGroup;
  /** The count of a month before its variation. */
  usualPostingCount: number;
}

/** Each client's size group, in the order of the clients. The seed decides who is large. */
function sizes(seed: number): SizeGroup[] {
  const random = seededGenerator(mixedSeed(seed, STREAM.sizes));
  const groups = SIZE_GROUPS.flatMap((group) => Array.from({ length: group.clients }, () => group));
  for (let last = groups.length - 1; last > 0; last -= 1) {
    const other = Math.floor(random() * (last + 1));
    const moved = pick(groups, last);
    groups[last] = pick(groups, other);
    groups[other] = moved;
  }
  return groups;
}

export function createClients(seed: number): SampleClient[] {
  return sizes(seed).map((size, index) => {
    const random = seededGenerator(mixedSeed(seed, STREAM.client, index));
    const number = String(index + 1).padStart(4, "0");
    // Each pair of words occurs once, so every name is distinct whatever its legal form.
    const name = [
      pick(FIRST_WORDS, index),
      pick(SECOND_WORDS, Math.floor(index / FIRST_WORDS.length)),
      pick(LEGAL_FORMS, Math.floor(random() * LEGAL_FORMS.length))
    ].join(" ");
    return {
      row: {
        client_id: FIRST_CLIENT_ID + index,
        master_client_id: `MC-${number}`,
        client_number: 10_000 + (index + 1) * 10,
        company_id: `CO-${number}`,
        name,
        created_at: new Date(
          Date.UTC(2012, 0, 1, 8) + Math.floor(random() * 4_000) * DAY_MS
        ).toISOString()
      },
      skr: random() < 0.6 ? 3 : 4,
      fiscalYearStartMonth:
        random() < DEVIATING_FISCAL_YEAR_SHARE
          ? pick(DEVIATING_START_MONTHS, Math.floor(random() * DEVIATING_START_MONTHS.length))
          : 1,
      costCentres:
        random() < (size.name === "small" ? 0.15 : 0.6)
          ? COST_CENTRES.slice(0, 2 + Math.floor(random() * (COST_CENTRES.length - 1)))
          : [],
      size,
      // Spread evenly over the orders of magnitude of the group, so small ledgers are common.
      usualPostingCount: Math.round(size.minimum * Math.pow(size.maximum / size.minimum, random()))
    };
  });
}

/** How many bookings the client has in the month. */
export function postingCount(seed: number, client: SampleClient, month: SampleMonth): number {
  const random = seededGenerator(
    mixedSeed(seed, STREAM.postingCount, client.row.client_id, month.index)
  );
  const varied = client.usualPostingCount * (1 + MONTHLY_VARIATION * (2 * random() - 1));
  return Math.min(client.size.maximum, Math.max(client.size.minimum, Math.round(varied)));
}

/** The start of the fiscal year the month belongs to, as `YYYYMMDD`. */
export function fiscalYearOf(client: SampleClient, month: SampleMonth): string {
  const startYear = month.month >= client.fiscalYearStartMonth ? month.year : month.year - 1;
  return compactDate(startYear, client.fiscalYearStartMonth, 1);
}

/** The client's fiscal years that hold a month of the sample's range, oldest first. */
export function fiscalYears(client: SampleClient): FiscalYearRow[] {
  const startMonth = client.fiscalYearStartMonth;
  const firstYear = Number(FIRST_MONTH.slice(0, 4)) - (startMonth === 1 ? 0 : 1);
  const lastYear = Number(LAST_MONTH.slice(0, 4));
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
