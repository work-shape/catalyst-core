import { BlockList, isIP } from "node:net";
import {
  AppError,
  EGRESS_DENIED,
  EGRESS_PROTOCOLS,
  EGRESS_UNRESOLVED,
  egressSettingFor,
  type EgressChecker,
  type EgressGrant,
  type EgressProtocol,
  type EgressTarget,
  normalizeEgressHost
} from "@work-shape/catalyst-core";
import {
  embeddedIpv4AddressesOf,
  isBlockedIpAddress,
  nodeWebFetchAddressResolver
} from "@work-shape/catalyst-web-access";

// The one egress checker. Every connection a Connection opens passes `check` first, whatever
// its Connector type. The list is the operator's and is deny by default.
//
// What is decided here:
// - A target is protocol, host and port. All three must equal one entry of `egress.allow`. A
//   host is one exact name or one literal address: no wildcard, no suffix match.
// - A target outside the list is refused before anything is resolved, so that answer never
//   depends on DNS. A listed host whose name gives no address is refused too and nothing is
//   contacted, with the reason `egress_unresolved` and not `egress_denied`.
// - The host is resolved when it is checked, and every answer is judged. One answer that is
//   loopback, link-local, a metadata address or a private range refuses a public entry, also
//   as an IPv4-mapped IPv6 address. An entry with `network: private` is the operator saying
//   the target is inside: then every answer must lie in the entry's `cidrs`. Loopback and
//   private ranges are reachable that way. Link-local addresses are not, for any entry: a
//   range that covers them stops startup, and an IPv6 answer that carries a link-local IPv4
//   address (mapped, compatible, NAT64, 6to4, Teredo) is refused when it is judged.
// - The check answers one address of those it judged. The connector connects to that address
//   (`pinnedLookup`) and keeps the host as TLS and `Host` name, so the address used is the
//   address checked and a second DNS answer changes nothing.
// - The Platform Store's own host and port are refused whatever the list says, by name and by
//   address. Its addresses are resolved with every judged target. Where they cannot be
//   resolved, every target on the Store's port is refused. Where the Store's address itself
//   could not be read as host and port, every `postgres` target is refused.
// - Plain `http` reaches a private entry only. The release config schema refuses it for a
//   public one, and so does this check.
// - A redirect or a returned download address is a new target: `egressTargetOfUrl` reads it
//   and `check` judges it. An address with a user name or a password is never a target.
// - `egress.allowPublicHttps` is the operator opening every `https` target on port 443 that
//   no entry names. Such a target is judged as a `public` entry, so every answer must be a
//   public address. The Platform Store's host is refused on every port, by name and by
//   address. Plain `http`, `postgres` and every other port still need an entry.
// - A refusal says which setting would let the target through, or that none would.

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
/**
 * How long a refusal is held that came from the resolver and not from a rule: a timeout, a
 * failed lookup or no answer. It is short, so a resolver that was down for a moment does not
 * keep a Connection refused for the time a judged answer is held.
 */
export const EGRESS_RESOLUTION_FAILURE_TTL_MS = 5_000;
/** How long one DNS lookup may take before the target is refused. */
export const EGRESS_RESOLVE_TIMEOUT_MS = 5_000;
/** The default ports of the protocols an address may name without one. */
const DEFAULT_PORTS: Record<EgressProtocol, number> = { https: 443, http: 80, postgres: 5432 };

export interface EgressCheckerOptions {
  allow: readonly EgressAllowEntry[];
  /**
   * Release config `egress.allowPublicHttps`: an `https` target on port 443 that no entry
   * names is judged as a `public` entry. Off unless set.
   */
  allowPublicHttps?: boolean;
  /** The Platform Store's own targets. They are refused always. */
  platformStore?: readonly { host: string; port: number }[];
  /**
   * The Platform Store's address could not be read as hosts and ports. Nobody can then say
   * which database target is the Store, so every `postgres` target is refused.
   */
  platformStoreUnknown?: boolean;
  /** Resolves a host name to every address it has. The system resolver unless given. */
  resolve?: EgressAddressResolver;
  /** The clock of the answer cache, in milliseconds. */
  now?: () => number;
}

/**
 * Why a target was refused, for the setting the refusal names:
 * - `unlisted`: no entry names it. An entry would, and for `https` on 443 the opt-in too.
 * - `not_public`: it is judged as public and an answer is not a public address. Only a
 *   `private` entry with ranges reaches it.
 * - `outside_ranges`: a `private` entry names it and an answer lies outside its `cidrs`.
 * - `store_unresolved`: the Platform Store's name gave no address, so the target cannot be
 *   told apart from it.
 * - `never`: no setting reaches it: link-local, the Platform Store, an answer that is no
 *   routable address, a target that cannot be read.
 */
type EgressDenial = "unlisted" | "not_public" | "outside_ranges" | "store_unresolved" | "never";

const DENIAL_HINTS: Record<Exclude<EgressDenial, "unlisted">, string> = {
  not_public:
    "It resolves to an address that is not public. Only an entry under 'egress.allow' with 'network: private' and the 'cidrs' it lies in reaches it",
  outside_ranges: "It resolves to an address outside the 'cidrs' of its entry under 'egress.allow'",
  store_unresolved:
    "The instance's database host did not resolve, so the target cannot be told apart from it",
  never: "No setting allows it"
};

export function egressDenied(
  target: { protocol?: string; host: string; port: number },
  denial: EgressDenial = "never"
): AppError {
  // Host and port are what the operator's list is written in. Nothing else of the target,
  // no path and no query, is ever part of a refusal.
  const host = printableHost(target.host);
  const hint =
    denial === "unlisted" && target.protocol !== undefined && isEgressProtocol(target.protocol)
      ? egressSettingFor({ protocol: target.protocol, host, port: target.port })
      : DENIAL_HINTS[denial === "unlisted" ? "never" : denial];
  return new AppError(
    "FORBIDDEN",
    `${EGRESS_DENIED}: ${host}:${target.port} is not allowed. ${hint}`,
    { reason: EGRESS_DENIED, host, port: target.port }
  );
}

/**
 * The refusal of a target that is on the list and whose name gave no address: the lookup
 * failed, timed out or answered nothing. Nothing is contacted. It is not `egress_denied`,
 * so nobody is sent to the list for a stopped service or a resolver that is down.
 */
function egressUnresolved(target: { host: string; port: number }): AppError {
  const host = printableHost(target.host);
  return new AppError(
    "CONFLICT",
    `${EGRESS_UNRESOLVED}: ${host}:${target.port} is on the egress list, but the host did not resolve to an address`,
    { reason: EGRESS_UNRESOLVED, host, port: target.port }
  );
}

/** A host as a refusal may repeat it: a name or an address, and nothing that was pasted. */
function printableHost(host: string): string {
  return /^[a-z0-9.:-]{1,253}$/iu.test(host) ? host.toLowerCase() : "(unreadable host)";
}

export { normalizeEgressHost };

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

/**
 * Link-local addresses. On a cloud host they are where the metadata service answers, with
 * the credentials of the machine. No entry reaches them, a `private` one included.
 */
const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");
const LINK_LOCAL_STARTS = { ipv4: "169.254.0.0", ipv6: "fe80::" } as const;
/** The ranges of a `public` entry: none. */
const NO_RANGES = new BlockList();

interface ListedEntry {
  entry: EgressAllowEntry;
  host: string;
  ranges: BlockList;
  /** Named by no entry, let through by `egress.allowPublicHttps`. */
  opened?: true;
}

/** How many judged targets are held at once. Only a list opened by the opt-in comes near. */
const HELD_ANSWERS_MAX = 1_000;

function listEntries(allow: readonly EgressAllowEntry[]): ListedEntry[] {
  return allow.map((entry) => {
    const ranges = new BlockList();
    for (const cidr of entry.cidrs) {
      const range = parseEgressCidr(cidr);
      if (!range) {
        throw new AppError("VALIDATION_FAILED", `egress.allow: '${cidr}' is not a CIDR range`);
      }
      const single = new BlockList();
      single.addSubnet(range.network, range.prefix, range.family);
      // A range inside link-local, or one wide enough to hold it.
      if (
        LINK_LOCAL.check(range.network, range.family) ||
        single.check(LINK_LOCAL_STARTS[range.family], range.family)
      ) {
        throw new AppError(
          "VALIDATION_FAILED",
          `egress.allow: the range '${cidr}' of '${entry.host}' covers link-local addresses (169.254.0.0/16, fe80::/10). No Connection may reach them. Name a narrower range`
        );
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
  // Holds the answer for each target that was asked. A refusal by a rule is held as long as a
  // grant, one that came from the resolver for `EGRESS_RESOLUTION_FAILURE_TTL_MS`. Without
  // `allowPublicHttps` there is at most one entry per line of `egress.allow`; with it any host
  // may be asked, so the map is bounded: expired answers go first, then the oldest.
  const answers = new Map<string, { until: number; answer: Promise<EgressGrant> }>();
  const makeRoom = () => {
    if (answers.size < HELD_ANSWERS_MAX) return;
    const at = now();
    for (const [key, held] of answers) {
      if (held.until <= at) answers.delete(key);
    }
    for (const key of answers.keys()) {
      if (answers.size < HELD_ANSWERS_MAX) break;
      answers.delete(key);
    }
  };

  const addressesOf = async (host: string): Promise<EgressResolvedAddress[]> => {
    const literal = canonicalAddress(host);
    if (literal) {
      return [literal];
    }
    const resolved = await withTimeout(resolve(host), EGRESS_RESOLVE_TIMEOUT_MS);
    // An answer that is no address stays as it is and is refused when it is judged.
    return resolved.map((answer) => canonicalAddress(answer.address) ?? answer);
  };

  /**
   * The addresses the Platform Store answers on the port, or on any port, for the comparison
   * by address. They are resolved each time a target is judged, at the same moment as the target, and
   * are held nowhere else: a judged answer and the Store addresses it was compared with are
   * always of one age, at most `EGRESS_RESOLUTION_TTL_MS`. A Store host that does not
   * resolve throws, and the target is refused: without the Store's addresses nobody can say
   * that a target is not the Store.
   */
  const storeAddressesOn = async (port: number | "any"): Promise<string[]> => {
    const found: string[] = [];
    for (const store of platformStore.filter(
      (candidate) => port === "any" || candidate.port === port
    )) {
      const addresses = await addressesOf(store.host);
      if (addresses.length === 0) {
        throw new Error("The Platform Store host has no address");
      }
      found.push(...addresses.map((entry) => entry.address));
    }
    return found;
  };

  /** The refusals that came from the resolver. They are held for the shorter time. */
  const unresolved = new WeakSet<AppError>();
  const briefly = (error: AppError): AppError => {
    unresolved.add(error);
    return error;
  };

  const judge = async (target: EgressTarget, listed: ListedEntry): Promise<EgressGrant> => {
    let addresses: EgressResolvedAddress[];
    // Only a listed target comes here. Its own name giving no address is the one refusal
    // that is not `egress_denied`.
    try {
      addresses = await addressesOf(target.host);
    } catch {
      throw briefly(egressUnresolved(target));
    }
    if (addresses.length === 0) {
      throw briefly(egressUnresolved(target));
    }
    let store: string[];
    try {
      // A target no entry names is kept off the Store on every port, not only on its own.
      store = await storeAddressesOn(listed.opened ? "any" : target.port);
    } catch {
      // The Platform Store's name gave no address: the target cannot be told apart from it.
      throw briefly(egressDenied(target, "store_unresolved"));
    }
    for (const answer of addresses) {
      // An answer this check cannot read as an address is never connected to.
      if (isIP(answer.address) === 0 || isNeverRoutable(answer)) {
        throw egressDenied(target);
      }
      if (store.includes(answer.address)) {
        throw egressDenied(target);
      }
      const family = answer.family === 4 ? "ipv4" : "ipv6";
      // Link-local as itself, and as the IPv4 address an IPv6 one carries: a `private` range
      // such as `64:ff9b::/96` holds the translated form of 169.254.169.254 too.
      if (
        LINK_LOCAL.check(answer.address, family) ||
        embeddedIpv4AddressesOf(answer.address).some((carried) => LINK_LOCAL.check(carried, "ipv4"))
      ) {
        throw egressDenied(target);
      }
      if (listed.entry.network === "private") {
        if (!listed.ranges.check(answer.address, family)) {
          throw egressDenied(target, "outside_ranges");
        }
      } else if (isBlockedIpAddress(answer.address)) {
        throw egressDenied(target, "not_public");
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

  /**
   * The entry of the list that names the target, or the one `allowPublicHttps` stands for,
   * decided without an address. Otherwise why there is none.
   */
  const listedEntryOf = (target: EgressTarget): ListedEntry | EgressDenial => {
    if (
      !isEgressProtocol(target.protocol) ||
      !isPort(target.port) ||
      !(isHostName(target.host) || isIP(target.host) !== 0)
    ) {
      return "never";
    }
    if (options.platformStoreUnknown === true && target.protocol === "postgres") {
      return "never";
    }
    if (platformStore.some((store) => store.host === target.host && store.port === target.port)) {
      return "never";
    }
    const listed = entries.find(
      (candidate) =>
        candidate.entry.protocol === target.protocol &&
        candidate.host === target.host &&
        candidate.entry.port === target.port
    );
    if (listed) {
      return listed;
    }
    if (options.allowPublicHttps !== true || target.protocol !== "https" || target.port !== 443) {
      return "unlisted";
    }
    if (platformStore.some((store) => store.host === target.host)) {
      return "never";
    }
    return {
      entry: { protocol: "https", host: target.host, port: 443, network: "public", cidrs: [] },
      host: target.host,
      ranges: NO_RANGES,
      opened: true
    };
  };
  const normalized = (input: EgressTarget): EgressTarget => ({
    protocol: input.protocol,
    host: normalizeEgressHost(input.host),
    port: input.port
  });

  return {
    admits: (input) => typeof listedEntryOf(normalized(input)) !== "string",
    async check(input) {
      const target = normalized(input);
      const listed = listedEntryOf(target);
      if (typeof listed === "string") {
        throw egressDenied(target, listed);
      }
      const key = `${target.protocol}|${target.host}|${target.port}`;
      let held = answers.get(key);
      if (!held || held.until <= now()) {
        const asked = now();
        const entry = { until: asked + EGRESS_RESOLUTION_TTL_MS, answer: judge(target, listed) };
        held = entry;
        answers.delete(key);
        makeRoom();
        answers.set(key, entry);
        entry.answer.catch((error: unknown) => {
          if (error instanceof AppError && unresolved.has(error)) {
            entry.until = asked + EGRESS_RESOLUTION_FAILURE_TTL_MS;
          }
        });
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

/**
 * Where the Platform Store listens, read from its connection address. Answers `undefined`
 * where host and port cannot be read exactly as the driver will use them: a Unix socket, a
 * host or port given as a parameter, an address that names several hosts (the driver hands a
 * port on to the hosts that name none), and an address without a port while `PGPORT` is set
 * (the driver then takes that one). `environment` is the environment of the process, which is
 * where the driver reads from. Only host and port leave this function, never the address.
 */
export function platformStoreTargetsOf(
  databaseUrl: string,
  environment: { PGPORT?: string | undefined }
): { host: string; port: number }[] | undefined {
  const match = /^postgres(?:ql)?:\/\/(?:[^@/?#]*@)?([^/?#]*)([^#]*)/iu.exec(databaseUrl.trim());
  if (!match?.[1]) {
    return undefined;
  }
  // A `host` or `port` parameter replaces what the authority says, and a socket is named so.
  if (/[?&](?:host|hostaddr|port)=/iu.test(match[2] ?? "")) {
    return undefined;
  }
  // One host only: a comma is a second host, and it fails the pattern.
  const parsed = /^(\[[0-9a-f:.]+\]|[^:[\],%]+)(?::(\d{1,5}))?$/iu.exec(match[1]);
  if (!parsed?.[1]) {
    return undefined;
  }
  if (parsed[2] === undefined && (environment.PGPORT ?? "") !== "") {
    return undefined;
  }
  const host = normalizeEgressHost(parsed[1]);
  const port = parsed[2] === undefined ? DEFAULT_PORTS.postgres : Number(parsed[2]);
  if (!(isHostName(host) || isIP(host) !== 0) || !isPort(port)) {
    return undefined;
  }
  return [{ host, port }];
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
