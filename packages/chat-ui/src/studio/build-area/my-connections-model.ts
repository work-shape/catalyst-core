import type { PersonalConnections } from "@work-shape/catalyst-api-client";
import {
  listedOwnServer,
  ownServerEntryOf,
  splitOwnServers,
  type OwnServerEntry,
  type OwnServerRow
} from "./own-server-model";

// "Meine Verbindungen" (CONN-IA): what one person connects with their own account, as Studio >
// Connections and Settings > You > Connections show it. Pure: the section reads the person's
// list, and these decide which cards stand there and which rows of the instance's list a
// reader is shown. Nothing here grants a right; the instance decides every connect.

type PersonalRow = PersonalConnections["connections"][number];

/** One card of "Meine Verbindungen". */
export type MyConnectionCard =
  /** A Connection an administrator set up that each person connects their own account to. */
  | { kind: "account"; row: PersonalRow }
  /** A server the person added for themselves, with the service's entry while it is at its host. */
  | { kind: "own"; row: OwnServerRow; entry: OwnServerEntry | undefined }
  /** A service the person may connect themselves and has not yet: Connect starts its add. */
  | { kind: "offer"; entry: OwnServerEntry };

/**
 * The cards, in the order a person acts on them: the accounts the instance asks for, the
 * servers they added, then the services they could still connect. A service they already added
 * is offered no second time.
 */
export function myConnectionCards(input: {
  connections: readonly PersonalRow[];
  /** The services a person adds as their own: empty where they may add none. */
  entries: readonly OwnServerEntry[];
}): MyConnectionCard[] {
  const { own, personal } = splitOwnServers(input.connections);
  const added = new Set(
    own.flatMap((row) => {
      const entry = ownServerEntryOf(row, input.entries);
      return entry === undefined ? [] : [entry.id];
    })
  );
  return [
    ...personal.map((row) => ({ kind: "account" as const, row })),
    ...own.map((row) => ({
      kind: "own" as const,
      row,
      entry: ownServerEntryOf(row, input.entries)
    })),
    ...input.entries
      .filter((entry) => !added.has(entry.id))
      .map((entry) => ({ kind: "offer" as const, entry }))
  ];
}

/** A Connection of the instance's list, as far as its place on the page reads it. */
interface ListedRow {
  attributes?: Record<string, unknown> | undefined;
}

/**
 * Whether the instance's list leaves a Connection out because "Meine Verbindungen" shows it or
 * because it is not the reader's to act on. The reader's own server is a card there, never a
 * row. Who manages no Connection is also not shown the Connections each person connects
 * themselves, which are their cards, nor other people's servers, which only who manages acts on,
 * nor a Connection that is switched off or not set up to the end, which nobody can work with.
 */
export function hiddenFromConnectionList(row: ListedRow, mayManage: boolean): boolean {
  const own = listedOwnServer(row);
  if (own?.owner === "reader") return true;
  if (mayManage) return false;
  const { enabled, personalSignIn, withoutTools } = row.attributes ?? {};
  return (
    own?.owner === "other" || personalSignIn === true || enabled === false || withoutTools === true
  );
}

/** A service's mark as its catalogue entry gives it: its logo, or the colour of its initial. */
export interface ServiceMarkSource {
  logo?: string | undefined;
  color?: string | undefined;
}

/** What `ServiceMark` draws of a mark: the logo, else the colour, else the neutral tile. */
export function markArt(
  mark: ServiceMarkSource | undefined
): { logo: string } | { color: string } | Record<never, never> {
  if (mark?.logo !== undefined) return { logo: mark.logo };
  if (mark?.color !== undefined) return { color: mark.color };
  return {};
}

/** The service behind a Connection, by the name people read and its mark. */
export interface ServiceFace {
  title: string;
  mark: ServiceMarkSource;
}

/**
 * The service a Connection was installed for, as the instance's list names it (`serviceTitle`,
 * `serviceLogo`, `serviceColor`). Nothing for a Connection of no service.
 */
export function serviceFaceOf(
  attributes: Record<string, unknown> | undefined
): ServiceFace | undefined {
  const { serviceTitle, serviceLogo, serviceColor } = attributes ?? {};
  if (typeof serviceTitle !== "string" || serviceTitle.trim() === "") return undefined;
  return {
    title: serviceTitle,
    mark: {
      ...(typeof serviceLogo === "string" ? { logo: serviceLogo } : {}),
      ...(typeof serviceColor === "string" ? { color: serviceColor } : {})
    }
  };
}
