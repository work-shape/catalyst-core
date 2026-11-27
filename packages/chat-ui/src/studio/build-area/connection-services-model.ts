import {
  entriesToShow,
  type CatalogueEntryOffer,
  type CataloguePartName
} from "./connection-catalogue-model";
import { listedOwnServer } from "./own-server-model";

// "Dienste hinzufügen" on the manage tab of the Connections page (CAT-PAGE, CONN-IA): one card
// per catalogue entry who manages Connections can install, with whether the instance has it.
// Pure: the page reads the entries and the Connections, and these decide only what each card
// says and where its click goes. A card says nothing of the reader's own account: that stands
// under "Meine Verbindungen". Nothing here grants a right: an install is decided where it was.

/** Where a card's click goes. */
export type ServiceCardAction =
  /** The page of a Connection set up from the entry. */
  | { kind: "open"; name: string }
  /** The New connection dialog, at the entry's install. */
  | { kind: "install"; entry: string };

/** What a card says of its entry here. */
export type ServiceCardStatus =
  /** The instance has a Connection set up from the entry. */
  | "installed"
  /** Nothing yet: the click starts it. */
  | "start"
  /** The operator has not named the entry: it is greyed and opens nothing. */
  | "not-offered";

export interface ServiceCard {
  id: string;
  title: CatalogueEntryOffer["title"];
  description: CatalogueEntryOffer["description"];
  mark: CatalogueEntryOffer["mark"];
  /** What the entry brings. */
  parts: readonly CataloguePartName[];
  status: ServiceCardStatus;
  /** Absent for an entry that opens nothing. */
  action?: ServiceCardAction;
}

/** A Connection of the list, as far as a card reads it. */
export interface ListedConnection {
  name: string;
  attributes?: Record<string, unknown> | undefined;
}

/**
 * The cards, in the order the reader acts on them: the entries that can be installed or are,
 * then the entries the operator has not named, which an admin is told to ask for.
 */
export function serviceCards(input: {
  /** The catalogue's entries an admin installs. */
  entries: readonly CatalogueEntryOffer[];
  /** The instance's Connections, as the list reads them. */
  connections: readonly ListedConnection[];
}): ServiceCard[] {
  const cards = entriesToShow(input.entries).map((entry): ServiceCard => {
    // A person's own server is never the instance's install of an entry.
    const installed = input.connections.find(
      (connection) =>
        connection.attributes?.catalogueEntry === entry.id &&
        listedOwnServer(connection) === undefined
    );
    const shown = {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      mark: entry.mark,
      parts: entry.parts.map((part) => part.part)
    };
    if (installed) {
      return { ...shown, status: "installed", action: { kind: "open", name: installed.name } };
    }
    if (!entry.offered) return { ...shown, status: "not-offered" };
    return { ...shown, status: "start", action: { kind: "install", entry: entry.id } };
  });
  return [
    ...cards.filter((card) => card.status !== "not-offered"),
    ...cards.filter((card) => card.status === "not-offered")
  ];
}
