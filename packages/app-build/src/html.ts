import { parse, type DefaultTreeAdapterMap, type Token } from "parse5";
import type { PageBuildError } from "./types";

// A Page is served under `script-src 'self'`: a script runs only when it is a file of the
// revision. So the build moves every inline script and inline style of an HTML file into a file
// beside it and rewrites the HTML to load that file. An inline event handler attribute cannot
// be moved, so it is refused with the element and the attribute named.
//
// The HTML is parsed to find the places and is then changed by cutting the author's text at
// those places. It is never written back from the parsed tree, so what the author wrote stays
// as written everywhere else.

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ElementLocation = Token.ElementLocation;

/** A script or style block that was inline and is a file now. */
export interface ExtractedInlineFile {
  /** Where the file lies in the Page, beside the HTML file it came from. */
  path: string;
  kind: "classic_script" | "module_script" | "style";
  text: string;
  /** The line of the HTML file the text starts on, counting from 1. */
  line: number;
}

/** A module script an HTML file loads from the Page's folder. The bundler builds it. */
interface HtmlModuleScript {
  /** The source file in the Page. */
  source: string;
}

export interface RewrittenHtml {
  html: string;
  extracted: ExtractedInlineFile[];
  moduleScripts: HtmlModuleScript[];
  /** Files of the Page the HTML loads as they are: classic scripts and style sheets. */
  staticReferences: string[];
  errors: PageBuildError[];
}

const SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);
const EVENT_HANDLER_ATTRIBUTE = /^on[a-z]+$/u;
const OTHER_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;
const SCRIPT_SOURCE_EXTENSION = /\.(?:tsx?|jsx?|mjs)$/iu;

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Moves the inline scripts and styles of one HTML file into files and reports what the content
 * policy would block. `exists` says whether a path is a file of the Page.
 */
export function rewriteHtml(input: {
  path: string;
  html: string;
  exists(path: string): boolean;
}): RewrittenHtml {
  const { path, html } = input;
  const document = parse(html, { sourceCodeLocationInfo: true });
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const base = path.slice(directory.length).replace(/\.html?$/iu, "");
  const edits: Edit[] = [];
  const extracted: ExtractedInlineFile[] = [];
  const moduleScripts: HtmlModuleScript[] = [];
  const staticReferences: string[] = [];
  const errors: PageBuildError[] = [];
  const taken = new Set<string>();
  let counter = 0;

  const reserve = (extension: string): string => {
    for (;;) {
      counter += 1;
      const candidate = `${directory}${base}.inline-${counter}.${extension}`;
      if (!input.exists(candidate) && !taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };
  const local = (reference: string): string | undefined =>
    resolveReference(directory, reference.replace(/[?#].*$/u, ""));
  const fail = (
    element: Element,
    error: Omit<PageBuildError, "file" | "line" | "column" | "element">
  ) => {
    const location = element.sourceCodeLocation;
    errors.push({
      file: path,
      ...(location ? { line: location.startLine, column: location.startCol } : {}),
      element: element.tagName,
      ...error
    });
  };

  const visitScript = (element: Element, location: ElementLocation) => {
    const type = (attribute(element, "type") ?? "").trim().toLowerCase();
    if (!SCRIPT_TYPES.has(type)) {
      // A data block: the browser does not run it.
      return;
    }
    const isModule = type === "module";
    const source = attribute(element, "src");
    if (source !== undefined) {
      const sourceLocation = location.attrs?.src;
      if (OTHER_ADDRESS.test(source) || source.startsWith("/")) {
        fail(element, {
          code: "external_resource",
          attribute: "src",
          message: `<script src="${source}"> is not a file of the Page. A Page runs scripts from its own folder only, named by a relative path.`
        });
        return;
      }
      const target = local(source);
      if (target === undefined || !input.exists(target)) {
        fail(element, {
          code: "external_resource",
          attribute: "src",
          message: `<script src="${source}"> names no file of the Page.`
        });
        return;
      }
      if (isModule && sourceLocation) {
        moduleScripts.push({ source: target });
        const built = relativeFrom(directory, target.replace(SCRIPT_SOURCE_EXTENSION, ".js"));
        edits.push({
          start: sourceLocation.startOffset,
          end: sourceLocation.endOffset,
          text: `src="${built}"`
        });
      } else {
        staticReferences.push(target);
      }
      return;
    }
    const text = element.childNodes.find((node) => node.nodeName === "#text");
    if (!text || !("value" in text) || text.value.trim() === "" || !location.startTag) {
      return;
    }
    const file = reserve("js");
    extracted.push({
      path: file,
      kind: isModule ? "module_script" : "classic_script",
      text: text.value,
      line: text.sourceCodeLocation?.startLine ?? location.startLine
    });
    const startTag = html.slice(location.startTag.startOffset, location.startTag.endOffset);
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `${startTag.slice(0, -1)} src="${relativeFrom(directory, file)}"></script>`
    });
  };

  const visitStyle = (element: Element, location: ElementLocation) => {
    const text = element.childNodes.find((node) => node.nodeName === "#text");
    if (!text || !("value" in text) || text.value.trim() === "") {
      return;
    }
    const file = reserve("css");
    extracted.push({
      path: file,
      kind: "style",
      text: text.value,
      line: text.sourceCodeLocation?.startLine ?? location.startLine
    });
    const media = attribute(element, "media");
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `<link rel="stylesheet" href="${relativeFrom(directory, file)}"${
        media === undefined ? "" : ` media="${escapeAttribute(media)}"`
      }>`
    });
  };

  const visitStyleSheetLink = (element: Element) => {
    const rel = (attribute(element, "rel") ?? "").toLowerCase().split(/\s+/u);
    const href = attribute(element, "href");
    if (!rel.includes("stylesheet") || href === undefined) {
      return;
    }
    if (OTHER_ADDRESS.test(href) || href.startsWith("/")) {
      fail(element, {
        code: "external_resource",
        attribute: "href",
        message: `<link href="${href}"> is not a file of the Page. A Page loads style sheets from its own folder only, named by a relative path.`
      });
      return;
    }
    const target = local(href);
    if (target !== undefined && input.exists(target)) {
      staticReferences.push(target);
    }
  };

  const visit = (node: Node) => {
    if ("tagName" in node) {
      for (const { name } of node.attrs) {
        if (EVENT_HANDLER_ATTRIBUTE.test(name)) {
          fail(node, {
            code: "inline_event_handler",
            attribute: name,
            message: `<${node.tagName} ${name}="..."> is an inline event handler, which a Page's content policy blocks. Remove the attribute and add the handler with addEventListener in a script.`
          });
        }
      }
      const location = node.sourceCodeLocation;
      if (location) {
        if (node.tagName === "script") visitScript(node, location);
        else if (node.tagName === "style") visitStyle(node, location);
        else if (node.tagName === "link") visitStyleSheetLink(node);
      }
    }
    if ("content" in node) visit(node.content);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);

  let rewritten = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return { html: rewritten, extracted, moduleScripts, staticReferences, errors };
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name === name)?.value;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

/** A relative reference from a folder of the Page, or nothing when it leaves the Page. */
export function resolveReference(directory: string, reference: string): string | undefined {
  const segments = directory.split("/").filter((segment) => segment !== "");
  for (const segment of reference.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

/** How a file in `directory` names another file of the Page. */
function relativeFrom(directory: string, target: string): string {
  const from = directory.split("/").filter((segment) => segment !== "");
  const to = target.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared += 1;
  }
  const up = from.slice(shared).map(() => "..");
  const path = [...up, ...to.slice(shared)].join("/");
  return up.length === 0 ? `./${path}` : path;
}
