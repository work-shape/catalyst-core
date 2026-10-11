import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface WebFetchResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type WebFetchAddressResolver = (hostname: string) => Promise<WebFetchResolvedAddress[]>;

export interface WebFetchTarget {
  url: URL;
  addresses: WebFetchResolvedAddress[];
}

export class WebFetchSafetyError extends Error {
  override readonly name = "WebFetchSafetyError";
}

const blockedMetadataHostnames = new Set([
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal"
]);

export async function validateWebFetchUrl(
  rawUrl: string,
  options: { resolver?: WebFetchAddressResolver } = {}
): Promise<WebFetchTarget> {
  const url = parseWebFetchUrl(rawUrl);
  const hostname = normalizeHostname(url.hostname);
  assertAllowedHostname(hostname);

  const literalIpVersion = isIP(hostname);
  if (literalIpVersion) {
    assertAllowedIpAddress(hostname);
    return {
      url,
      addresses: [{ address: hostname, family: literalIpVersion as 4 | 6 }]
    };
  }

  const resolver = options.resolver ?? nodeWebFetchAddressResolver;
  const addresses = await resolver(hostname);
  if (addresses.length === 0) {
    throw new WebFetchSafetyError(`URL host '${hostname}' did not resolve to an IP address`);
  }

  const blockedAddress = addresses.find((address) => isBlockedIpAddress(address.address));
  if (blockedAddress) {
    throw new WebFetchSafetyError(
      `URL host '${hostname}' resolves to blocked address '${blockedAddress.address}'`
    );
  }

  return {
    url,
    addresses
  };
}

export async function nodeWebFetchAddressResolver(
  hostname: string
): Promise<WebFetchResolvedAddress[]> {
  const results = await lookup(hostname, {
    all: true,
    verbatim: true
  });
  return results
    .filter((result) => result.family === 4 || result.family === 6)
    .map((result) => ({
      address: result.address,
      family: result.family as 4 | 6
    }));
}

export function isBlockedIpAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return isBlockedIpv4Address(address);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6Address(address);
  }
  return true;
}

function parseWebFetchUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchSafetyError("URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchSafetyError("Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new WebFetchSafetyError("URL credentials are not allowed");
  }
  if (url.port) {
    throw new WebFetchSafetyError("Only default http and https ports are allowed");
  }
  if (!url.hostname) {
    throw new WebFetchSafetyError("URL host is required");
  }

  return url;
}

function assertAllowedHostname(hostname: string): void {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WebFetchSafetyError(`URL host '${hostname}' is blocked`);
  }
  if (blockedMetadataHostnames.has(hostname)) {
    throw new WebFetchSafetyError(`URL host '${hostname}' is blocked as a metadata host`);
  }
}

function assertAllowedIpAddress(address: string): void {
  if (isBlockedIpAddress(address)) {
    throw new WebFetchSafetyError(`URL address '${address}' is blocked`);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/gu, "");
}

function isBlockedIpv4Address(address: string): boolean {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return true;
  }
  const [first, second, third, fourth] = octets;

  if (first === 0) return true;
  if (first === 10) return true;
  if (first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 192 && second === 0) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 224 || first > 224) return true;
  if (first === 100 && second === 100 && third === 100 && fourth === 200) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;

  return false;
}

function parseIpv4Octets(address: string): [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets as [number, number, number, number];
}

function isBlockedIpv6Address(address: string): boolean {
  const bytes = parseIpv6Bytes(address);
  if (!bytes) {
    return true;
  }

  // An IPv6 address that carries an IPv4 one reaches that IPv4 address, through the host
  // itself or through a translator or relay. Each carried address is judged by the IPv4 rules.
  if (embeddedIpv4Addresses(bytes).some(isBlockedIpv4Address)) {
    return true;
  }

  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  const [first, second, third, fourth] = bytes;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    return true;
  }
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe) return true;
  if (first === 0xff) return true;
  if (first === 0x20 && second === 0x01 && third === 0x0d && fourth === 0xb8) {
    return true;
  }

  return false;
}

/**
 * The IPv4 addresses an IPv6 address carries:
 * - IPv4-mapped `::ffff:a.b.c.d` and IPv4-compatible `::a.b.c.d`, the last four bytes;
 * - NAT64 `64:ff9b::/96`, the last four bytes;
 * - 6to4 `2002::/16`, the four bytes after the prefix;
 * - Teredo `2001:0::/32`, the server after the prefix and the client in the last four
 *   bytes, which Teredo stores inverted.
 */
function embeddedIpv4Addresses(bytes: number[]): string[] {
  const dotted = (start: number, invert = false) =>
    bytes
      .slice(start, start + 4)
      .map((byte) => (invert ? byte ^ 0xff : byte))
      .join(".");
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);

  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return [dotted(12)];
  // `::` and `::1` are no carried address; they are refused as themselves.
  if (zero(0, 12) && !(zero(12, 15) && (bytes[15] ?? 0) <= 1)) return [dotted(12)];
  if (starts(0x00, 0x64, 0xff, 0x9b) && zero(4, 12)) return [dotted(12)];
  if (starts(0x20, 0x02)) return [dotted(2)];
  if (starts(0x20, 0x01, 0x00, 0x00)) return [dotted(4), dotted(12, true)];
  return [];
}

/**
 * The IPv4 addresses an IPv6 address carries, for a caller that judges them by rules of its
 * own. Empty for an IPv4 address and for one that cannot be read.
 */
export function embeddedIpv4AddressesOf(address: string): string[] {
  if (isIP(address) !== 6) {
    return [];
  }
  const bytes = parseIpv6Bytes(address);
  return bytes ? embeddedIpv4Addresses(bytes) : [];
}

function parseIpv6Bytes(address: string): number[] | undefined {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const expanded = expandEmbeddedIpv4(normalized);
  const parts = expanded.split("::");
  if (parts.length > 2) {
    return undefined;
  }

  const left = parseIpv6Groups(parts[0] ?? "");
  const right = parseIpv6Groups(parts[1] ?? "");
  if (!left || !right) {
    return undefined;
  }

  const missing = 8 - left.length - right.length;
  if (parts.length === 1 && missing !== 0) {
    return undefined;
  }
  if (parts.length === 2 && missing < 1) {
    return undefined;
  }

  const groups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...right];
  if (groups.length !== 8) {
    return undefined;
  }

  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function expandEmbeddedIpv4(address: string): string {
  if (!address.includes(".")) {
    return address;
  }
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) {
    return address;
  }
  const ipv4 = address.slice(lastColon + 1);
  const octets = parseIpv4Octets(ipv4);
  if (!octets) {
    return address;
  }
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  return `${address.slice(0, lastColon)}:${high}:${low}`;
}

function parseIpv6Groups(input: string): number[] | undefined {
  if (!input) {
    return [];
  }
  const groups = input.split(":");
  const parsed = groups.map((group) => Number.parseInt(group, 16));
  if (
    groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group)) ||
    parsed.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) {
    return undefined;
  }
  return parsed;
}
