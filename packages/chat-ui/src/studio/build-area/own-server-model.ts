import type { ConnectionTestResult, PersonalConnections } from "@work-shape/catalyst-api-client";
import { CONNECTION_NAME_MAX_LENGTH } from "@work-shape/catalyst-core";
import { toolAnswer } from "../../chat/conversation/subject-run";
import type { TranslationContextValue } from "../../shared/i18n";
import { personalViewOf, type PersonalView } from "./connection-people-model";
import { readingNames, type ApprovalCandidate } from "./connection-approval-model";

// A person's own MCP server (PMCP-5): what You > Connections reads and writes for it. Pure:
// the dialog and the cards hold the state, these functions read and make it. The instance
// decides every write; these decide only what is shown and sent.

type PersonalRow = PersonalConnections["connections"][number];

/** Settings > You > Connections, where a person's own servers are added. */
export const OWN_SERVERS_ROUTE = { kind: "settings", group: "you", page: "connections" } as const;

/** A catalogue entry the person adds as their own server (PMCP-CAT): a tile on the add screen. */
export type OwnServerEntry = NonNullable<
  NonNullable<PersonalConnections["ownServers"]>["entries"]
>[number];

/**
 * The entry a card shows the mark of: the one whose service the server carries, while the
 * server is still at the entry's host. A server moved elsewhere is no longer that service.
 */
export function ownServerEntryOf(
  row: Pick<PersonalRow, "service"> & { ownServer: { host: string } },
  entries: readonly OwnServerEntry[]
): OwnServerEntry | undefined {
  if (row.service === undefined) return undefined;
  return entries.find(
    (entry) => entry.service === row.service && ownServerHostOf(entry.url) === row.ownServer.host
  );
}

/** What the tools list starts with where an entry names the server's tools (PMCP-CAT). */
export interface EntryToolStart {
  /** Ticked at the start: the tools that read, less those the entry calls changing. */
  selected: Set<string>;
  /** `ändert` at the start where the server says the tool only reads and the entry does not. */
  effects: Map<string, ApprovalCandidate["effect"]>;
  /**
   * Tools the server does not mark read-only that the entry says only read. They start
   * `ändert` and unticked, and only the person's own choice makes them `liest`.
   */
  entryReads: Set<string>;
}

/**
 * An entry recommends, and the person accepts: its `changing` turns a read-only tool into
 * `ändert`, unticked, which the person may set back; its `reading` never ticks a tool the
 * server does not mark read-only, it only lets the person choose `liest` for it. A tool the
 * entry does not name keeps the server's hint, and one the server does not list is ignored.
 */
export function entryToolStart(
  candidates: readonly ApprovalCandidate[],
  tools: OwnServerEntry["tools"]
): EntryToolStart {
  const said = new Map(tools.map((tool) => [tool.name, tool.effect]));
  const selected = new Set(readingNames(candidates));
  const effects = new Map<string, ApprovalCandidate["effect"]>();
  const entryReads = new Set<string>();
  for (const candidate of candidates) {
    const effect = said.get(candidate.name);
    if (effect === "changing" && candidate.effect === "reading") {
      effects.set(candidate.name, "changing");
      selected.delete(candidate.name);
    }
    if (effect === "reading" && candidate.effect === "changing") entryReads.add(candidate.name);
  }
  return { selected, effects, entryReads };
}

/** A row of the person's list that is an MCP server they added for themselves. */
export type OwnServerRow = PersonalRow & { ownServer: NonNullable<PersonalRow["ownServer"]> };

/** The person's own servers, and the personal Connections an administrator set up. */
export function splitOwnServers(rows: readonly PersonalRow[]): {
  own: OwnServerRow[];
  personal: PersonalRow[];
} {
  const own: OwnServerRow[] = [];
  const personal: PersonalRow[] = [];
  for (const row of rows) {
    if (row.ownServer === undefined) personal.push(row);
    else own.push({ ...row, ownServer: row.ownServer });
  }
  return { own, personal };
}

/** What the card of an own server says of it: the sign-in's state, or switched off. */
export type OwnServerView = PersonalView | "off";

export function ownServerViewOf(row: OwnServerRow): OwnServerView {
  return row.ownServer.enabled ? personalViewOf(row) : "off";
}

/** Why an address is not taken before anything is sent. */
export type OwnServerAddressIssue = "empty" | "invalid" | "credentials" | "query";

/**
 * Whether the typed address can be sent: a web address with no name or password and nothing
 * from `?` or `#` on. Which hosts a self-added server may reach the instance decides, by its
 * egress rule: `https` on port 443 at a public address.
 */
export function ownServerAddressIssue(raw: string): OwnServerAddressIssue | undefined {
  const typed = raw.trim();
  if (typed === "") return "empty";
  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return "invalid";
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    return "invalid";
  }
  if (url.username !== "" || url.password !== "") return "credentials";
  if (url.search !== "" || url.hash !== "" || typed.includes("?") || typed.includes("#")) {
    return "query";
  }
  return undefined;
}

/** The host of a typed address, as the dialog names it, such as `notes.example.com`. */
export function ownServerHostOf(raw: string): string {
  try {
    return new URL(raw.trim()).host;
  } catch {
    return raw.trim();
  }
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Six random characters of the name, so two people's "notes" never meet. */
export function ownServerSuffix(random: () => number = Math.random): string {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix += RANDOM_ALPHABET[Math.floor(random() * RANDOM_ALPHABET.length)] ?? "a";
  }
  return suffix;
}

/**
 * The Connection's name: the host in lowercase words, such as `notes-example-com`, and the
 * suffix. Names are unique on the instance, and nobody types this one.
 */
export function ownServerName(host: string, suffix: string): string {
  const words = host
    .toLowerCase()
    .replace(/:\d+$/u, "")
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== "");
  const start = /^[a-z]/u.test(words[0] ?? "") ? words : ["mcp", ...words];
  let stem = start.join("-");
  const room = CONNECTION_NAME_MAX_LENGTH - suffix.length - 1;
  if (stem.length > room) stem = stem.slice(0, room).replace(/-+$/u, "");
  return `${stem}-${suffix}`;
}

/** The title it starts with: the host without its port, which the person may change. */
export function ownServerTitle(host: string): string {
  return host.replace(/:\d+$/u, "");
}

/**
 * The definition the add writes: an MCP server in the person's own mode, signing in with
 * OAuth, that only they use, with no tool yet. The instance sets the owner, origin and handle.
 */
export function ownServerConfig(input: {
  name: string;
  url: string;
  title: string;
  /** The service of the catalogue entry it is added from, which picks its card's mark. */
  service?: string;
}): Record<string, unknown> {
  return {
    name: input.name,
    ...(input.service === undefined ? {} : { service: input.service }),
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "oauth",
    displayName: input.title,
    settings: { url: input.url.trim() },
    operations: [],
    enabled: true,
    ownerOnly: true
  };
}

/** What the dialog does after the owner's probe answered. */
export type OwnServerProbeStep = "sign_in" | "no_sign_in" | "token" | "egress" | "unreachable";

export function ownServerProbeStep(status: ConnectionTestResult["status"]): OwnServerProbeStep {
  switch (status) {
    case "oauth_required":
      return "sign_in";
    case "ready":
      return "no_sign_in";
    case "token_required":
      return "token";
    case "network_denied":
      return "egress";
    case "unauthorized":
    case "unavailable":
      return "unreachable";
  }
}

/**
 * The definition with only the accepted tools the owner kept, each with the effect chosen for
 * it, and everything else of each entry as stored.
 */
export function withKeptOperations(
  config: Record<string, unknown>,
  kept: ReadonlySet<string>,
  effects: ReadonlyMap<string, "reading" | "changing">
): Record<string, unknown> {
  const stored: unknown[] = Array.isArray(config.operations) ? config.operations : [];
  return {
    ...config,
    operations: stored.flatMap((operation) => {
      if (typeof operation !== "object" || operation === null) return [];
      const name: unknown = Reflect.get(operation, "name");
      if (typeof name !== "string" || !kept.has(name)) return [];
      const effect = effects.get(name);
      return [effect === undefined ? operation : { ...operation, effect }];
    })
  };
}

/**
 * An agent's proposal of a person's own MCP server (PMCP-CHAT), as its tool answered: the name
 * in words and the address its add screen starts with. Nothing for any other answer.
 */
export function readOwnServerProposal(result: unknown): OwnServerProposal | undefined {
  const answer = toolAnswer(result);
  if (answer?.mode !== "own_server") return undefined;
  const proposal: unknown = answer.ownServer;
  if (typeof proposal !== "object" || proposal === null) return undefined;
  const title: unknown = Reflect.get(proposal, "title");
  const url: unknown = Reflect.get(proposal, "url");
  const entry: unknown = Reflect.get(proposal, "entry");
  return typeof title === "string" && typeof url === "string" && url !== ""
    ? {
        title,
        url,
        ...(typeof entry === "string" && entry !== "" ? { entry } : {}),
        ...(answer.privateChat === false ? { privateChat: false as const } : {})
      }
    : undefined;
}

/**
 * An agent's proposal of a person's own server: its name and address, and the catalogue entry
 * it names, whose address the add screen then takes from the instance (PMCP-CAT).
 */
export interface OwnServerProposal {
  title: string;
  url: string;
  entry?: string;
  /**
   * Made in a chat others read (PMCP-CHAT-2): the server's tools work only in the person's
   * private chats, and nothing is told back to this one.
   */
  privateChat?: false;
}

/** The longest a server's or tool's name is quoted in the person's message. */
export const OWN_SERVER_TOLD_NAME_MAX = 80;
/** The most tools the person's message names; the rest it counts. */
export const OWN_SERVER_TOLD_TOOLS_MAX = 5;

/**
 * A name as the person's message quotes it. Tool titles are chosen by the server, so a title
 * must read as a name and never as text the person wrote: one line with no control, format or
 * separator characters, no quote mark of its own to close the quote with, and at most
 * {@link OWN_SERVER_TOLD_NAME_MAX} characters.
 */
export function ownServerToldName(raw: string): string {
  const line = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/["\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u300C\u300D\uFF02]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(line);
  return chars.length > OWN_SERVER_TOLD_NAME_MAX
    ? `${chars
        .slice(0, OWN_SERVER_TOLD_NAME_MAX - 1)
        .join("")
        .trimEnd()}\u2026`
    : line;
}

/**
 * The person's message to the conversation whose agent proposed the server, once it is added:
 * its name and the tools they accepted, or that they accepted none. Every name is quoted as
 * {@link ownServerToldName} makes it, at most {@link OWN_SERVER_TOLD_TOOLS_MAX} are listed and
 * the rest counted.
 */
export function ownServerAddedMessage(
  added: { title: string; tools: readonly string[] },
  t: TranslationContextValue["t"]
): string {
  const quote = (raw: string) => t("ownServers.toldName", { name: ownServerToldName(raw) });
  const title = quote(added.title);
  const names = added.tools.map(ownServerToldName).filter((name) => name !== "");
  if (names.length === 0) return t("ownServers.toldNoTools", { title });
  const listed = names
    .slice(0, OWN_SERVER_TOLD_TOOLS_MAX)
    .map((name) => t("ownServers.toldName", { name }));
  const rest = names.length - listed.length;
  const tools =
    listed.join(", ") + (rest > 0 ? ` ${t("ownServers.toldMore", { count: rest })}` : "");
  return names.length === 1
    ? t("ownServers.toldOne", { title, tools })
    : t("ownServers.toldTools", { title, count: names.length, tools });
}

/** How a person's own token is sent (PMCP-6): as a bearer token, or in a header of its own. */
export type OwnTokenScheme =
  { authScheme: "bearer" } | { authScheme: "header"; headerName: string };

/** A header name as the MCP type takes one: letters, digits and hyphens, a letter first. */
const OWN_TOKEN_HEADER_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;

/**
 * The scheme a typed header name asks for: none, or `Authorization` in any case, is a bearer
 * token; any other name puts the token in that header. `undefined` for a name that is none.
 */
export function ownTokenSchemeOf(header: string): OwnTokenScheme | undefined {
  const name = header.trim();
  if (name === "" || name.toLowerCase() === "authorization") return { authScheme: "bearer" };
  return OWN_TOKEN_HEADER_PATTERN.test(name)
    ? { authScheme: "header", headerName: name }
    : undefined;
}

/** The header name a stored definition sends its token in, for the field: empty for a bearer. */
export function ownTokenHeaderOf(config: Record<string, unknown>): string {
  if (config.authScheme !== "header") return "";
  const settings = config.settings;
  if (typeof settings !== "object" || settings === null) return "";
  const name: unknown = Reflect.get(settings, "headerName");
  return typeof name === "string" ? name : "";
}

/**
 * The definition that sends the token as `scheme` asks, or `undefined` where it does so
 * already. A change of scheme deletes every person's stored token on the instance's side.
 */
export function withOwnTokenScheme(
  config: Record<string, unknown>,
  scheme: OwnTokenScheme
): Record<string, unknown> | undefined {
  const raw = config.settings;
  const settings: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? Object.fromEntries(Object.entries(raw)) : {};
  const sameScheme = config.authScheme === scheme.authScheme;
  if (scheme.authScheme === "bearer") {
    if (sameScheme && !("headerName" in settings)) return undefined;
    delete settings.headerName;
    return { ...config, authScheme: "bearer", settings };
  }
  if (sameScheme && settings.headerName === scheme.headerName) return undefined;
  return {
    ...config,
    authScheme: "header",
    settings: { ...settings, headerName: scheme.headerName }
  };
}
