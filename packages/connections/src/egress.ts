import { BlockList, isIP } from "node:net";
import {
  AppError,
  EGRESS_DENIED,
  EGRESS_PROTOCOLS,
  type EgressChecker,
  type EgressGrant,
  type EgressProtocol,
  type EgressTarget
} from "@vivd-catalyst/core";
import { isBlockedIpAddress, nodeWebFetchAddressResolver } from "@vivd-catalyst/web-access";

// The one egress checker. Every connection a Connection opens passes `check` first, whatever
// its Connector type. The list is the operator's and is deny by default.
//
// What is decided here:
// - A target is protocol, host and port. All three must equal one entry of `egress.allow`. A
//   host is one exact name or one literal address: no wildcard, no suffix match.
// - The host is resolved when it is checked, and every answer is judged. One answer that is
//   loopback, link-local, a metadata address or a private range refuses a public entry, also
//   as an IPv4-mapped IPv6 address. An entry with `network: private` is the operator saying
//   the target is inside: then every answer must lie in the entry's `cidrs`.
// - The check answers one address of those it judged. The connector connects to that address
//   (`pinnedLookup`) and keeps the host as TLS and `Host` name, so the address used is the
//   address checked and a second DNS answer changes nothing.
// - The Platform Store's own host and port are refused whatever the list says, by name and by
//   address.
// - Plain `http` reaches a private entry only. The release config schema refuses it for a
//   public one, and so does this check.
// - A redirect or a returned download address is a new target: `egressTargetOfUrl` reads it
//   and `check` judges it. An address with a user name or a password is never a target.

/** One entry of release config `egress.allow`, as the schema reads it. */
export interface EgressAllowEntry {
  protocol: EgressProtocol;
  host: string;
  port: number;
  network: "public" | "private";
  /** With `private`: the ranges every address of the host must lie in. */
  cidrs: readonly string[];
}

export interface EgressResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type EgressAddressResolver = (host: string) => Promise<EgressResolvedAddress[]>;

/**
 * How long a checked answer is used again. A page load checks nothing; within this time a
 * call to the same target makes no DNS lookup. The list comes from release config, so a
 * change to it arrives with a restart and an empty cache.
 */
export const EGRESS_RESOLUTION_TTL_MS = 30_000;
/** How long one DNS lookup may take before the target is refused. */
export const EGRESS_RESOLVE_TIMEOUT_MS = 5_000;
/** The default ports of the protocols an address may name without one. */
const DEFAULT_PORTS: Record<EgressProtocol, number> = { https: 443, http: 80, postgres: 5432 };

export interface EgressCheckerOptions {
  allow: readonly EgressAllowEntry[];
  /** The Platform Store's own targets. They are refused always. */
  platformStore?: readonly { host: string; port: number }[];
  /** Resolves a host name to every address it has. The system resolver unless given. */
  resolve?: EgressAddressResolver;
  /** The clock of the answer cache, in milliseconds. */
  now?: () => number;
}

export function egressDenied(target: { host: string; port: number }): AppError {
  // Host and port are what the operator's list is written in. Nothing else of the target,
  // no path and no query, is ever part of a refusal.
  const host = printableHost(target.host);
  return new AppError("FORBIDDEN", `${EGRESS_DENIED}: ${host}:${target.port} is not allowed`, {
    reason: EGRESS_DENIED,
    host,
    port: target.port
  });
}

/** A host as a refusal may repeat it: a name or an address, and nothing that was pasted. */
function printableHost(host: string): string {
  return /^[a-z0-9.:-]{1,253}$/iu.test(host) ? host.toLowerCase() : "(unreadable host)";
}

/** Lower case, without the brackets of an IPv6 literal and without a trailing dot. */
export function normalizeEgressHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
}

function isHostName(host: string): boolean {
  return (
    host.length <= 253 &&
    /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(?:\.(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?))*$/u.test(
      host
    )
  );
}

function isPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function isEgressProtocol(protocol: string): protocol is EgressProtocol {
  return EGRESS_PROTOCOLS.some((candidate) => candidate === protocol);
}

/**
 * An address in the one form it is judged, compared and pinned in. An IPv6 address is written
 * the way the URL standard writes it, and an IPv4-mapped one (`::ffff:10.0.0.1`) is the IPv4
 * address it stands for.
 */
function canonicalAddress(address: string): EgressResolvedAddress | undefined {
  const plain = normalizeEgressHost(address);
  const version = isIP(plain);
  if (version === 4) {
    return { address: plain, family: 4 };
  }
  if (version !== 6) {
    return undefined;
  }
  let written: string;
  try {
    written = new URL(`http://[${plain}]/`).hostname.replace(/^\[(.*)\]$/u, "$1");
  } catch {
    return undefined;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(written);
  if (mapped?.[1] === undefined || mapped[2] === undefined) {
    return { address: written, family: 6 };
  }
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return { address: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, family: 4 };
}

/** Never a target, whatever a list says: the unspecified address, multicast and broadcast. */
function isNeverRoutable({ address, family }: EgressResolvedAddress): boolean {
  if (family === 4) {
    const first = Number.parseInt(address.split(".")[0] ?? "", 10);
    return first === 0 || first >= 224;
  }
  return address === "::" || address.startsWith("ff");
}

/** One range of an entry, as `address/prefix`. */
export function parseEgressCidr(
  cidr: string
): { network: string; prefix: number; family: "ipv4" | "ipv6" } | undefined {
  const match = /^([^/]+)\/(\d{1,3})$/u.exec(cidr.trim());
  if (!match?.[1] || match[2] === undefined) {
    return undefined;
  }
  const network = normalizeEgressHost(match[1]);
  const version = isIP(network);
  const prefix = Number(match[2]);
  if (version === 4 && prefix <= 32) {
    return { network, prefix, family: "ipv4" };
  }
  if (version === 6 && prefix <= 128) {
    return { network, prefix, family: "ipv6" };
  }
  return undefined;
}

interface ListedEntry {
  entry: EgressAllowEntry;
  host: string;
  ranges: BlockList;
}

function listEntries(allow: readonly EgressAllowEntry[]): ListedEntry[] {
  return allow.map((entry) => {
    const ranges = new BlockList();
    for (const cidr of entry.cidrs) {
      const range = parseEgressCidr(cidr);
      if (!range) {
        throw new AppError("VALIDATION_FAILED", `egress.allow: '${cidr}' is not a CIDR range`);
      }
      ranges.addSubnet(range.network, range.prefix, range.family);
    }
    if (entry.protocol === "http" && entry.network !== "private") {
      throw new AppError(
        "VALIDATION_FAILED",
        "egress.allow: plain http is allowed for a private target only"
      );
    }
    return { entry, host: normalizeEgressHost(entry.host), ranges };
  });
}

async function withTimeout<Value>(work: Promise<Value>, ms: number): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The egress checker of one process, over the operator's list. */
export function createEgressChecker(options: EgressCheckerOptions): EgressChecker {
  const entries = listEntries(options.allow);
  const resolve = options.resolve ?? nodeWebFetchAddressResolver;
  const now = options.now ?? Date.now;
  const platformStore = (options.platformStore ?? []).map((target) => ({
    host: normalizeEgressHost(target.host),
    port: target.port
  }));
  // Holds the answer for each target of the list that was asked, so at most one entry per
  // line of `egress.allow`. A refusal is held as long as a grant.
  const answers = new Map<string, { until: number; answer: Promise<EgressGrant> }>();
  const storeAddresses = new Map<string, { until: number; answer: Promise<string[]> }>();

  const addressesOf = async (host: string): Promise<EgressResolvedAddress[]> => {
    const literal = canonicalAddress(host);
    if (literal) {
      return [literal];
    }
    const resolved = await withTimeout(resolve(host), EGRESS_RESOLVE_TIMEOUT_MS);
    // An answer that is no address stays as it is and is refused when it is judged.
    return resolved.map((answer) => canonicalAddress(answer.address) ?? answer);
  };

  /** The addresses the Platform Store answers on the port, for the comparison by address. */
  const storeAddressesOn = async (port: number): Promise<string[]> => {
    const found: string[] = [];
    for (const store of platformStore.filter((candidate) => candidate.port === port)) {
      let held = storeAddresses.get(store.host);
      if (!held || held.until <= now()) {
        held = {
          until: now() + EGRESS_RESOLUTION_TTL_MS,
          answer: addressesOf(store.host).then(
            (addresses) => addresses.map((entry) => entry.address),
            // A store host that does not resolve here is still refused by its name.
            () => []
          )
        };
        storeAddresses.set(store.host, held);
      }
      found.push(...(await held.answer));
    }
    return found;
  };

  const judge = async (target: EgressTarget, listed: ListedEntry): Promise<EgressGrant> => {
    let addresses: EgressResolvedAddress[];
    try {
      addresses = await addressesOf(target.host);
    } catch {
      throw egressDenied(target);
    }
    if (addresses.length === 0) {
      throw egressDenied(target);
    }
    const store = await storeAddressesOn(target.port);
    for (const answer of addresses) {
      // An answer this check cannot read as an address is never connected to.
      if (isIP(answer.address) === 0 || isNeverRoutable(answer)) {
        throw egressDenied(target);
      }
      if (store.includes(answer.address)) {
        throw egressDenied(target);
      }
      const inside = listed.ranges.check(answer.address, answer.family === 4 ? "ipv4" : "ipv6");
      const allowed =
        listed.entry.network === "private" ? inside : !isBlockedIpAddress(answer.address);
      if (!allowed) {
        throw egressDenied(target);
      }
    }
    // Every answer passed. The first IPv4 one is pinned, else the first.
    const pinned = addresses.find((answer) => answer.family === 4) ?? addresses[0];
    if (!pinned) {
      throw egressDenied(target);
    }
    return Object.freeze({
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      address: pinned.address,
      family: pinned.family,
      network: listed.entry.network
    });
  };

  return {
    async check(input) {
      const target: EgressTarget = {
        protocol: input.protocol,
        host: normalizeEgressHost(input.host),
        port: input.port
      };
      if (
        !isEgressProtocol(target.protocol) ||
        !isPort(target.port) ||
        !(isHostName(target.host) || isIP(target.host) !== 0)
      ) {
        throw egressDenied(target);
      }
      if (platformStore.some((store) => store.host === target.host && store.port === target.port)) {
        throw egressDenied(target);
      }
      const listed = entries.find(
        (candidate) =>
          candidate.entry.protocol === target.protocol &&
          candidate.host === target.host &&
          candidate.entry.port === target.port
      );
      if (!listed) {
        throw egressDenied(target);
      }
      const key = `${target.protocol}|${target.host}|${target.port}`;
      let held = answers.get(key);
      if (!held || held.until <= now()) {
        held = { until: now() + EGRESS_RESOLUTION_TTL_MS, answer: judge(target, listed) };
        answers.set(key, held);
      }
      return held.answer;
    }
  };
}

/**
 * Reads the target of an address a connector was handed, such as a redirect. It refuses an
 * address with a user name or a password, and a scheme no Connection speaks. The path and the
 * query are not part of a target.
 */
export function egressTargetOfUrl(address: string): EgressTarget {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw egressDenied({ host: "", port: 0 });
  }
  const protocol = url.protocol.replace(/:$/u, "").replace(/^postgresql$/u, "postgres");
  const host = normalizeEgressHost(url.hostname);
  if (!isEgressProtocol(protocol) || host === "") {
    throw egressDenied({ host, port: 0 });
  }
  const port = url.port === "" ? DEFAULT_PORTS[protocol] : Number(url.port);
  if (url.username !== "" || url.password !== "") {
    throw egressDenied({ host, port });
  }
  return { protocol, host, port };
}

/** Whether two targets are one origin. A credential stays with the origin it was set for. */
export function isSameEgressOrigin(left: EgressTarget, right: EgressTarget): boolean {
  return (
    left.protocol === right.protocol &&
    normalizeEgressHost(left.host) === normalizeEgressHost(right.host) &&
    left.port === right.port
  );
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number
) => void;

/**
 * The `lookup` a connector gives its socket: it answers the address that was checked for the
 * granted host and fails for every other name, so nothing resolves a second time.
 */
export function pinnedLookup(
  grant: EgressGrant
): (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    if (normalizeEgressHost(hostname) !== grant.host) {
      const error: NodeJS.ErrnoException = new Error(
        `${EGRESS_DENIED}: the connection is pinned to another host`
      );
      error.code = "ENOTFOUND";
      callback(error, "");
      return;
    }
    if (typeof options === "object" && options.all === true) {
      callback(null, [{ address: grant.address, family: grant.family }]);
      return;
    }
    callback(null, grant.address, grant.family);
  };
}
