// The body of a view that runs no script: a view that holds private rows. Such a view needs
// no script to send its rows away. The rows are written into its HTML on the server, so a
// link carries them in its address and a modified click opens it in a new tab, a resource
// hint names a host built from them, and row text that is markup becomes elements of its own.
//
// So the body is not the stored HTML. The stored HTML is read with the browser's parser, and
// a new one is written from its tree: the elements and attributes listed here and nothing
// else. Row text cannot get behind this. The rows are already in the stored HTML when it is
// parsed, so what they turned into is in the tree like everything else, and whatever is not
// on the list is not written. What is written is text and attribute values escaped here and
// names taken from the lists, so nothing in the output was markup in the input unless the
// list allows it. An element that is not listed is left out with everything inside it.

const TEXT_NODE = 3;

/** Allowed on every element. `style` is allowed with the check of `isInertCss`. */
const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "class",
  "dir",
  "hidden",
  "id",
  "lang",
  "role",
  "style",
  "title"
]);
const PREFIXED_ATTRIBUTE = /^(?:aria|data)-[a-z0-9-]+$/u;

const NO_ATTRIBUTES: readonly string[] = [];
const CELL_ATTRIBUTES = ["colspan", "rowspan", "headers"];

/**
 * The HTML elements a static view is written from, each with the attributes it may carry
 * besides the global ones. Text, headings, lists, tables, inline formatting, images and style
 * blocks. `a` is here for its text: it carries no address, because in a `srcdoc` frame even
 * `#fragment` is resolved against the address of the shell and replaces the view.
 */
const HTML_ELEMENTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ...[
    ...["address", "article", "aside", "blockquote", "div", "figcaption", "figure", "footer"],
    ...["header", "hr", "main", "nav", "p", "pre", "section", "summary", "br", "wbr"],
    ...["h1", "h2", "h3", "h4", "h5", "h6", "ul", "dl", "dt", "dd"],
    ...["table", "caption", "thead", "tbody", "tfoot", "tr"],
    ...["a", "abbr", "b", "bdi", "bdo", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd"],
    ...["mark", "q", "s", "samp", "small", "span", "strong", "sub", "sup", "u", "var", "style"]
  ].map((name): [string, readonly string[]] => [name, NO_ATTRIBUTES]),
  ["col", ["span"]],
  ["colgroup", ["span"]],
  ["details", ["open"]],
  ["img", ["alt", "height", "src", "width"]],
  ["li", ["value"]],
  ["meter", ["high", "low", "max", "min", "optimum", "value"]],
  ["ol", ["reversed", "start", "type"]],
  ["progress", ["max", "value"]],
  ["td", CELL_ATTRIBUTES],
  ["th", [...CELL_ATTRIBUTES, "abbr", "scope"]],
  ["time", ["datetime"]]
]);
const VOID_ELEMENTS: ReadonlySet<string> = new Set(["br", "col", "hr", "img", "wbr"]);

const SVG_PAINT_ATTRIBUTES = [
  ...["clip-path", "fill", "fill-opacity", "fill-rule", "opacity", "stroke", "stroke-dasharray"],
  ...["stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "stroke-width"],
  "transform"
];
const SVG_TEXT_ATTRIBUTES = [
  ...["dominant-baseline", "dx", "dy", "font-family", "font-size", "font-weight", "text-anchor"],
  ...["x", "y"]
];
const SVG_GRADIENT_ATTRIBUTES = ["gradientTransform", "gradientUnits", "spreadMethod"];

/**
 * Inline SVG drawn from shapes, text and gradients. No element or attribute here names an
 * address: no `href`, so no `a`, `image` or `use`, and no `style`, `script` or `foreignObject`.
 * Every value passes `isInertCss`, which lets `url(#id)` through for gradients and clip paths.
 */
const SVG_ELEMENTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["svg", ["height", "preserveAspectRatio", "viewBox", "width"]],
  ["g", NO_ATTRIBUTES],
  ["defs", NO_ATTRIBUTES],
  ["path", ["d"]],
  ["rect", ["height", "rx", "ry", "width", "x", "y"]],
  ["circle", ["cx", "cy", "r"]],
  ["ellipse", ["cx", "cy", "rx", "ry"]],
  ["line", ["x1", "x2", "y1", "y2"]],
  ["polyline", ["points"]],
  ["polygon", ["points"]],
  ["text", SVG_TEXT_ATTRIBUTES],
  ["tspan", SVG_TEXT_ATTRIBUTES],
  ["clipPath", ["clipPathUnits"]],
  ["linearGradient", [...SVG_GRADIENT_ATTRIBUTES, "x1", "x2", "y1", "y2"]],
  ["radialGradient", [...SVG_GRADIENT_ATTRIBUTES, "cx", "cy", "fx", "fy", "r"]],
  ["stop", ["offset", "stop-color", "stop-opacity"]]
]);

/**
 * Whether CSS, or an SVG attribute value, names nothing to load. The view's content policy
 * refuses such loads anyway; this keeps them out of the document. A backslash is refused
 * because CSS reads `u\72l(` as `url(`. `url(#id)` points into the document itself.
 */
function isInertCss(value: string): boolean {
  return (
    !value.includes("\\") &&
    !/@import|image-set\(|image\(|src\(/iu.test(value) &&
    !/url\((?!#)/iu.test(value)
  );
}

/**
 * Whether an image source is a raster image held in the address itself. An SVG image is
 * refused, as is every other `data:` type: shown as an image it loads nothing, but opened in a
 * tab of its own from the context menu it is a document, and its links work there, outside the
 * shell. `blob:` is refused as well, since a view that runs no script cannot make one.
 */
function isEmbeddedImage(address: string): boolean {
  return /^\s*data:image\/(?:png|jpeg|gif|webp)(?:;base64)?,/iu.test(address);
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

/**
 * The attributes an element may carry besides the global ones, or undefined for an element
 * that is not written. The lists are read by what the parser made of the element: an HTML
 * element, an SVG element, or neither, such as MathML.
 */
function allowedAttributes(element: Element): readonly string[] | undefined {
  if (element instanceof HTMLElement) {
    return HTML_ELEMENTS.get(element.localName);
  }
  if (element instanceof SVGElement) {
    const own = SVG_ELEMENTS.get(element.localName);
    return own ? [...own, ...SVG_PAINT_ATTRIBUTES] : undefined;
  }
  return undefined;
}

function isAllowedValue(element: Element, name: string, value: string): boolean {
  if (element instanceof SVGElement || name === "style") {
    return isInertCss(value);
  }
  return element.localName !== "img" || name !== "src" || isEmbeddedImage(value);
}

function writeAttributes(element: Element, allowed: readonly string[]): string {
  return Array.from(element.attributes)
    .filter(
      ({ name, value }) =>
        (GLOBAL_ATTRIBUTES.has(name) || allowed.includes(name) || PREFIXED_ATTRIBUTE.test(name)) &&
        isAllowedValue(element, name, value)
    )
    .map(({ name, value }) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function writeNode(node: Node): string {
  if (node.nodeType === TEXT_NODE) {
    return escapeText(node.nodeValue ?? "");
  }
  if (!(node instanceof Element)) {
    return "";
  }
  const allowed = allowedAttributes(node);
  if (!allowed) {
    return "";
  }
  const name = node.localName;
  const open = `<${name}${writeAttributes(node, allowed)}>`;
  if (node instanceof HTMLStyleElement) {
    // The one element whose text is written as it is: the parser reads it as CSS, not markup.
    const css = node.textContent;
    return isInertCss(css) && !css.includes("<") ? `${open}${css}</style>` : "";
  }
  if (node instanceof HTMLElement && VOID_ELEMENTS.has(name)) {
    return open;
  }
  return `${open}${writeNodes(node.childNodes)}</${name}>`;
}

function writeNodes(nodes: NodeListOf<ChildNode>): string {
  return Array.from(nodes).map(writeNode).join("");
}

/**
 * The body of a static view, written from the tree the browser's parser makes of `html`.
 * Style blocks of the stored head are kept in front of the stored body.
 */
export function writeStaticViewBody(html: string): string {
  const stored = new DOMParser().parseFromString(html, "text/html");
  return `${writeNodes(stored.head.childNodes)}${writeNodes(stored.body.childNodes)}`;
}
