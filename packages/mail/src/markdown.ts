import type { AlignType, Nodes, PhrasingContent, Root, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

// The Markdown of a mail's body, rendered on the server into the HTML part and the plain-text
// part. Nothing the author or a referenced value wrote reaches the HTML as markup: every text
// is escaped, raw HTML is shown as text, an image is dropped (a remote image is a tracking
// pixel) and a link keeps its target only over `https`, `http` or `mailto`. The HTML loads
// nothing from any host. Tables (GFM), lists, headings, emphasis, code and links survive.

/** How the rendered body is styled: the instance's accent colour for its links. */
export interface MailMarkdownStyle {
  accentColor: string;
}

export interface RenderedMarkdown {
  html: string;
  text: string;
}

const ALLOWED_LINK_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

const FONT = "font-family:Helvetica,Arial,sans-serif;";
const HEADING_SIZES = ["22px", "19px", "17px", "16px", "15px", "15px"] as const;

/** Parses the body as CommonMark with GFM tables. Raw HTML stays a node of its own. */
function parseMailMarkdown(markdown: string): Root {
  return fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()]
  });
}

export function renderMailMarkdown(markdown: string, style: MailMarkdownStyle): RenderedMarkdown {
  const tree = parseMailMarkdown(markdown);
  return {
    html: blocksHtml(tree.children, style),
    text: blocksText(tree.children).trim()
  };
}

/** The target of a link where its scheme is one a mail may link to, else nothing. */
export function allowedLinkTarget(url: string): string | undefined {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // A relative link points at no host the reader knows: it is shown as text.
    return undefined;
  }
  return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function blocksHtml(nodes: readonly RootContent[], style: MailMarkdownStyle): string {
  return nodes.map((node) => blockHtml(node, style)).join("\n");
}

function blockHtml(node: RootContent, style: MailMarkdownStyle): string {
  switch (node.type) {
    case "paragraph": {
      const inner = inlineHtml(node.children, style);
      // A paragraph that held only an image is left out with it.
      return inner.trim() === "" ? "" : `<p style="margin:0 0 12px;">${inner}</p>`;
    }
    case "heading": {
      const size = HEADING_SIZES[node.depth - 1] ?? "15px";
      return `<h${node.depth} style="${FONT}font-size:${size};line-height:1.3;margin:20px 0 8px;">${inlineHtml(node.children, style)}</h${node.depth}>`;
    }
    case "thematicBreak":
      return '<hr style="border:0;border-top:1px solid #e2e2e2;margin:16px 0;">';
    case "blockquote":
      return `<blockquote style="margin:0 0 12px;padding:0 0 0 12px;border-left:3px solid #d0d0d0;color:#555555;">${blocksHtml(node.children, style)}</blockquote>`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start =
        node.ordered && typeof node.start === "number" && node.start !== 1
          ? ` start="${String(Math.trunc(node.start))}"`
          : "";
      const items = node.children
        .map((item) => `<li style="margin:0 0 4px;">${listItemHtml(item.children, style)}</li>`)
        .join("");
      return `<${tag}${start} style="margin:0 0 12px;padding:0 0 0 24px;">${items}</${tag}>`;
    }
    case "code":
      return `<pre style="margin:0 0 12px;padding:10px 12px;background:#f4f4f2;border-radius:4px;white-space:pre-wrap;font-family:Menlo,Consolas,monospace;font-size:13px;"><code>${escapeHtml(node.value)}</code></pre>`;
    case "table":
      return tableHtml(node, style);
    case "html":
      // Raw HTML is the author's text, shown as it was written.
      return `<p style="margin:0 0 12px;">${escapeHtml(node.value)}</p>`;
    case "definition":
      return "";
    default:
      // Anything else the parser yields is shown as its text.
      return escapeHtml(textOf(node));
  }
}

/** A tight list item's paragraph is shown without the paragraph's margins. */
function listItemHtml(children: readonly RootContent[], style: MailMarkdownStyle): string {
  const [only] = children;
  if (children.length === 1 && only?.type === "paragraph") return inlineHtml(only.children, style);
  return blocksHtml(children, style);
}

function tableHtml(table: Table, style: MailMarkdownStyle): string {
  const align = (index: number): string => {
    const value: AlignType | undefined = table.align?.[index];
    return value ? `text-align:${value};` : "text-align:left;";
  };
  const rows = table.children.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? "th" : "td";
    const cells = row.children.map(
      (cell, cellIndex) =>
        `<${tag} style="${align(cellIndex)}padding:6px 10px;border:1px solid #e2e2e2;${rowIndex === 0 ? "background:#f4f4f2;font-weight:bold;" : ""}">${inlineHtml(cell.children, style)}</${tag}>`
    );
    return `<tr>${cells.join("")}</tr>`;
  });
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px;${FONT}font-size:14px;">${rows.join("")}</table>`;
}

function inlineHtml(nodes: readonly PhrasingContent[], style: MailMarkdownStyle): string {
  return nodes.map((node) => phraseHtml(node, style)).join("");
}

function phraseHtml(node: PhrasingContent, style: MailMarkdownStyle): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value);
    case "emphasis":
      return `<em>${inlineHtml(node.children, style)}</em>`;
    case "strong":
      return `<strong>${inlineHtml(node.children, style)}</strong>`;
    case "delete":
      return `<del>${inlineHtml(node.children, style)}</del>`;
    case "inlineCode":
      return `<code style="font-family:Menlo,Consolas,monospace;font-size:13px;background:#f4f4f2;padding:1px 4px;border-radius:3px;">${escapeHtml(node.value)}</code>`;
    case "break":
      return "<br>";
    case "link": {
      const label = inlineHtml(node.children, style);
      const target = allowedLinkTarget(node.url);
      if (target === undefined) return label;
      return `<a href="${escapeHtml(target)}" style="color:${style.accentColor};text-decoration:underline;">${label === "" ? escapeHtml(target) : label}</a>`;
    }
    case "linkReference":
      // A reference's target is a definition elsewhere in the body; it is shown as its text.
      return inlineHtml(node.children, style);
    case "image":
    case "imageReference":
      return "";
    case "html":
      return escapeHtml(node.value);
    default:
      // Anything else the parser yields is shown as its text.
      return escapeHtml(textOf(node));
  }
}

function blocksText(nodes: readonly RootContent[]): string {
  return nodes
    .map(blockText)
    .filter((part) => part !== "")
    .join("\n\n");
}

function blockText(node: RootContent): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return inlineText(node.children).trim();
    case "thematicBreak":
      return "----";
    case "blockquote":
      return blocksText(node.children)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "list":
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${String((node.start ?? 1) + index)}.` : "-";
          const body = blocksText(item.children).split("\n");
          return [`${marker} ${body[0] ?? ""}`, ...body.slice(1).map((line) => `  ${line}`)].join(
            "\n"
          );
        })
        .join("\n");
    case "code":
      return node.value;
    case "table":
      return node.children
        .map((row) => row.children.map((cell) => inlineText(cell.children).trim()).join(" | "))
        .join("\n");
    case "html":
      return node.value;
    case "definition":
      return "";
    default:
      return textOf(node);
  }
}

function inlineText(nodes: readonly PhrasingContent[]): string {
  return nodes.map(phraseText).join("");
}

function phraseText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "html":
      return node.value;
    case "break":
      return "\n";
    case "link": {
      const label = inlineText(node.children);
      const target = allowedLinkTarget(node.url);
      return target === undefined || label === target ? label : `${label} (${target})`;
    }
    case "image":
    case "imageReference":
      return "";
    default:
      return textOf(node);
  }
}

function textOf(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children))
    return node.children.map((child) => textOf(child)).join("");
  return "";
}
