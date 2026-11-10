import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  DocumentSourceError,
  type ConnectorContext,
  type DocumentSourceBoundary,
  type DocumentSourceCapability,
  type DocumentSourceChange,
  type DocumentSourceItem,
  type DocumentSourceWebBoundary
} from "@work-shape/catalyst-core";
import {
  createWebSession,
  readCapped,
  statusFailure,
  WebRefusal,
  type WebFetchDeps,
  type WebResponse,
  type WebSession
} from "./fetch";
import { readHtmlPage } from "./html";
import { webSettingsSchema } from "./settings";

// The `document_source` capability of the `web` Connector type (KB-WEB). Spec:
// data-stores-and-knowledge-bases.md, "Web pages as a synced source".
//
// - `list` walks the boundary: each page as named, everything linked below a prefix on its own
//   host to `maxDepth`, and the pages a sitemap lists. A link to another host is never followed.
//   A walk is many calls: its position (the addresses still to read and those seen) is the
//   page token, so every call is bounded in time and requests.
// - `changes` walks the boundary again at most hourly, with `If-None-Match` and
//   `If-Modified-Since` where an earlier walk of this process kept the validators. It answers the
//   pages whose text changed and, as deleted, those that answer 404 or 410 or that robots.txt now
//   keeps out. A page that left the boundary goes at the next full pass, which withdraws what it
//   did not list.
// - An item's id is its address; its version is the hash of the main text (HTML) or the
//   validators of the file (PDF, DOCX, TXT), so an unchanged page costs no extraction or embedding.
// - `fetch` reads the page again and answers its main text as Markdown, or the file's bytes.
// - Each document's `modifiedAt` is the date the page states of itself, else its
//   `Last-Modified`, else the sitemap's `lastmod`, else when this version was first read.

/** How long one call walks, well inside its deadline. */
const STEP_MS = 20_000;
/** How many items one call answers at most. */
const STEP_ITEMS = 200;
/** How many addresses one pass reads at most; `knowledge.maxDocuments` applies besides. */
const PASS_URLS_MAX = 10_000;
/** The largest HTML page and sitemap read; a larger one is left out. */
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const SITEMAP_MAX_BYTES = 20 * 1024 * 1024;
/** The largest file hashed for its version where the host sends no validator. */
const DOCUMENT_HASH_MAX_BYTES = 100 * 1024 * 1024;
/** How often one address may fail for a moment in a pass before the pass fails. */
const FAILURES_MAX = 3;
/** How often a `changes` poll walks again at most. */
const CHANGES_INTERVAL_MS = 60 * 60_000;
/** How deep sitemap indexes nest. */
const SITEMAP_DEPTH_MAX = 2;
/** How many pages' validators and links one process keeps. */
const REMEMBERED_PAGES_MAX = 10_000;
/** How many links of one page the walk keeps. */
const LINKS_KEPT_MAX = 1_000;

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
/** The files a linked address may be, by type and by extension. */
const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/markdown": "md"
};
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown"
};
const ACCEPT =
  "text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain;q=0.9,*/*;q=0.1";

/** An address still to read: its kind, the boundary entry it was found from, its depth. */
const entrySchema = z.strictObject({
  u: z.string(),
  k: z.enum(["page", "prefix", "sitemap", "link"]),
  /** The index of the boundary address it was found from, in `folderIds`. */
  p: z.number().int().min(0),
  d: z.number().int().min(0).optional(),
  /** The sitemap's `lastmod`. */
  m: z.string().optional(),
  /** How often it failed for a moment in this pass. */
  f: z.number().int().min(1).optional()
});
type Entry = z.infer<typeof entrySchema>;

const walkSchema = z.strictObject({ q: z.array(entrySchema), s: z.array(z.string()) });
type Walk = z.infer<typeof walkSchema>;

const listTokenSchema = z.strictObject({ v: z.literal(1), b: z.string(), w: walkSchema });
const feedCursorSchema = z.strictObject({
  v: z.literal(1),
  b: z.string(),
  /** When the last walk of the feed ended, in milliseconds. */
  at: z.number(),
  w: walkSchema.optional()
});

function decoded<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const seenKey = (url: string) => sha(url).slice(0, 16);

/** A pattern as a source's `include` and `exclude` write it: `**`, `*` and `?` are wildcards. */
function globOf(pattern: string): RegExp {
  let body = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern[index + 1] === "*") {
      body += ".*";
      index++;
    } else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${body}$`, "u");
}

/** What the source keeps of a page between walks of this process: its validators and links. */
interface Remembered {
  etag?: string;
  lastModified?: string;
  item: Omit<DocumentSourceItem, "parents">;
  links: string[];
}

const rememberedPages = new Map<string, Remembered>();

function recall(key: string): Remembered | undefined {
  const found = rememberedPages.get(key);
  if (found) {
    rememberedPages.delete(key);
    rememberedPages.set(key, found);
  }
  return found;
}

function keep(key: string, value: Remembered) {
  rememberedPages.delete(key);
  if (rememberedPages.size >= REMEMBERED_PAGES_MAX) {
    const oldest = rememberedPages.keys().next();
    if (!oldest.done) rememberedPages.delete(oldest.value);
  }
  rememberedPages.set(key, value);
}

/** A date header as an ISO time, or nothing. */
function httpDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function mediaType(headers: WebResponse["headers"]): string {
  return (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The page's text in its charset: the header's, else the page's own meta, else UTF-8. */
function decodeText(bytes: Uint8Array, contentType: string | undefined): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2_048));
  const label =
    /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** The last segment of the address, decoded, as a file name. */
function lastSegment(url: URL): string {
  const segment =
    url.pathname
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The name an item of a page shows: its title, never ending in a file extension it does not have. */
function pageName(title: string | undefined, url: URL): string {
  const name = (title ?? "").trim() || lastSegment(url) || url.host;
  return name.replace(/\.(pdf|docx?|xlsx?|pptx?|txt|md|markdown)$/iu, "").slice(0, 300) || url.host;
}

function pathOf(url: URL): string {
  try {
    return decodeURIComponent(url.pathname).slice(0, 4_000);
  } catch {
    return url.pathname.slice(0, 4_000);
  }
}

/** A web boundary, checked against the Connection's hosts and read for the walk. */
function readBoundary(boundary: DocumentSourceBoundary, session: WebSession) {
  const web: DocumentSourceWebBoundary | undefined = boundary.web;
  if (!web)
    throw new DocumentSourceError("unavailable", "A web source reads addresses, not folders");
  const ids = boundary.folderIds;
  const all = [...web.pages, ...web.prefixes, ...web.sitemaps];
  for (const address of all) {
    if (!URL.canParse(address) || !session.listed(new URL(address)))
      throw new DocumentSourceError(
        "unauthorized",
        "The source names an address on a host its Connection does not list"
      );
  }
  const include = web.include?.map(globOf);
  const exclude = web.exclude?.map(globOf);
  const prefixes = web.prefixes.map((address) => new URL(address));
  return {
    web,
    ids,
    key: sha(JSON.stringify(web)).slice(0, 24),
    /** Whether an address's path is named by `include` and not by `exclude`. */
    wanted(url: URL) {
      const path = pathOf(url);
      return (
        (!include || include.some((pattern) => pattern.test(path))) &&
        !exclude?.some((pattern) => pattern.test(path))
      );
    },
    excluded(url: URL) {
      const path = pathOf(url);
      return exclude?.some((pattern) => pattern.test(path)) === true;
    },
    /** The prefix of the boundary an address lies below, by its index in `prefixes`. */
    prefixOf(url: URL): number {
      return prefixes.findIndex(
        (prefix) => prefix.host === url.host && url.pathname.startsWith(prefix.pathname)
      );
    },
    /**
     * Whether an address may be fetched as an item of this boundary: on a listed host and not
     * excluded. A page may have been reached by a redirect, so its address need not be named.
     */
    holds(url: URL): boolean {
      return session.listed(url) && !this.excluded(url);
    },
    start(): Walk {
      const q: Entry[] = [
        ...web.pages.map((u) => ({ u, k: "page" as const, p: ids.indexOf(u) })),
        ...web.prefixes.map((u) => ({ u, k: "prefix" as const, p: ids.indexOf(u), d: 0 })),
        ...web.sitemaps.map((u) => ({ u, k: "sitemap" as const, p: ids.indexOf(u), d: 0 }))
      ].map((entry) => ({ ...entry, p: Math.max(entry.p, 0) }));
      return { q, s: q.map((entry) => seenKey(entry.u)) };
    }
  };
}

type Boundary = ReturnType<typeof readBoundary>;

/** One bounded part of a walk: the items it found and the addresses that are gone. */
async function walkStep(
  session: WebSession,
  boundary: Boundary,
  walk: Walk,
  options: { scope: string; onlyChanged: boolean; now: () => number; signal: AbortSignal }
): Promise<{ items: DocumentSourceItem[]; gone: string[] }> {
  const seen = new Set(walk.s);
  const items: DocumentSourceItem[] = [];
  const gone: string[] = [];
  const started = Date.now();
  const enqueue = (entry: Entry) => {
    const key = seenKey(entry.u);
    if (seen.has(key) || seen.size >= PASS_URLS_MAX || entry.u.length > 500) return;
    seen.add(key);
    walk.s.push(key);
    walk.q.push(entry);
  };
  const parentOf = (entry: Entry) => boundary.ids[entry.p] ?? boundary.ids[0] ?? entry.u;

  const emit = (entry: Entry, item: Omit<DocumentSourceItem, "parents">, changed: boolean) => {
    if (options.onlyChanged && !changed) return;
    if (!boundary.wanted(new URL(item.id))) return;
    items.push({ ...item, parents: [parentOf(entry)] });
  };

  /** Follows the links of a page reached from a prefix, one level deeper. */
  const follow = (entry: Entry, links: readonly string[]) => {
    if (entry.k !== "prefix" && entry.k !== "link") return;
    const depth = (entry.d ?? 0) + 1;
    if (depth > boundary.web.maxDepth + 1) return;
    for (const link of links) {
      const url = new URL(link);
      if (boundary.prefixOf(url) === -1 || boundary.excluded(url) || !session.listed(url)) continue;
      // A file linked from the deepest page is still read: it links nothing further.
      const extension = lastSegment(url).split(".").at(-1)?.toLowerCase() ?? "";
      if (depth > boundary.web.maxDepth && !DOCUMENT_EXTENSIONS[extension]) continue;
      enqueue({ u: url.href, k: "link", p: entry.p, d: depth });
    }
  };

  async function sitemap(entry: Entry) {
    const response = await session.get(new URL(entry.u), {
      accept: "application/xml,text/xml,*/*;q=0.1"
    });
    if (response.status < 200 || response.status >= 300) {
      response.body.close();
      throw statusFailure(response);
    }
    let bytes = await readCapped(response.body, SITEMAP_MAX_BYTES);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      try {
        bytes = gunzipSync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES });
      } catch {
        throw new WebRefusal("too_large");
      }
    }
    const xml = new TextDecoder().decode(bytes);
    const loc = (block: string) =>
      /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/iu
        .exec(block)?.[1]
        ?.trim()
        .replace(/&amp;/gu, "&");
    if (/<sitemapindex\b/iu.test(xml)) {
      if ((entry.d ?? 0) >= SITEMAP_DEPTH_MAX) return;
      for (const block of xml.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/giu)) {
        const address = loc(block[0]);
        if (!address || !URL.canParse(address)) continue;
        const url = new URL(address);
        if (session.listed(url))
          enqueue({ u: url.href, k: "sitemap", p: entry.p, d: (entry.d ?? 0) + 1 });
      }
      return;
    }
    for (const block of xml.matchAll(/<url\b[\s\S]*?<\/url>/giu)) {
      const address = loc(block[0]);
      if (!address || !URL.canParse(address)) continue;
      const url = new URL(address);
      url.hash = "";
      if (!session.listed(url) || !boundary.wanted(url)) continue;
      const lastmod = httpDate(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/iu.exec(block[0])?.[1]);
      enqueue({ u: url.href, k: "page", p: entry.p, ...(lastmod ? { m: lastmod } : {}) });
    }
  }

  async function page(entry: Entry) {
    const url = new URL(entry.u);
    const key = `${options.scope}\u0000${entry.u}`;
    const known = recall(key);
    const headers: Record<string, string> = { accept: ACCEPT };
    if (known?.etag) headers["if-none-match"] = known.etag;
    if (known?.lastModified) headers["if-modified-since"] = known.lastModified;
    const response = await session.get(url, headers);
    // A redirect that leaves the boundary, or lands on an address read already, adds nothing.
    if (response.url.href !== entry.u) {
      const landed = response.url;
      const inside = entry.k === "page" ? session.listed(landed) : boundary.prefixOf(landed) !== -1;
      if (!inside || seen.has(seenKey(landed.href))) {
        response.body.close();
        return;
      }
      seen.add(seenKey(landed.href));
      walk.s.push(seenKey(landed.href));
    }
    if (response.status === 304 && known) {
      response.body.close();
      emit(entry, known.item, false);
      follow(entry, known.links);
      return;
    }
    if (response.status < 200 || response.status >= 300) {
      response.body.close();
      throw statusFailure(response);
    }
    const id = response.url.href;
    const type = mediaType(response.headers);
    const etag = response.headers.etag;
    const lastModified = response.headers["last-modified"];
    const firstSeen = (version: string) =>
      known?.item.version === version
        ? known.item.modifiedAt
        : new Date(options.now()).toISOString();
    if (HTML_TYPES.has(type)) {
      const bytes = await readCapped(response.body, PAGE_MAX_BYTES);
      const read = readHtmlPage(decodeText(bytes, response.headers["content-type"]), response.url);
      const version = `h${sha(read.markdown).slice(0, 40)}`;
      const item = {
        id,
        version,
        path: pathOf(response.url),
        name: pageName(read.title, response.url),
        mime: "text/markdown",
        size: Buffer.byteLength(read.markdown),
        modifiedAt: read.statedDate ?? httpDate(lastModified) ?? entry.m ?? firstSeen(version),
        originLink: id
      };
      const links = read.links
        .filter((link) => boundary.prefixOf(new URL(link)) !== -1)
        .slice(0, LINKS_KEPT_MAX);
      keep(key, {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        item,
        links
      });
      emit(entry, item, known?.item.version !== version);
      follow(entry, links);
      return;
    }
    const extension = lastSegment(response.url).split(".").at(-1)?.toLowerCase() ?? "";
    const mime = DOCUMENT_TYPES[type] ? type : DOCUMENT_EXTENSIONS[extension];
    if (!mime) {
      response.body.close();
      return;
    }
    const length = Number(response.headers["content-length"]);
    const size = Number.isSafeInteger(length) && length >= 0 ? length : undefined;
    let version: string;
    if (etag) version = `e${sha(etag).slice(0, 40)}`;
    else if (lastModified) version = `m${sha(`${lastModified}\u0000${String(size)}`).slice(0, 40)}`;
    else version = `b${sha(await readCapped(response.body, DOCUMENT_HASH_MAX_BYTES)).slice(0, 40)}`;
    response.body.close();
    const suffix = DOCUMENT_TYPES[mime] ?? extension;
    const segment = lastSegment(response.url) || response.url.host;
    const item = {
      id,
      version,
      path: pathOf(response.url),
      name: (segment.toLowerCase().endsWith(`.${suffix}`) ? segment : `${segment}.${suffix}`).slice(
        0,
        300
      ),
      mime,
      ...(size === undefined ? {} : { size }),
      modifiedAt: httpDate(lastModified) ?? entry.m ?? firstSeen(version),
      originLink: id
    };
    keep(key, {
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      item,
      links: []
    });
    emit(entry, item, known?.item.version !== version);
  }

  while (walk.q.length > 0 && items.length < STEP_ITEMS && Date.now() - started < STEP_MS) {
    options.signal.throwIfAborted();
    const entry = walk.q.shift();
    if (!entry) break;
    try {
      if (entry.k === "sitemap") await sitemap(entry);
      else await page(entry);
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof WebRefusal) {
        // robots.txt keeps it out now: it goes, as a deleted page does.
        if (error.reason === "robots") gone.push(entry.u);
        continue;
      }
      if (error instanceof DocumentSourceError) {
        if (error.sourceCode === "not_found" || error.sourceCode === "forbidden") {
          gone.push(entry.u);
          continue;
        }
        if (error.sourceCode === "rate_limited" || error.sourceCode === "unavailable") {
          const failures = (entry.f ?? 0) + 1;
          // One page that keeps failing fails the pass, which then withdraws nothing.
          if (failures >= FAILURES_MAX) throw error;
          walk.q.push({ ...entry, f: failures });
          continue;
        }
      }
      throw error;
    }
  }
  return { items, gone };
}

/** The capability, with the requests of each call made through its own session. */
export function createWebSource(deps: WebFetchDeps): DocumentSourceCapability {
  const open = (context: ConnectorContext) => {
    const settings = webSettingsSchema.safeParse(context.connection.settings);
    if (!settings.success)
      throw new DocumentSourceError("unauthorized", "The web Connection's settings are invalid");
    return createWebSession(context, settings.data, deps);
  };
  const options = (context: ConnectorContext, onlyChanged: boolean) => ({
    scope: context.connection.id,
    onlyChanged,
    now: deps.now,
    signal: context.signal
  });

  return {
    async list(input, context) {
      const session = open(context);
      const boundary = readBoundary(input.boundary, session);
      let walk: Walk;
      if (input.pageToken === undefined) walk = boundary.start();
      else {
        const token = decoded(listTokenSchema, input.pageToken);
        if (!token || token.b !== boundary.key)
          throw new DocumentSourceError(
            "unavailable",
            "The listing position is not this boundary's"
          );
        walk = token.w;
      }
      const { items } = await walkStep(session, boundary, walk, options(context, false));
      return {
        items,
        ...(walk.q.length > 0
          ? { nextPageToken: JSON.stringify({ v: 1, b: boundary.key, w: walk }) }
          : {})
      };
    },

    async changes(input, context) {
      const session = open(context);
      const boundary = readBoundary(input.boundary, session);
      const now = deps.now();
      const position = (at: number, walk?: Walk) =>
        JSON.stringify({ v: 1, b: boundary.key, at, ...(walk ? { w: walk } : {}) });
      if (input.cursor === undefined)
        return { kind: "changes", changes: [], nextCursor: position(now) };
      const cursor = decoded(feedCursorSchema, input.cursor);
      if (!cursor || cursor.b !== boundary.key)
        throw new DocumentSourceError("cursor_expired", "The position is not this boundary's");
      if (!cursor.w && now - cursor.at < CHANGES_INTERVAL_MS)
        return { kind: "changes", changes: [], nextCursor: input.cursor };
      const walk = cursor.w ?? boundary.start();
      const { items, gone } = await walkStep(session, boundary, walk, options(context, true));
      const changes: DocumentSourceChange[] = [
        ...items.map((item) => ({ kind: "upsert" as const, item })),
        ...gone.map((id) => ({ kind: "delete" as const, item: { id } }))
      ];
      return {
        kind: "changes",
        changes,
        nextCursor: walk.q.length > 0 ? position(cursor.at, walk) : position(deps.now())
      };
    },

    async *fetch(input, context) {
      const session = open(context);
      if (!URL.canParse(input.itemId))
        throw new DocumentSourceError("not_found", "The item is no web address");
      const url = new URL(input.itemId);
      if (!session.listed(url))
        throw new DocumentSourceError("forbidden", "The host is not listed");
      if (input.boundary?.web && !readBoundary(input.boundary, session).holds(url))
        throw new DocumentSourceError("forbidden", "The address left the boundary");
      let response: WebResponse;
      try {
        response = await session.get(url, { accept: ACCEPT });
      } catch (error) {
        if (error instanceof WebRefusal)
          throw new DocumentSourceError(
            error.reason === "egress" ? "unavailable" : "forbidden",
            "The address is not read"
          );
        throw error;
      }
      if (response.status < 200 || response.status >= 300) {
        response.body.close();
        throw statusFailure(response);
      }
      if (HTML_TYPES.has(mediaType(response.headers))) {
        let bytes: Uint8Array;
        try {
          bytes = await readCapped(
            response.body,
            Math.min(PAGE_MAX_BYTES, Math.max(input.maxBytes, 1))
          );
        } catch (error) {
          if (error instanceof WebRefusal)
            throw new DocumentSourceError("over_limit", "The page is larger than the cap");
          throw error;
        }
        const text = new TextEncoder().encode(
          readHtmlPage(decodeText(bytes, response.headers["content-type"]), response.url).markdown
        );
        if (text.byteLength > input.maxBytes)
          throw new DocumentSourceError("over_limit", "The page is larger than the cap");
        yield text;
        return;
      }
      let total = 0;
      try {
        for (;;) {
          const chunk = await response.body.read(Math.min(65_536, input.maxBytes - total + 1));
          if (chunk === undefined) return;
          total += chunk.byteLength;
          if (total > input.maxBytes)
            throw new DocumentSourceError("over_limit", "The file is larger than the cap");
          yield chunk;
        }
      } finally {
        response.body.close();
      }
    }
  };
}
