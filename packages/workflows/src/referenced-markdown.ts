import type { Nodes, Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { escapeMarkdownText } from "./text-join";

// A Markdown field mapped as one plain reference, such as the body of a mail from an agent's
// answer or a child Workflow's text, keeps the value's Markdown: emphasis, lists, tables. Its
// links do not hide where they lead: each shows its label and then its address,
// `label (<https://…>)`, its host in ASCII, so a label a value wrote cannot pass for another
// address. A reference-style link is shown alike and its definition left out; an image is
// left out. Raw HTML stays as written, which a mail shows as text. Text the author typed, and
// a text joined from parts (`text-join.ts`), are not read here. Spec:
// events-workflows-and-guardrails.md, Values from earlier steps.

/** Showing a link's address can make brackets around it a link; so many passes at most. */
const MAX_PASSES = 8;

// CommonMark's absolute URI: a scheme of 2 to 32 characters and a colon.
const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]{1,31}:/iu;
// What an autolink may not hold, and what a table splits its cells at.
const NOT_IN_AUTOLINK = /[\u0000- <>|\u007f]/gu;
// What a link shown as its own address holds: printable ASCII alone, no look-alike letter.
const PRINTABLE_ASCII = /^[!-~]+$/u;

/** Whether a value can hold a link or an image at all; without one it is taken as it is. */
export function markdownMayLink(value: string): boolean {
  return value.includes("[") || value.includes("<");
}

/**
 * A referenced value for a Markdown field: its Markdown, each link followed by its address and
 * each image left out. Where that cannot be done in a few passes, the value is escaped whole.
 */
export function referencedMarkdown(value: string): string {
  let text = value;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = withAddresses(text);
    if (next === undefined) break;
    if (next === text) return text;
    text = next;
  }
  return escapeMarkdownText(value);
}

/** The Markdown as the mail renderer reads it: CommonMark with GFM tables. */
function parse(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()]
  });
}

function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node) return node.children.map((child: Nodes) => textOf(child)).join("");
  return "";
}

/** A link whose label is its own address in ASCII, such as `<https://office.example>`. */
function showsItsAddress(label: string, url: string): boolean {
  return PRINTABLE_ASCII.test(label) && (label === url || `mailto:${label}` === url);
}

/** A link's address as an autolink of the parsed URL; a relative one as escaped text. */
function address(url: string): string {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return escapeMarkdownText(url, "cell");
  }
  if (!ABSOLUTE_URI.test(href)) return escapeMarkdownText(url, "cell");
  const encoded = href.replace(
    NOT_IN_AUTOLINK,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
  return `<${encoded}>`;
}

/** One pass: the Markdown with each link and reference shown with its address. */
function withAddresses(markdown: string): string | undefined {
  const tree = parse(markdown);
  const definitions = new Map<string, string>();
  const collect = (node: Nodes) => {
    // CommonMark takes the first definition of a label: a later one changes no link.
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);

  const offsets = (node: Nodes): [number, number] => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw new MissingPosition();
    return [start, end];
  };
  /** The children of a node with the source between them, without what is before or after. */
  const inner = (children: readonly RootContent[]): string => {
    let text = "";
    let previous: number | undefined;
    for (const child of children) {
      const [start, end] = offsets(child);
      if (previous !== undefined) text += markdown.slice(previous, start);
      text += rebuilt(child);
      previous = end;
    }
    return text;
  };
  const shown = (children: readonly RootContent[], url: string): string => {
    const label = inner(children).trim();
    return label === "" ? address(url) : `${label} (${address(url)})`;
  };
  const rebuilt = (node: Nodes): string => {
    const [start, end] = offsets(node);
    switch (node.type) {
      case "definition":
      case "image":
      case "imageReference":
        return "";
      case "link":
        return showsItsAddress(textOf(node), node.url)
          ? markdown.slice(start, end)
          : shown(node.children, node.url);
      case "linkReference": {
        const url = definitions.get(node.identifier);
        return url === undefined ? inner(node.children) : shown(node.children, url);
      }
      default:
        break;
    }
    const children: readonly RootContent[] = "children" in node ? node.children : [];
    const first = children[0];
    const last = children.at(-1);
    if (!first || !last) return markdown.slice(start, end);
    return (
      markdown.slice(start, offsets(first)[0]) +
      inner(children) +
      markdown.slice(offsets(last)[1], end)
    );
  };

  try {
    const [start, end] = offsets(tree);
    return markdown.slice(0, start) + rebuilt(tree) + markdown.slice(end);
  } catch (error) {
    if (error instanceof MissingPosition) return undefined;
    throw error;
  }
}

class MissingPosition extends Error {}
