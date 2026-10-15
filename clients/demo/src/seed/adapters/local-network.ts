import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ApiClientOptions } from "@work-shape/catalyst-api-client";

// The seed signs in with development passwords, so nothing it sends may leave this machine:
// the address it is given is a local one, the name behind it resolves to this machine, and
// every request goes to that one origin and follows no redirect.
// This is the seed's adapter to the network: the one place of the demo that names `fetch`.

type Fetch = NonNullable<ApiClientOptions["fetchImpl"]>;

/** The addresses a host name stands for. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const LOCAL_HOST_SUFFIXES = [".localhost", ".test"];

/**
 * The address of the instance as the seed uses it: its origin. Refuses an address that is
 * not a local development host, and one with a user, a password, a query or a fragment,
 * which have no place in it and could carry a secret into the output. No message repeats
 * more of the address than its host.
 */
export function assertLocalDevelopmentHost(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("The address of the instance to seed is not a URL.");
  }
  const { hostname } = url;
  if (
    !LOCAL_HOSTS.includes(hostname) &&
    !LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error(
      `Refusing to seed '${hostname}'. The seed signs in with development passwords and only runs against localhost, 127.0.0.1, ::1 or a name ending in .localhost or .test.`
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `Refusing to seed '${hostname}': the address must not carry a user, a password, a query or a fragment.`
    );
  }
  return new URL(url.origin);
}

const defaultResolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function isLoopback(address: string): boolean {
  const kind = isIP(address);
  return kind === 4 ? address.startsWith("127.") : kind === 6 && address === "::1";
}

/**
 * A name is local only when every address it stands for is this machine. `127.0.0.1` and
 * `::1` are addresses and need no lookup.
 */
export async function assertLoopbackAddress(
  origin: URL,
  resolveHost: ResolveHost = defaultResolveHost
): Promise<void> {
  const { hostname } = origin;
  if (hostname === "127.0.0.1" || hostname === "[::1]") return;
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0) {
    throw new Error(`Refusing to seed '${hostname}': the name does not resolve to an address.`);
  }
  if (!addresses.every(isLoopback)) {
    throw new Error(
      `Refusing to seed '${hostname}': the name resolves to an address that is not this machine.`
    );
  }
}

/**
 * The network as the seed may use it: requests to the one origin only, and no redirect
 * followed, so a 307 cannot carry a sign-in to another host.
 */
export function localOnlyFetch(origin: URL, fetchImpl: Fetch = fetch): Fetch {
  return async (resource, init) => {
    const request = new Request(resource, { ...init, redirect: "manual" });
    if (new URL(request.url).origin !== origin.origin) {
      throw new Error(
        `Refusing a request to '${new URL(request.url).host}': the seed talks to ${origin.origin} only.`
      );
    }
    const response = await fetchImpl(request);
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Error(
        `${origin.origin} answered with a redirect (status ${response.status}). The seed follows none, so that nothing it sends leaves this machine.`
      );
    }
    return response;
  };
}
