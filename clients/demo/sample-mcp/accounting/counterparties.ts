import { mixedSeed, pick } from "../random.js";
import { personalAccount, type Account } from "./accounts.js";
import type { Purchase } from "./business.js";
import type { SampleClient } from "./clients.js";
import { EXPENSE_KINDS } from "./profiles.js";

// The customers and suppliers of a client. Each client has its own, they stay the same from
// month to month, and a few of them do most of the business. A counterparty is named by its
// place in the client's list and nothing of it is kept. Every name is an invented word that
// the place decides, so no two counterparties of one list share a name.

const WORD_STARTS = [
  "Vel",
  "Tes",
  "Dor",
  "Kal",
  "Mer",
  "Bro",
  "Fen",
  "Gor",
  "Hal",
  "Jor",
  "Lum",
  "Nar",
  "Ost",
  "Pir",
  "Quen",
  "Ras",
  "Sil",
  "Tor",
  "Ulm",
  "Wen",
  "Zar",
  "Bel",
  "Dun",
  "Erv"
];
const WORD_MIDDLES = ["mo", "sa", "vi", "du", "ne", "ri", "lo", "ka", "tu", "be"];
const WORD_ENDS = [
  "ra",
  "ro",
  "rin",
  "dal",
  "vek",
  "neth",
  "lik",
  "mund",
  "tas",
  "von",
  "rik",
  "sen"
];
const WORD_COUNT = WORD_STARTS.length * WORD_MIDDLES.length * WORD_ENDS.length;
/** Shares no factor with `WORD_COUNT`, so stepping by it meets every word once. */
const WORD_STRIDE = 1_117;
const COMPANY_FORMS = ["GmbH", "GmbH", "KG", "OHG", "e. K.", "GmbH & Co. KG", "AG", "UG"];
const INITIALS = "ABCDEFGHIJKLMNOPRSTUVW";
/** How strongly a client's business gathers at the first counterparties of its list. */
const CONCENTRATION = 2.5;
/** The suppliers of office supplies a client no longer buys from. Their creditors stay in its chart, blocked. */
const FORMER_SUPPLIERS = 3;
/** What tells a client's lists apart, so each starts at its own word. */
const CUSTOMER_LIST = 0;
const FIRST_SUPPLIER_LIST = 1;

export interface Counterparty {
  name: string;
  /** The personal account, or `null` for a supplier that is paid at once. */
  account: Account | null;
  /** What its document numbers are drawn from. */
  key: number;
}

/** The place in a list of `size` counterparties a draw in [0, 1) falls on: the first places most often. */
export function frequentPlace(size: number, draw: number): number {
  return Math.floor(size * Math.pow(draw, CONCENTRATION));
}

function inventedWord(client: SampleClient, list: number, place: number): string {
  const word = (mixedSeed(client.row.client_id, list) + place * WORD_STRIDE) % WORD_COUNT;
  return [
    pick(WORD_STARTS, word),
    pick(WORD_MIDDLES, Math.floor(word / WORD_STARTS.length)),
    pick(WORD_ENDS, Math.floor(word / (WORD_STARTS.length * WORD_MIDDLES.length)))
  ].join("");
}

/** The client's customer at `place` of its customer list, with its debtor account. */
export function customerOf(client: SampleClient, place: number): Counterparty {
  const key = mixedSeed(client.row.client_id, CUSTOMER_LIST, place);
  const word = inventedWord(client, CUSTOMER_LIST, place);
  const name = client.business.profile.invoices.privateCustomers
    ? `${word}, ${INITIALS.charAt(key % INITIALS.length)}.`
    : `${word} ${pick(COMPANY_FORMS, key)}`;
  return { name, account: personalAccount("debtor", place, name), key };
}

/** The supplier at `place` of the list of one kind of purchase, before it has an account. */
function supplierAt(client: SampleClient, { kind }: Purchase, place: number) {
  const list = FIRST_SUPPLIER_LIST + EXPENSE_KINDS.indexOf(kind);
  const key = mixedSeed(client.row.client_id, list, place);
  return { name: `${inventedWord(client, list, place)} ${pick(kind.trades, key)}`, key };
}

/** How many creditors the client has for the first `kinds` kinds of its purchases on account. */
function creditorsOf(client: SampleClient, kinds: number): number {
  return client.business.purchases.onAccount
    .slice(0, kinds)
    .reduce((sum, { suppliers }) => sum + suppliers, 0);
}

/** The client's supplier at `place` among the suppliers of one kind of purchase. */
export function supplierOf(client: SampleClient, purchase: Purchase, place: number): Counterparty {
  const supplier = supplierAt(client, purchase, place);
  if (purchase.kind.settlement !== "account") return { ...supplier, account: null };
  // The creditors are numbered kind after kind in the order of the client's purchases.
  const before = creditorsOf(client, client.business.purchases.onAccount.indexOf(purchase));
  return { ...supplier, account: personalAccount("creditor", before + place, supplier.name) };
}

/**
 * A supplier of office supplies the client no longer buys from, the one a draw in [0, 1)
 * falls on. It stands behind the suppliers of today in the list and in the chart, and its
 * creditor is blocked.
 */
export function formerSupplierOf(client: SampleClient, draw: number): Counterparty {
  const { officePurchase, purchases } = client.business;
  const place = Math.floor(draw * FORMER_SUPPLIERS);
  const supplier = supplierAt(client, officePurchase, officePurchase.suppliers + place);
  const creditor = creditorsOf(client, purchases.onAccount.length) + place;
  return {
    ...supplier,
    account: { ...personalAccount("creditor", creditor, supplier.name), blocked: true }
  };
}

/** Every debtor and creditor account of the client. */
export function personalAccounts(client: SampleClient): Account[] {
  const { customers, purchases } = client.business;
  const counterparties = [
    ...Array.from({ length: customers }, (_, place) => customerOf(client, place)),
    ...purchases.onAccount.flatMap((purchase) =>
      Array.from({ length: purchase.suppliers }, (_, place) => supplierOf(client, purchase, place))
    ),
    ...Array.from({ length: FORMER_SUPPLIERS }, (_, place) =>
      formerSupplierOf(client, place / FORMER_SUPPLIERS)
    )
  ];
  return counterparties.flatMap(({ account }) => (account === null ? [] : [account]));
}
