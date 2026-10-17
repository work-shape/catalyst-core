import { createHash } from "node:crypto";

// The comparisons of the flow, on parsed addresses: which issuer is the one that was asked,
// which resource metadata is the Connection's own, and the hash a state is stored as.

function parsed(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** The path of an address without one trailing `/`. */
function pathOf(url: URL): string {
  return url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
}

/**
 * Whether the issuer a server's metadata names is the authorization server that was asked.
 * Compared as parsed addresses: scheme, host, port and path, with one trailing `/` tolerated
 * (one provider names its issuer with a trailing `/` in one place and without it in another).
 * A query or a fragment never matches.
 */
export function issuersMatch(named: string, asked: string): boolean {
  const left = parsed(named);
  const right = parsed(asked);
  if (left === undefined || right === undefined) return false;
  if (left.search !== "" || left.hash !== "" || right.search !== "" || right.hash !== "") {
    return false;
  }
  return left.origin === right.origin && pathOf(left) === pathOf(right);
}

/**
 * Whether the `resource` of protected resource metadata is the Connection's server: the same
 * origin, and a path that is a prefix of the server's path at a `/`.
 */
export function resourceAllowed(resource: string, serverUrl: string): boolean {
  const named = parsed(resource);
  const server = parsed(serverUrl);
  if (named === undefined || server === undefined) return false;
  if (named.origin !== server.origin) return false;
  const prefix = pathOf(named);
  const path = pathOf(server);
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** The hash a state is stored and looked up as. The state itself is never stored. */
export function stateHashOf(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** The scopes of a `scope` value, once each, in their order. */
export function scopesOf(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  return [...new Set(scope.split(" ").filter((name) => name.length > 0))];
}

/**
 * Whether an address is on one of the given origins. Compared as parsed addresses; an
 * address that does not parse is on none.
 */
export function onOrigins(address: string, origins: readonly string[]): boolean {
  const url = parsed(address);
  return url !== undefined && origins.some((origin) => parsed(origin)?.origin === url.origin);
}

/**
 * The endpoints of authorization server metadata that the instance itself sends a code, a
 * token or client data to: token, registration and revocation. Each must be on the
 * Connection's origin or on the origin of the authorization server the resource metadata
 * named, so metadata cannot send a refresh token or a client secret to a third host on the
 * egress list. The authorization endpoint is exempt: only the browser goes there, and some
 * providers keep it on a host of its own (Box: `account.box.com`).
 */
export function serverEndpointsOutside(
  server: { tokenEndpoint: string; registrationEndpoint?: string; revocationEndpoint?: string },
  origins: readonly string[]
): string | undefined {
  const endpoints = [server.tokenEndpoint, server.registrationEndpoint, server.revocationEndpoint];
  return endpoints.find(
    (endpoint): endpoint is string => endpoint !== undefined && !onOrigins(endpoint, origins)
  );
}
