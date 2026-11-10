import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

// Mail text as the agent reads it: decoded, without control characters, and HTML reduced to
// text by a parser that loads nothing. Everything here is untrusted text and stays data.

/** Control and format characters except tab and line feed, and the line and paragraph separators. */
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const KEPT_IN_TEXT = new Set(["\n", "\t"]);

/** One line: no control or format character, runs of space as one, at most `max` characters. */
export function plainLine(value: string, max: number): string {
  return cut(value.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim(), max);
}

/** Body text: line feeds and tabs stay, every other control or format character goes. */
export function plainText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(CONTROLS, (char) => (KEPT_IN_TEXT.has(char) ? char : ""))
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** At most `max` characters, never splitting a surrogate pair. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
}

const HIDDEN_TAGS = new Set(["script", "style", "template", "head", "title", "noscript"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "li",
  "tr",
  "hr",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "ul",
  "ol"
]);

/** The text of an HTML part. The parser builds a tree only: no image, link or style is loaded. */
function htmlToText(html: string): string {
  const visit = (node: DefaultTreeAdapterMap["node"]): string => {
    if (node.nodeName === "#text" && "value" in node) return node.value;
    if ("tagName" in node && HIDDEN_TAGS.has(node.tagName)) return "";
    if ("tagName" in node && node.tagName === "br") return "\n";
    const inner = "childNodes" in node ? node.childNodes.map(visit).join("") : "";
    return "tagName" in node && BLOCK_TAGS.has(node.tagName) ? `\n${inner}\n` : inner;
  };
  return visit(parseFragment(html))
    .replace(/[\t\r ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Base64 of a part that may have been cut: whole groups of four only. */
function base64Bytes(raw: Buffer): Buffer {
  const compact = raw.toString("latin1").replace(/[^A-Za-z0-9+/]/gu, "");
  return Buffer.from(compact.slice(0, compact.length - (compact.length % 4)), "base64");
}

/** Quoted-printable (RFC 2045 6.7). A sequence cut at the end is dropped. */
function quotedPrintableBytes(raw: Buffer): Buffer {
  const source = raw.toString("latin1").replace(/=\r?\n/gu, "");
  const bytes: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const char = source.charCodeAt(index);
    if (source[index] === "=") {
      const hex = source.slice(index + 1, index + 3);
      if (/^[0-9A-Fa-f]{2}$/u.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
      if (index + 3 > source.length) break;
    }
    bytes.push(char & 0xff);
  }
  return Buffer.from(bytes);
}

/** Text in a charset the runtime knows; UTF-8 where the label is unknown or absent. */
function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label === "us-ascii" ? "utf-8" : label, { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  return decoder.decode(bytes);
}

/** The text of one part from its raw section: transfer encoding first, then the charset. */
export function decodePart(
  raw: Buffer,
  part: { encoding?: string; charset?: string; type: string }
): string {
  const encoding = (part.encoding ?? "7bit").toLowerCase();
  const bytes =
    encoding === "base64"
      ? base64Bytes(raw)
      : encoding === "quoted-printable"
        ? quotedPrintableBytes(raw)
        : raw;
  const decoded = decodeCharset(bytes, part.charset);
  return part.type === "text/html" ? htmlToText(decoded) : decoded;
}
