import type { ConnectionTestResult, PersonalConnections } from "@work-shape/catalyst-api-client";
import { CONNECTION_NAME_MAX_LENGTH } from "@work-shape/catalyst-core";
import { personalViewOf, type PersonalView } from "./connection-people-model";

// A person's own MCP server (PMCP-5): what You > Connections reads and writes for it. Pure:
// the dialog and the cards hold the state, these functions read and make it. The instance
// decides every write; these decide only what is shown and sent.

type PersonalRow = PersonalConnections["connections"][number];

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
}): Record<string, unknown> {
  return {
    name: input.name,
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
