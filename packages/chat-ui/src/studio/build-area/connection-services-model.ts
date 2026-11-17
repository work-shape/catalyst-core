import type { PersonalConnections } from "@work-shape/catalyst-api-client";
import {
  entriesToShow,
  type CatalogueEntryOffer,
  type CataloguePartName
} from "./connection-catalogue-model";
import { listedOwnServer, ownServerEntryOf, type OwnServerEntry } from "./own-server-model";

// "Dienste" on the Connections page (CAT-PAGE): one card per catalogue entry the reader can act
// on, with what is true of it here. Pure: the page reads the entries, the Connections and the
// reader's own sign-ins, and these decide only what each card says and where its click goes.
// Nothing here grants a right: an install, an add and every sign-in are decided where they
// were before.

type PersonalRow = PersonalConnections["connections"][number];

/** Where a card's click goes. */
export type ServiceCardAction =
  /** The page of a Connection set up from the entry. */
  | { kind: "open"; name: string }
  /** You > Connections, where the reader's own servers are. */
  | { kind: "own-servers" }
  /** The New connection dialog, at the entry's install. */
  | { kind: "install"; entry: string }
  /** The add screen of You > Connections, at the entry's tile. */
  | { kind: "add-own"; entry: OwnServerEntry };

/** What a card says of its entry here. */
export type ServiceCardStatus =
  /** The reader's own account is connected: their own server, or a personal Connection. */
  | "connected"
  /** A Connection was set up from the entry, or the reader added it and is not signed in. */
  | "set-up"
  /** Nothing yet: the click starts it. */
  | "start"
  /** The operator has not named the entry: it is greyed and opens nothing. */
  | "not-offered";

export interface ServiceCard {
  id: string;
  title: CatalogueEntryOffer["title"];
  description: CatalogueEntryOffer["description"];
  mark: CatalogueEntryOffer["mark"];
  /** What the entry brings: its parts for an admin's install, `own` for a person's own server. */
  parts: readonly (CataloguePartName | "own")[];
  status: ServiceCardStatus;
  /** Absent for an entry that opens nothing. */
  action?: ServiceCardAction;
}

/** A Connection of the list, as far as a card reads it. */
export interface ListedConnection {
  name: string;
  attributes?: Record<string, unknown> | undefined;
}

/** How far a status goes: an entry that is both an admin's and a person's shows the further. */
const RANK: Record<ServiceCardStatus, number> = {
  "not-offered": 0,
  start: 1,
  "set-up": 2,
  connected: 3
};

/**
 * The cards, in the order the reader acts on them: entries offered for an install, then
 * entries a person adds as their own server, then entries the operator has not named. An
 * install is offered only to a reader who may make a Connection; an entry the reader cannot
 * start and that is not set up here is not shown, unless it is one the operator has not named,
 * which an admin is told to ask for.
 */
export function serviceCards(input: {
  /** The catalogue's entries an admin installs: empty for a reader who may make no Connection. */
  entries: readonly CatalogueEntryOffer[];
  /** The entries the reader may add as their own server: empty where they may add none. */
  ownEntries: readonly OwnServerEntry[];
  /** The instance's Connections, as the list reads them. */
  connections: readonly ListedConnection[];
  /** The reader's own sign-ins and servers. */
  mine: readonly PersonalRow[];
  /** The reader may make a Connection. */
  mayCreate: boolean;
}): ServiceCard[] {
  const cards = new Map<string, ServiceCard>();
  const put = (card: ServiceCard) => {
    const before = cards.get(card.id);
    if (before === undefined) {
      cards.set(card.id, card);
      return;
    }
    if (RANK[card.status] > RANK[before.status]) {
      cards.set(card.id, { ...before, status: card.status, ...actionOf(card) });
    }
  };

  for (const entry of entriesToShow(input.entries)) {
    // A person's own server is never the instance's install of an entry, and another
    // person's, which an admin's list shows, says nothing of the reader's.
    const installed = input.connections.find(
      (connection) =>
        connection.attributes?.catalogueEntry === entry.id &&
        listedOwnServer(connection) === undefined
    );
    const own = input.mine.find(
      (row) =>
        row.ownServer === undefined &&
        row.catalogue?.entry === entry.id &&
        row.state === "connected"
    );
    const shown = {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      mark: entry.mark,
      parts: entry.parts.map((part) => part.part)
    };
    if (own) {
      put({ ...shown, status: "connected", action: { kind: "open", name: own.name } });
    } else if (installed) {
      put({ ...shown, status: "set-up", action: { kind: "open", name: installed.name } });
    } else if (!entry.offered) {
      put({ ...shown, status: "not-offered" });
    } else if (input.mayCreate) {
      put({ ...shown, status: "start", action: { kind: "install", entry: entry.id } });
    }
  }

  // Only the reader's own servers count: `mine` lists no other person's.
  for (const entry of input.ownEntries) {
    const row = input.mine.find(
      ({ ownServer, ...candidate }) =>
        ownServer !== undefined &&
        ownServerEntryOf({ ...candidate, ownServer }, [entry]) !== undefined
    );
    put({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      mark: entry.mark,
      parts: ["own"],
      ...(row === undefined
        ? { status: "start" as const, action: { kind: "add-own" as const, entry } }
        : {
            status: row.state === "connected" ? ("connected" as const) : ("set-up" as const),
            action: { kind: "own-servers" as const }
          })
    });
  }

  const shown = [...cards.values()];
  return [
    ...shown.filter((card) => card.status !== "not-offered"),
    ...shown.filter((card) => card.status === "not-offered")
  ];
}

function actionOf(card: ServiceCard): Pick<ServiceCard, "action"> {
  return card.action === undefined ? {} : { action: card.action };
}
