import { harden } from "rehype-harden";
import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

/**
 * Where links in Markdown written by an agent may point. Images are never loaded from any
 * address, so this governs links only.
 */
export interface MarkdownLinkPolicy {
  /** The origins of the instance itself: the page and its API. */
  ownOrigins: readonly string[];
  /** `replies.allowedLinkHosts` of the instance config: host names, or `*.` and a domain. */
  allowedLinkHosts: readonly string[];
}

/** The texts shown in place of what is not loaded, in the reader's language. */
export interface MarkdownBlockedLabels {
  /** Shown for an image that has a description; `{description}` stands for it. */
  imageWithDescription: string;
  /** Shown for an image without a description. */
  image: string;
}

/** Stands in for the instance's origin where none is known, so relative links stay links. */
const FALLBACK_OWN_ORIGIN = "https://instance.invalid";

const BLOCKED_LINK_CLASS = "chat-markdown-blocked-link";
const BLOCKED_IMAGE_CLASS = "chat-markdown-blocked-image";

/**
 * The one set of rehype plugins every Markdown reply and Markdown file preview renders with.
 * Raw HTML is parsed and sanitized as Streamdown does by default. Then no image loads, neither
 * remote, nor relative, nor `data:`, and a link to a host outside the policy becomes text that
 * shows its address. `rehype-harden` runs last as a second line; it finds nothing left to block.
 */
export function markdownRehypePlugins(
  policy: MarkdownLinkPolicy,
  labels: MarkdownBlockedLabels
): RehypePlugins {
  const parsing = Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "harden")
    .map(([, plugin]) => plugin);
  return [
    ...parsing,
    [restrictRemoteContent, { policy, labels }],
    [
      harden,
      {
        allowedImagePrefixes: [],
        allowDataImages: false,
        allowedLinkPrefixes: ["*"],
        allowedProtocols: [],
        blockedImageClass: BLOCKED_IMAGE_CLASS,
        blockedLinkClass: BLOCKED_LINK_CLASS
      }
    ]
  ];
}

/** Whether a link may stay a link under the policy. */
function isAllowedMarkdownLink(href: string, policy: MarkdownLinkPolicy): boolean {
  if (href.startsWith("#")) {
    return true;
  }
  const base = policy.ownOrigins[0] ?? FALLBACK_OWN_ORIGIN;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return false;
  }
  if (url.protocol === "mailto:") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const ownOrigins = policy.ownOrigins.length > 0 ? policy.ownOrigins : [FALLBACK_OWN_ORIGIN];
  if (ownOrigins.some((origin) => originOf(origin) === url.origin)) {
    return true;
  }
  const host = url.hostname.toLowerCase();
  return policy.allowedLinkHosts.some((entry) => hostMatches(host, entry.toLowerCase()));
}

function hostMatches(host: string, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const domain = entry.slice(1);
    return host.endsWith(domain) && host.length > domain.length;
  }
  return host === entry;
}

function originOf(address: string): string | undefined {
  try {
    return new URL(address).origin;
  } catch {
    return undefined;
  }
}

/** The part of a hast node this plugin reads and writes. */
interface MarkdownNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownNode[];
}

interface RestrictOptions {
  policy: MarkdownLinkPolicy;
  labels: MarkdownBlockedLabels;
}

function restrictRemoteContent(options: RestrictOptions) {
  return (tree: MarkdownNode) => {
    restrictChildren(tree, options);
  };
}

function restrictChildren(parent: MarkdownNode, options: RestrictOptions): void {
  if (!parent.children) {
    return;
  }
  parent.children = parent.children.map((child) => {
    if (child.type !== "element") {
      return child;
    }
    // `srcset` of a `<source>` in a `<picture>` would load an image past the image rule.
    if (child.properties && "srcSet" in child.properties) {
      delete child.properties.srcSet;
    }
    if (child.tagName === "img") {
      return imageAsText(child, options.labels);
    }
    restrictChildren(child, options);
    if (child.tagName !== "a") {
      return child;
    }
    const href = child.properties?.href;
    if (typeof href === "string" && isAllowedMarkdownLink(href, options.policy)) {
      return child;
    }
    return linkAsText(child, typeof href === "string" ? href : "");
  });
}

/** An image is never loaded; its description is shown in its place. */
function imageAsText(image: MarkdownNode, labels: MarkdownBlockedLabels): MarkdownNode {
  const alt = image.properties?.alt;
  const description = typeof alt === "string" ? alt.trim() : "";
  return {
    type: "element",
    tagName: "span",
    properties: { className: [BLOCKED_IMAGE_CLASS] },
    children: [
      {
        type: "text",
        value: description
          ? labels.imageWithDescription.replace("{description}", description)
          : labels.image
      }
    ]
  };
}

/** The link's text, followed by its address unless the text already is the address. */
function linkAsText(link: MarkdownNode, href: string): MarkdownNode {
  const children = link.children ?? [];
  const showAddress = href.length > 0 && textOf(link).trim() !== href;
  return {
    type: "element",
    tagName: "span",
    properties: { className: [BLOCKED_LINK_CLASS], ...(href ? { title: href } : {}) },
    children: showAddress ? [...children, { type: "text", value: ` (${href})` }] : children
  };
}

function textOf(node: MarkdownNode): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(textOf).join("");
}
