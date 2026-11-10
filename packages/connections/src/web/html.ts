// What a web source reads of an HTML page (KB-WEB): its main text as Markdown, its title, the
// links on it and the date it states. HTML is reduced before extraction, so navigation, scripts
// and forms never reach the index. Regular expressions, not a DOM: a page is untrusted input,
// read once and bounded by the caller's size cap, and nothing of it is ever executed.

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

const HIDDEN =
  /<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const COMMENT = /<!--[\s\S]*?-->/gu;
const CHROME =
  /<(nav|header|footer|aside|form|menu|dialog|button|select)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const TAG = /<[^>]*>/gu;

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
  const open = new RegExp(`<${name}\\b[^>]*>`, "iu").exec(html);
  if (!open) return undefined;
  const close = html.toLowerCase().lastIndexOf(`</${name}`);
  if (close <= open.index) return undefined;
  return html.slice(open.index + open[0].length, close);
}

/** The element whose tag says `role="main"`, up to the end of the document's body. */
function roleMain(html: string): string | undefined {
  const open = /<([a-z][a-z0-9]*)\b[^>]*\srole\s*=\s*["']?main\b[^>]*>/iu.exec(html);
  if (!open?.[1]) return undefined;
  const close = html.toLowerCase().lastIndexOf(`</${open[1].toLowerCase()}`);
  return close > open.index ? html.slice(open.index + open[0].length, close) : undefined;
}

function oneLine(text: string): string {
  return decodeEntities(text.replace(TAG, " ")).replace(/\s+/gu, " ").trim();
}

/** HTML of the main part to Markdown: headings, paragraphs, list items and table rows. */
function markdownOf(html: string): string {
  let text = html
    .replace(CHROME, " ")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu, (_whole, level: string, inner: string) => {
      const heading = oneLine(inner);
      return heading === "" ? "\n" : `\n\n${"#".repeat(Number(level))} ${heading}\n\n`;
    })
    .replace(/<br\b[^>]*>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(td|th)\s*>/giu, " | ")
    .replace(
      /<\/(p|div|section|article|tr|li|table|ul|ol|dl|dd|dt|blockquote|pre|main|figure|caption)\s*>/giu,
      "\n"
    )
    .replace(/<(p|div|section|tr|table|dl|dd|dt|blockquote|pre)\b[^>]*>/giu, "\n");
  text = decodeEntities(text.replace(TAG, ""));
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t\f\v\u00a0]+/gu, " ")
        .replace(/(?:\s*\|)+\s*$/u, "")
        .trim()
    )
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
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

/** The first date in `text`: `01.11.2026`, `1. November 2026`, `2026-11-01` or `November 1, 2026`. */
function firstDate(text: string): string | undefined {
  const pattern =
    /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})|(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,9})\s+(\d{4})|(\d{4})-(\d{2})-(\d{2})|([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})/gu;
  for (const match of text.matchAll(pattern)) {
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
    if (date) return date;
  }
  return undefined;
}

/** Words a page puts before the date of its version. */
const DATE_LINE =
  /\b(?:Stand|zuletzt geändert|zuletzt aktualisiert|letzte Änderung|Aktualisiert|Last updated|Last modified|Updated)\b/giu;

/** The date a page states of its own version: a meta tag, else a "Stand" line of its text. */
function statedDateOf(html: string, markdown: string): string | undefined {
  for (const tag of html.matchAll(/<meta\b[^>]*>/giu)) {
    const name = (attribute(tag[0], "name") ?? attribute(tag[0], "property") ?? "").toLowerCase();
    if (
      ![
        "last-modified",
        "dcterms.modified",
        "dc.date.modified",
        "article:modified_time",
        "og:updated_time",
        "date"
      ].includes(name)
    )
      continue;
    const content = attribute(tag[0], "content");
    const date = content && firstDate(content);
    if (date) return date;
  }
  for (const match of markdown.matchAll(DATE_LINE)) {
    const date = firstDate(
      markdown.slice(match.index + match[0].length, match.index + match[0].length + 160)
    );
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
  const visible = html.replace(COMMENT, " ").replace(HIDDEN, " ");
  const baseTag = /<base\b[^>]*>/iu.exec(visible);
  const baseHref = baseTag ? attribute(baseTag[0], "href") : undefined;
  const linkBase = baseHref ? (absoluteLink(baseHref, base) ?? base.href) : base.href;
  const links = new Set<string>();
  for (const tag of visible.matchAll(/<a\b[^>]*>/giu)) {
    if (links.size >= LINKS_MAX) break;
    const href = attribute(tag[0], "href");
    const link = href === undefined ? undefined : absoluteLink(href, new URL(linkBase));
    if (link) links.add(link);
  }
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(visible);
  const body = element(visible, "body") ?? visible;
  const main = element(body, "main") ?? roleMain(body) ?? element(body, "article") ?? body;
  const text = markdownOf(main);
  const h1 = /^# (.+)$/mu.exec(text)?.[1];
  const title = (titleMatch?.[1] ? oneLine(titleMatch[1]) : "") || h1 || undefined;
  const markdown = title && !text.startsWith(`# ${title}`) ? `# ${title}\n\n${text}` : text;
  const statedDate = statedDateOf(visible, text);
  return {
    ...(title ? { title } : {}),
    markdown,
    links: [...links],
    ...(statedDate ? { statedDate } : {})
  };
}
