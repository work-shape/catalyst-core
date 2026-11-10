import { AppError } from "./errors";
import { isAuthenticatedServicePrincipal, type AuthenticatedIdentity } from "./identity";
import type { AccessResource } from "./permissions";

// A person's own MCP server (PMCP, connections-and-secrets.md): a Connection of type `mcp` in
// the credential mode `user` with `ownerOnly`, which only the person who added it reads, uses,
// changes and deletes. An instance admin reads it, switches it off and deletes it, and nothing
// more. What a self-added server needs beyond a personal connection is decided here.

/** Why a self-added server, or the add of one, is refused. */
export const OWN_SERVER_REFUSALS = {
  /** The operator's switch `modules.connections.ownServers.enabled` is off. */
  off: "own_servers_off",
  /** The person holds `modules.connections.ownServers.perPerson` self-added servers. */
  limit: "own_servers_limit",
  /** A write would change `ownerOnly`, which the self-add create fixes. */
  ownerOnlyFixed: "owner_only_fixed",
  /** The right is the owner's alone, and the caller is somebody else. */
  notOwner: "not_owner"
} as const;

/** `modules.connections.ownServers` where release config leaves a value out. */
export const DEFAULT_OWN_SERVERS = Object.freeze({
  enabled: true,
  perPerson: 10,
  publicHttps: true
});

/** The operator's settings of self-added servers, as the platform reads them. */
export interface OwnServersSettings {
  enabled: boolean;
  perPerson: number;
  publicHttps: boolean;
}

/**
 * The owner of a Connection only its owner uses, read from its definition, or nothing for any
 * other Connection. A definition that says `ownerOnly` and names no owner has an owner nobody
 * is, so it is nobody's.
 */
export function ownerOnlyOwnerOf(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  if (Reflect.get(config, "ownerOnly") !== true) return undefined;
  const owner: unknown = Reflect.get(config, "ownerPrincipalId");
  return typeof owner === "string" && owner !== "" ? owner : "";
}

/** The owner-bound part of a right decided on the asset with this definition. */
export function ownerOnlyResource(config: unknown): Pick<AccessResource, "ownerOnly"> {
  const ownerId = ownerOnlyOwnerOf(config);
  return ownerId === undefined ? {} : { ownerOnly: { ownerId } };
}

/** Whether the actor is the person who owns the self-added server. */
export function isOwnServerOwner(
  actor: Pick<AuthenticatedIdentity, "id"> | { id: string } | undefined,
  config: unknown
): boolean {
  const owner = ownerOnlyOwnerOf(config);
  return owner !== undefined && owner !== "" && actor !== undefined && actor.id === owner;
}

/**
 * Whether the actor is a person signed in to the instance in a first-party session: no key, no
 * CLI, no Service Principal, no embedding host's session and no one acting for another.
 */
export function isFirstPartyPerson(actor: AuthenticatedIdentity | undefined): boolean {
  return (
    actor !== undefined &&
    !isAuthenticatedServicePrincipal(actor) &&
    actor.delegatedActor === undefined &&
    actor.keyScopes === undefined &&
    actor.authenticationMethod === "session-cookie"
  );
}

export function ownServersOffError(): AppError {
  return new AppError(
    "FORBIDDEN",
    `${OWN_SERVER_REFUSALS.off}: this instance does not let people add their own MCP servers`,
    { reason: OWN_SERVER_REFUSALS.off },
    { exposeMessage: true }
  );
}

export function ownServersLimitError(perPerson: number): AppError {
  return new AppError(
    "CONFLICT",
    `${OWN_SERVER_REFUSALS.limit}: a person adds at most ${perPerson} own MCP servers on this instance. Remove one first`,
    { reason: OWN_SERVER_REFUSALS.limit, limit: perPerson },
    { exposeMessage: true }
  );
}

export function ownerOnlyFixedError(): AppError {
  return new AppError(
    "CONFLICT",
    `${OWN_SERVER_REFUSALS.ownerOnlyFixed}: whether only its owner uses a Connection is fixed when it is added`,
    { reason: OWN_SERVER_REFUSALS.ownerOnlyFixed },
    { exposeMessage: true }
  );
}

/** A refusal of what is the owner's alone on a person's own server. */
export function notOwnerError(what: string): AppError {
  return new AppError(
    "FORBIDDEN",
    `${OWN_SERVER_REFUSALS.notOwner}: only the person who added this MCP server ${what}`,
    { reason: OWN_SERVER_REFUSALS.notOwner },
    { exposeMessage: true }
  );
}
