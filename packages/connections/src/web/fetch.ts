import { AppError, DocumentSourceError, type ConnectorContext } from "@work-shape/catalyst-core";
import type { SourceHttpResponse, SourceHttpTransport } from "../document-source/http";
import { retryAfterSeconds } from "../retry-after";
import { ALLOW_ALL, parseRobots, type RobotsRules } from "./robots";
import { hostKeyOf, type WebSettings } from "./settings";

// Every request of a web source, and the rules each one keeps (KB-WEB):
// - Only `https`, only to a host the Connection lists, and only after the egress checker granted
//   the host as a public one: the checker refuses an address that is not public unless the
//   operator's list names it as private, and the walk refuses such a private grant as well, so a
//   page can never send it to an internal address.
// - No redirect is followed by the transport. Each one is a new address, checked as the first:
//   listed host, egress, robots.txt. At most five.
// - `robots.txt` of each host is read first and honoured. One that cannot be read now makes the
//   host unavailable, never closed: only a rule that disallows a page keeps it out. At most one
//   request a second per host,
//   slower where `Crawl-delay` asks, faster only where the Connection's `requestsPerSecond` says.
// - A clear user agent; no cookie, no credential, no form post. A body is read only up to the
//   cap its caller names.

/** How many redirects one request follows. */
const REDIRECTS_MAX = 5;
/** How long a host's `robots.txt` is kept. A failed read is not kept: the next request reads it again. */
const ROBOTS_TTL_MS = 60 * 60_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
/** How many hosts' robots.txt and pacing one process remembers. */
const HOSTS_REMEMBERED_MAX = 1_000;

/** Why the walk did not read an address. None of these is a fault of the source. */
export type WebRefusalReason = "host" | "egress" | "robots" | "redirects" | "too_large";

export class WebRefusal extends Error {
  constructor(readonly reason: WebRefusalReason) {
    super(`The web source did not read the address (${reason})`);
    this.name = "WebRefusal";
  }
}

export interface WebFetchDeps {
  transport: SourceHttpTransport;
  /** The user agent of every request, naming the instance. */
  userAgent: string;
  /** The product token `robots.txt` groups are matched against. */
  productToken: string;
  /** The clock of the dates a source answers and of its hourly feed. Pacing keeps real time. */
  now(): number;
}

export interface WebResponse {
  /** Where the answer came from, after redirects. */
  url: URL;
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: SourceHttpResponse;
}

const robotsByHost = new Map<string, { until: number; rules: Promise<RobotsRules> }>();
const nextSlotByHost = new Map<string, number>();

function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size >= HOSTS_REMEMBERED_MAX && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DocumentSourceError("unavailable", "The web source call ended"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new DocumentSourceError("unavailable", "The web source call ended"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Reads a body whole, up to `cap` bytes; a longer one is refused and closed unread. */
export async function readCapped(body: SourceHttpResponse, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await body.read(Math.min(65_536, cap - size + 1));
      if (chunk === undefined) break;
      size += chunk.byteLength;
      if (size > cap) throw new WebRefusal("too_large");
      chunks.push(chunk);
    }
  } finally {
    body.close();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

/** A failure the answer's status names, as a document source names it. */
export function statusFailure(response: WebResponse): DocumentSourceError {
  const { status } = response;
  if (status === 404 || status === 410)
    return new DocumentSourceError("not_found", "The page is gone");
  // Only 404 and 410 say a page is gone. 401 and 403 may be a host's passing refusal, so the
  // document is kept and read again later.
  if (status === 401 || status === 403)
    return new DocumentSourceError("unavailable", "The page is not public now");
  if (status === 429 || status === 503) {
    const seconds = retryAfterSeconds(response.headers["retry-after"]);
    return new DocumentSourceError("rate_limited", "The host asked to wait", {
      retryAfterMs: Math.min(Math.max(seconds ?? 60, 1), 3_600) * 1_000
    });
  }
  return new DocumentSourceError("unavailable", `The host answered ${String(status)}`);
}

/** The requests of one call of a web source, under one Connection's settings. */
export function createWebSession(
  context: ConnectorContext,
  settings: WebSettings,
  deps: WebFetchDeps
) {
  const hosts = new Set(settings.hosts);
  const intervalMs = 1_000 / (settings.requestsPerSecond ?? 1);
  const scope = context.connection.id;

  /** A listed host on `https`: the only addresses the source reads. */
  const listed = (url: URL) =>
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    hosts.has(hostKeyOf(url));

  async function pace(host: string, delayMs: number | undefined) {
    const key = `${scope}\u0000${host}`;
    // Real time, whatever clock the source reads dates from.
    const now = Date.now();
    const at = Math.max(now, nextSlotByHost.get(key) ?? 0);
    remember(nextSlotByHost, key, at + Math.max(intervalMs, delayMs ?? 0));
    if (at > now) await sleep(at - now, context.signal);
  }

  async function send(url: URL, headers: Record<string, string>, delayMs?: number) {
    if (!listed(url)) throw new WebRefusal("host");
    await pace(url.host, delayMs);
    let grant;
    try {
      grant = await context.checkEgress({
        protocol: "https",
        host: url.hostname,
        port: url.port === "" ? 443 : Number(url.port)
      });
    } catch (error) {
      if (error instanceof AppError) throw new WebRefusal("egress");
      throw error;
    }
    // A web source reads public HTTPS only: an entry of the operator's list that names a private
    // network is for other Connections, never for pages.
    if (grant.network !== "public") throw new WebRefusal("egress");
    try {
      return await deps.transport({
        url,
        grant,
        method: "GET",
        headers: {
          "user-agent": deps.userAgent,
          "accept-encoding": "identity",
          ...headers
        },
        signal: context.signal
      });
    } catch (error) {
      if (error instanceof DocumentSourceError) throw error;
      context.signal.throwIfAborted();
      throw new DocumentSourceError("unavailable", "The host did not answer");
    }
  }

  /** Follows redirects, each checked as the first address was. */
  async function follow(
    start: URL,
    headers: Record<string, string>,
    rules: (url: URL) => Promise<RobotsRules | undefined>
  ): Promise<WebResponse> {
    let url = start;
    for (let hop = 0; ; hop++) {
      if (!listed(url)) throw new WebRefusal("host");
      const robots = await rules(url);
      if (robots && !robots.allows(`${url.pathname}${url.search}`)) throw new WebRefusal("robots");
      const response = await send(url, headers, robots?.crawlDelayMs);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
        response.close();
        if (hop >= REDIRECTS_MAX) throw new WebRefusal("redirects");
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new WebRefusal("redirects");
        }
        next.hash = "";
        url = next;
        continue;
      }
      return { url, status: response.status, headers: response.headers, body: response };
    }
  }

  async function readRobots(url: URL): Promise<RobotsRules> {
    try {
      const response = await follow(new URL("/robots.txt", url), { accept: "text/plain" }, () =>
        Promise.resolve(undefined)
      );
      if (response.status >= 200 && response.status < 300) {
        const bytes = await readCapped(response.body, ROBOTS_MAX_BYTES);
        return parseRobots(new TextDecoder().decode(bytes), deps.productToken);
      }
      response.body.close();
      // RFC 9309: a robots.txt that is not there allows everything; a server error, nothing.
      if (response.status >= 400 && response.status < 500 && response.status !== 429)
        return ALLOW_ALL;
      throw new DocumentSourceError("unavailable", "robots.txt could not be read");
    } catch (error) {
      if (error instanceof WebRefusal && error.reason === "too_large") return ALLOW_ALL;
      context.signal.throwIfAborted();
      throw error;
    }
  }

  /**
   * The rules of the address's host, read once an hour. A host whose robots.txt cannot be read
   * now is unavailable: no page of it is read, and none is withdrawn for it.
   */
  async function robotsOf(url: URL): Promise<RobotsRules> {
    const key = `${scope}\u0000${url.host}`;
    const now = Date.now();
    const known = robotsByHost.get(key);
    if (known && known.until > now) return known.rules;
    const rules = readRobots(url).catch((error: unknown) => {
      robotsByHost.delete(key);
      // A refusal of the host itself refuses the page as well.
      if (
        context.signal.aborted ||
        (error instanceof WebRefusal && (error.reason === "host" || error.reason === "egress")) ||
        error instanceof DocumentSourceError
      )
        throw error;
      if (error instanceof WebRefusal)
        throw new DocumentSourceError("unavailable", "robots.txt could not be read");
      throw error;
    });
    remember(robotsByHost, key, { until: now + ROBOTS_TTL_MS, rules });
    return rules;
  }

  return {
    listed,
    /** A GET of a page, with robots.txt, redirects and egress checked on every hop. */
    get(url: URL, headers: Record<string, string> = {}): Promise<WebResponse> {
      return follow(url, headers, robotsOf);
    }
  };
}

export type WebSession = ReturnType<typeof createWebSession>;
