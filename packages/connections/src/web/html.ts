// What a web source reads of an HTML page (KB-WEB): its main text as Markdown, its title, the
// links on it and the date it states. HTML is reduced before extraction, so navigation, scripts
// and forms never reach the index. Regular expressions, not a DOM: a page is untrusted input,
// read once and bounded by the caller's size cap, and nothing of it is ever executed.
//
// Every pass over the page is linear in its length, because it runs synchronously in the sync
// worker and no signal stops it: a tag pattern stops at the next `<` (`[^<>]*`), and an element is
// found by scanning forward from its opening tag to its closing one, once.

/** What a page gives the walk and the index. */
export interface WebPage {
  title?: string;
  /** The main text, with headings as `#` lines, starting with the title. */
  markdown: string;
  /** Every link on the page, absolute, without a fragment, in page order and each once. */
  links: string[];
  /** The date the page states of itself, as an ISO time, where it states one. */
  statedDate?: string;
}

/** How many links one page gives the walk at most. */
const LINKS_MAX = 2_000;

/** How many labels of a date ("Stand") one page is searched for. */
const DATE_LABELS_MAX = 100;

const HIDDEN = ["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas"];
const CHROME = ["nav", "header", "footer", "aside", "form", "menu", "dialog", "button", "select"];
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const TAG = /<[^<>]*>/gu;

/**
 * Replaces each element `<name …>…</name>` of one of `names`, in one forward pass. Elements of
 * one name do not nest, as a lazy pattern reads them. One whose closing tag never comes is kept
 * as it is, or with `dropUnclosed` cut with everything after it, as a browser runs an unclosed
 * script to the end. A closing tag looked for and not found is not looked for again.
 */
function replaceElements(
  html: string,
  names: readonly string[],
  replace: (name: string, inner: string) => string,
  dropUnclosed = false
): string {
  const opener = new RegExp(`<(${names.join("|")})\\b[^<>]*>`, "giu");
  const closers = new Map<string, RegExp | undefined>();
  let out = "";
  let from = 0;
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const name = (match[1] ?? "").toLowerCase();
    const start = match.index + match[0].length;
    if (!closers.has(name)) closers.set(name, new RegExp(`</${name}\\s*>`, "giu"));
    const closer = closers.get(name);
    let close: RegExpExecArray | null = null;
    if (closer) {
      closer.lastIndex = start;
      close = closer.exec(html);
      if (!close) closers.set(name, undefined);
    }
    if (!close) {
      if (!dropUnclosed) continue;
      out += html.slice(from, match.index) + replace(name, html.slice(start));
      from = html.length;
      break;
    }
    out += html.slice(from, match.index) + replace(name, html.slice(start, close.index));
    from = close.index + close[0].length;
    opener.lastIndex = from;
  }
  return out + html.slice(from);
}

/** The inner markup of each `<name>…</name>`, in order and in one pass; an unclosed one is left out. */
export function elementsOf(markup: string, name: string): string[] {
  const found: string[] = [];
  replaceElements(markup, [name], (_name, inner) => {
    found.push(inner);
    return "";
  });
  return found;
}

/** The markup without comments; an unclosed one runs to the end. */
function withoutComments(html: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = html.indexOf("<!--", from);
    if (open === -1) break;
    const close = html.indexOf("-->", open + 4);
    out += `${html.slice(from, open)} `;
    from = close === -1 ? html.length : close + 3;
  }
  return out + html.slice(from);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  sect: "§",
  para: "¶",
  euro: "€",
  copy: "©",
  reg: "®",
  deg: "°",
  middot: "·",
  bull: "•",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  aacute: "á",
  ccedil: "ç",
  times: "×",
  frac12: "½"
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/giu,
    (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : whole;
      }
      return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
    }
  );
}

/** The value of one attribute of a tag's text, decoded. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

/** The part of the document between the first opening and the last closing tag of `name`. */
function element(html: string, name: string): string | undefined {
  const open = new RegExp(`<${name}\\b[^<>]*>`, "iu").exec(html);
  if (!open) return undefined;
  const close = html.toLowerCase().lastIndexOf(`</${name}`);
  if (close <= open.index) return undefined;
  return html.slice(open.index + open[0].length, close);
}

/** The element whose tag says `role="main"`, up to the end of the document's body. */
function roleMain(html: string): string | undefined {
  const open = /<([a-z][a-z0-9]*)\b[^<>]*\srole\s*=\s*["']?main\b[^<>]*>/iu.exec(html);
  if (!open?.[1]) return undefined;
  const close = html.toLowerCase().lastIndexOf(`</${open[1].toLowerCase()}`);
  return close > open.index ? html.slice(open.index + open[0].length, close) : undefined;
}

function oneLine(text: string): string {
  return decodeEntities(text.replace(TAG, " ")).replace(/\s+/gu, " ").trim();
}

/** HTML of the main part to Markdown: headings, paragraphs, list items and table rows. */
function markdownOf(html: string): string {
  const content = replaceElements(
    replaceElements(html, CHROME, () => " "),
    HEADINGS,
    (name, inner) => {
      const heading = oneLine(inner);
      return heading === "" ? "\n" : `\n\n${"#".repeat(Number(name.slice(1)))} ${heading}\n\n`;
    }
  );
  let text = content
    .replace(/<br\b[^<>]*>/giu, "\n")
    .replace(/<li\b[^<>]*>/giu, "\n- ")
    .replace(/<\/(td|th)\s*>/giu, " | ")
    .replace(
      /<\/(p|div|section|article|tr|li|table|ul|ol|dl|dd|dt|blockquote|pre|main|figure|caption)\s*>/giu,
      "\n"
    )
    .replace(/<(p|div|section|tr|table|dl|dd|dt|blockquote|pre)\b[^<>]*>/giu, "\n");
  text = decodeEntities(text.replace(TAG, ""));
  return text
    .split("\n")
    .map((line) => withoutTrailingCells(line.replace(/[ \t\f\v\u00a0]+/gu, " ")).trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** A line without the empty cells and spaces it ends in, in one pass from its end. */
function withoutTrailingCells(line: string): string {
  let end = line.length;
  while (end > 0 && /[\s|]/u.test(line.charAt(end - 1))) end--;
  return line.slice(0, end);
}

const MONTHS: Record<string, number> = {
  januar: 1,
  jänner: 1,
  january: 1,
  februar: 2,
  february: 2,
  märz: 3,
  maerz: 3,
  march: 3,
  april: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  dezember: 12,
  december: 12
};

function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31)
    return undefined;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCDate() === day ? at.toISOString() : undefined;
}

/** A date as pages write one: `01.11.2026`, `1. November 2026`, `2026-11-01` or `November 1, 2026`. */
const DATE =
  /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})|(\d{1,2})\.?\s{1,3}([A-Za-zÄÖÜäöü]{3,9})\s{1,3}(\d{4})|(\d{4})-(\d{2})-(\d{2})|([A-Za-z]{3,9})\s{1,3}(\d{1,2}),\s{1,3}(\d{4})/u;

function dateOf(match: RegExpMatchArray): string | undefined {
  const [, d1, m1, y1, d2, name2, y2, y3, m3, d3, name4, d4, y4] = match;
  const month = (name: string) => MONTHS[name.toLowerCase()] ?? 0;
  const date =
    d1 && m1 && y1
      ? isoDate(Number(y1), Number(m1), Number(d1))
      : d2 && name2 && y2
        ? isoDate(Number(y2), month(name2), Number(d2))
        : y3 && m3 && d3
          ? isoDate(Number(y3), Number(m3), Number(d3))
          : name4 && d4 && y4
            ? isoDate(Number(y4), month(name4), Number(d4))
            : undefined;
  return date;
}

/** The first date in `text`, which a tag's attribute bounds. */
function firstDate(text: string): string | undefined {
  for (const match of text.matchAll(new RegExp(DATE.source, "gu"))) {
    const date = dateOf(match);
    if (date) return date;
  }
  return undefined;
}

/**
 * A label a page puts directly before the date of its version, with what may stand between them:
 * "Stand: 01.11.2026", "Stand v. 01.11.2026", "Last updated on November 1, 2026". A label
 * followed by other words ("Stand der Technik … vom 12.05.2016") states no date.
 */
const DATE_LABEL =
  /\b(?:Stand|zuletzt geändert|zuletzt aktualisiert|letzte Änderung|Aktualisiert|Last updated|Last modified|Updated)\b[ \t]{0,3}[:–-]?[ \t]{0,3}(?:(?:vom|v\.|am|of|on)[ \t]{1,3})?/giu;
const DATE_AT = new RegExp(DATE.source, "uy");

/** The names of the meta tags that state a page's version date. */
const DATE_META = new Set([
  "last-modified",
  "dcterms.modified",
  "dc.date.modified",
  "article:modified_time",
  "og:updated_time",
  "date"
]);

/**
 * The date a page states of its own version: a meta tag, else a `<time>` marked as the date it
 * was changed, else a date directly after a label such as "Stand" in its text.
 */
function statedDateOf(html: string, markdown: string): string | undefined {
  for (const tag of html.matchAll(/<meta\b[^<>]*>/giu)) {
    const name = (attribute(tag[0], "name") ?? attribute(tag[0], "property") ?? "").toLowerCase();
    if (!DATE_META.has(name)) continue;
    const content = attribute(tag[0], "content");
    const date = content && firstDate(content);
    if (date) return date;
  }
  for (const tag of html.matchAll(/<time\b[^<>]*>/giu)) {
    if (attribute(tag[0], "itemprop")?.toLowerCase() !== "datemodified") continue;
    const value = attribute(tag[0], "datetime");
    const date = value && firstDate(value);
    if (date) return date;
  }
  let labels = 0;
  for (const label of markdown.matchAll(DATE_LABEL)) {
    if (++labels > DATE_LABELS_MAX) break;
    DATE_AT.lastIndex = label.index + label[0].length;
    const match = DATE_AT.exec(markdown);
    const date = match ? dateOf(match) : undefined;
    if (date) return date;
  }
  return undefined;
}

/** A link's address, absolute and without its fragment, or nothing for one the walk never follows. */
function absoluteLink(href: string, base: URL): string | undefined {
  if (/^\s*(?:javascript|mailto|tel|data|ftp):/iu.test(href)) return undefined;
  try {
    const url = new URL(href, base);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Reads one HTML page, as found at `base`. */
export function readHtmlPage(html: string, base: URL): WebPage {
  const visible = replaceElements(withoutComments(html), HIDDEN, () => " ", true);
  const baseTag = /<base\b[^<>]*>/iu.exec(visible);
  const baseHref = baseTag ? attribute(baseTag[0], "href") : undefined;
  const linkBase = baseHref ? (absoluteLink(baseHref, base) ?? base.href) : base.href;
  const links = new Set<string>();
  for (const tag of visible.matchAll(/<a\b[^<>]*>/giu)) {
    if (links.size >= LINKS_MAX) break;
    const href = attribute(tag[0], "href");
    const link = href === undefined ? undefined : absoluteLink(href, new URL(linkBase));
    if (link) links.add(link);
  }
  const titleMarkup = elementsOf(visible, "title")[0];
  const body = element(visible, "body") ?? visible;
  const main = element(body, "main") ?? roleMain(body) ?? element(body, "article") ?? body;
  const text = markdownOf(main);
  const h1 = /^# (.+)$/mu.exec(text)?.[1];
  const title = (titleMarkup ? oneLine(titleMarkup) : "") || h1 || undefined;
  const markdown = title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text;
  const statedDate = statedDateOf(visible, text);
  return {
    ...(title ? { title } : {}),
    markdown,
    links: [...links],
    ...(statedDate ? { statedDate } : {})
  };
}
