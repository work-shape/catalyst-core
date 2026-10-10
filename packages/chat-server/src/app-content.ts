import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { ClientInstanceId, FileSetId } from "@vivd-catalyst/core";
import { z } from "zod";

// Serving a Page: the files of one file set, to the frame that shows it and to nobody else.
//
// A Page is HTML and script an agent wrote, so it is held the way a generated view is held
// (`view-shell.ts`), for the same reason: a content policy cannot stop a document from moving
// its own frame to another host with data in the address, and the policy of the document that
// holds the frame can. So an HTML file of a file set is never answered as it is stored. It is
// answered as a shell document that holds the stored HTML in a `srcdoc` frame. The header of
// the shell carries `frame-src 'none'`, and a `srcdoc` frame takes over the policies of the
// document that holds it and resolves relative addresses against that document's address. The
// Page therefore runs under the header below, loads its files from below the address of the
// shell, and can navigate nowhere.
//
// The address holds a token. The token is a bearer capability: it is minted after the check
// that a viewer may read the Page, it is valid for `APP_CONTENT_TOKEN_TTL_SECONDS`, and until
// then it serves the built files of its one file set to whoever holds the address. It is not
// bound to the viewer's session, and signing out or losing access does not end it early.

/**
 * How long an address a frame was given stays valid, for anyone who holds it. A frame that
 * outlives it asks for a new one.
 */
export const APP_CONTENT_TOKEN_TTL_SECONDS = 3600;
/** The purpose of the key. Another value here is another key from the same secret. */
const APP_CONTENT_KEY_LABEL = "app-content/v1";
const APP_CONTENT_KEY_BYTES = 32;
/** Longer than any token this file mints. A longer one is refused before it is read. */
const APP_CONTENT_TOKEN_MAX_CHARS = 512;

/** The key that signs content tokens, derived from a secret the instance already holds. */
export function deriveAppContentKey(secret: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", secret, new Uint8Array(0), APP_CONTENT_KEY_LABEL, APP_CONTENT_KEY_BYTES)
  );
}

export interface AppContentClaims {
  fileSetId: FileSetId;
  /**
   * The user the address was minted for, after the check that this user may read the Page. A
   * record of who asked, not a condition: no request is compared with it.
   */
  viewerId: string;
  /** One mount of the frame. */
  pageSessionId: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export type AppContentTokenRefusal = "token_invalid" | "token_expired";

const payloadSchema = z
  .object({ u: z.string().min(1), s: z.string().min(1), e: z.number().int().positive() })
  .strict();

/**
 * The token is `<payload>.<mac>`, both base64url. The payload names viewer, page session and
 * expiry. The file set is not in it: the MAC covers the file set id of the address the token
 * stands in, so a token moved to another file set's address does not verify.
 */
export function mintAppContentToken(
  key: Uint8Array,
  clientInstanceId: ClientInstanceId,
  claims: AppContentClaims
): string {
  const payload = Buffer.from(
    JSON.stringify({ u: claims.viewerId, s: claims.pageSessionId, e: claims.expiresAt })
  ).toString("base64url");
  return `${payload}.${mac(key, clientInstanceId, claims.fileSetId, payload).toString("base64url")}`;
}

/** Checks a token for the file set of its address. Expiry is only told of a token that verifies. */
export function checkAppContentToken(
  key: Uint8Array,
  clientInstanceId: ClientInstanceId,
  input: { token: string; fileSetId: FileSetId; nowSeconds: number }
): { ok: true; claims: AppContentClaims } | { ok: false; refusal: AppContentTokenRefusal } {
  const invalid = { ok: false, refusal: "token_invalid" } as const;
  if (input.token.length > APP_CONTENT_TOKEN_MAX_CHARS) {
    return invalid;
  }
  const [payload, signature, ...rest] = input.token.split(".");
  if (!payload || !signature || rest.length > 0) {
    return invalid;
  }
  const expected = mac(key, clientInstanceId, input.fileSetId, payload);
  const given = Buffer.from(signature, "base64url");
  // Decoding drops characters outside the alphabet, so the text is compared as well: one
  // token has one spelling.
  if (
    given.byteLength !== expected.byteLength ||
    !timingSafeEqual(given, expected) ||
    given.toString("base64url") !== signature
  ) {
    return invalid;
  }
  const parsed = payloadSchema.safeParse(readJson(Buffer.from(payload, "base64url").toString()));
  if (!parsed.success) {
    return invalid;
  }
  if (input.nowSeconds >= parsed.data.e) {
    return { ok: false, refusal: "token_expired" };
  }
  return {
    ok: true,
    claims: {
      fileSetId: input.fileSetId,
      viewerId: parsed.data.u,
      pageSessionId: parsed.data.s,
      expiresAt: parsed.data.e
    }
  };
}

function mac(
  key: Uint8Array,
  clientInstanceId: ClientInstanceId,
  fileSetId: FileSetId,
  payload: string
): Buffer {
  // A JSON array: no value of one field can be read as part of another.
  return createHmac("sha256", key)
    .update(JSON.stringify([APP_CONTENT_KEY_LABEL, clientInstanceId, fileSetId, payload]))
    .digest();
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const APP_CONTENT_SEGMENT = "app-content";
const APP_CONTENT_PREFIX = `/${APP_CONTENT_SEGMENT}/`;

/**
 * Whether a request may hold a token in its address: the router matched the content route, or
 * the address reads as one below its prefix. The framework's own request lines are not written
 * for such a request. The router's match is what decides for a request that is served; the
 * reading of the address covers the requests no route takes.
 */
export function holdsAppContentToken(request: {
  url?: string;
  routeOptions?: { url?: string };
}): boolean {
  return request.routeOptions?.url === APP_CONTENT_ROUTE || isAppContentAddress(request.url);
}

/** The path a frame loads a file set from. It ends with a slash and answers the entry file. */
export function appContentPath(fileSetId: FileSetId, token: string): string {
  return `${APP_CONTENT_PREFIX}${fileSetId}/${token}/`;
}

/** The route every address below the prefix reaches, as the router names it. */
const APP_CONTENT_ROUTE = `${APP_CONTENT_PREFIX}*`;

/**
 * Whether a request address is below the prefix of the content route, and so may hold a token.
 * It is read the way a router reads it and more loosely: escaped characters are unescaped,
 * case and repeated slashes do not count. An address the router turns away is matched too,
 * a malformed one included, so that it is kept out of logs and error bodies all the same.
 */
export function isAppContentAddress(url: string | undefined): boolean {
  const first = /^\/+([^/?#]*)/u.exec(url ?? "")?.[1] ?? "";
  const unescaped = first.replaceAll(/%([0-9A-Fa-f]{2})/gu, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return unescaped.toLowerCase() === APP_CONTENT_SEGMENT;
}

/**
 * The policy of every answer of the content route. It is the policy of the shell document and,
 * by inheritance, of the Page inside it. There is no setting that removes a part of it.
 *
 * `frameAncestors` are the origins the interface runs on. The shell is framed by the interface
 * and by no other site.
 */
function appContentPolicy(frameAncestors: readonly string[], pageScriptHash?: string): string {
  return [
    // No origin: the Page cannot read the instance's cookies or storage. Scripts run. Forms,
    // popups, downloads, top navigation and same-origin are not allowed, each of them is a way
    // out of the frame.
    "sandbox allow-scripts",
    "default-src 'none'",
    // 'self' is the instance. It takes no path; see `view-shell.ts` for why none is named.
    // No inline script and no eval: the build moves inline scripts into files. The one hash is
    // that of the platform's own script of this answer, which holds the Page.
    pageScriptHash ? `script-src 'self' 'sha256-${pageScriptHash}'` : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // No host at all. A manifest's `externalHosts` are reviewed when an App is published; a
    // Page in a conversation is never published, so nothing has reviewed its list.
    "connect-src 'none'",
    // What holds the Page in its frame: it refuses every address the frame could move to.
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // A worker is a second place scripts run in, and the Page's own script does not need one.
    "worker-src 'none'",
    `frame-ancestors ${["'self'", ...frameAncestors.filter(isPolicySource)].join(" ")}`
  ].join("; ");
}

/**
 * Whether a policy can name an origin. The grammar of a source has no address in brackets, so
 * an interface that runs on an IPv6 literal cannot frame a Page; a browser would ignore the
 * source and say so on every answer.
 */
function isPolicySource(origin: string): boolean {
  return URL.canParse(origin) && !new URL(origin).hostname.startsWith("[");
}

/**
 * What every answer below the prefix of the content route carries, an error included.
 * `pageScriptHash` is given with a shell document and names the one inline script it may run.
 */
export function appContentHeaders(
  frameAncestors: readonly string[],
  pageScriptHash?: string
): Record<string, string> {
  return {
    "content-security-policy": appContentPolicy(frameAncestors, pageScriptHash),
    "x-content-type-options": "nosniff",
    // The address holds the token. No request the Page causes names it to anyone.
    "referrer-policy": "no-referrer",
    // Chromium's own lookups for links. The meta element of the Page document says it again.
    "x-dns-prefetch-control": "off",
    // The frame has no origin: a module script is fetched in CORS mode without credentials.
    "access-control-allow-origin": "*",
    "cross-origin-resource-policy": "cross-origin",
    // The answer depends on what the request is for, so a cache keeps one per destination.
    vary: "Origin, Sec-Fetch-Dest"
  };
}

/** A file of a file set never changes, so a browser keeps it for as long as its address is valid. */
export function appContentCacheControl(remainingSeconds: number): string {
  return `private, max-age=${Math.max(0, Math.floor(remainingSeconds))}, immutable`;
}

/**
 * Whether a request may be answered with a file. A browser says what a request is for. An HTML
 * file is a frame's and nothing else's: opened in a tab it would be a page an agent wrote under
 * the instance's own address. Every other file is refused to a navigation of any kind, because
 * an SVG file opened as a document is such a page too. A client that does not say what its
 * request is for gets an HTML file as the shell, which holds it wherever it is shown, and no
 * other file a browser would show as a document: such a file has no shell around it.
 */
export function appContentDestinationAllowed(
  fetchDestination: string | string[] | undefined,
  contentType: string
): boolean {
  const isHtml = isHtmlContentType(contentType);
  if (fetchDestination === undefined) {
    return isHtml || !rendersAsDocument(contentType);
  }
  if (typeof fetchDestination !== "string") {
    return false;
  }
  return isHtml ? fetchDestination === "iframe" : !NAVIGATION_DESTINATIONS.has(fetchDestination);
}

/** Whether a browser that is handed a file of this type as a page runs or lays out its markup. */
function rendersAsDocument(contentType: string): boolean {
  return /^(?:text\/html|image\/svg\+xml|(?:application|text)\/(?:[a-z0-9.+-]+\+)?xml)\s*(?:;|$)/iu.test(
    contentType
  );
}

const NAVIGATION_DESTINATIONS = new Set([
  "document",
  "iframe",
  "frame",
  "object",
  "embed",
  "fencedframe"
]);

export function isHtmlContentType(contentType: string): boolean {
  return /^(?:text\/html|application\/xhtml\+xml)\s*(?:;|$)/iu.test(contentType);
}

// The platform's own script of a Page frame. It is the only thing in the document the frame is
// given, and the stored HTML is a text in it: the script writes the HTML into the document as
// its last step. So there is no Page before the guard is in place. A script that does not run,
// because the policy does not name its hash or because it throws, leaves an empty document, and
// there is no second request that could fail between the guard and the Page.
//
// What the header cannot do is done here. A link in a Page leads nowhere, because the shell
// refuses the address. But a click with a modifier key or the middle button opens the address
// in a new tab outside the frame, a person can drag a link out or open it from the context
// menu, and a script can send packets over WebRTC. So in a Page:
//
// - a link, an image map area and an SVG link have no address. It is removed as soon as it is
//   in the document or in a shadow tree, and a Page moves between its views with a listener
//   and its router's memory history. Every address goes, `#fragment` too: in a `srcdoc` frame
//   the browser resolves it against the address of the shell.
// - a click on a link with a modifier key or another button than the first is cancelled, and so
//   is such a click into a closed shadow tree, where the script cannot see what was clicked.
// - there is no frame inside the Page. A frame a Page writes would be a document of its own
//   that this script does not run in.
// - the document cannot be opened again, which would drop the listeners of this script, and
//   the calls that parse declarative shadow trees are gone.
// - the WebRTC constructors are removed by name.
//
// It runs in the same realm as the Page's scripts, so it is hardening and not a boundary like
// the header: it takes what it needs from the built-in objects before a script of the Page can
// change them, and it closes the ways around it that are known. `e2e/view-exits.spec.ts` holds
// one test per way.
const PAGE_GUARD_SOURCE = `(function (page) {
  "use strict";
  try {
    guard();
  } catch (error) {
    // Without the guard there is no Page: what was parsed so far goes and nothing follows.
    window.stop();
    document.documentElement.remove();
    throw error;
  }
  function guard() {
  var apply = Reflect.apply;
  var write = Document.prototype.write;
  var describe = Object.getOwnPropertyDescriptor;
  var define = Object.defineProperty;
  function getter(prototype, name) {
    var get = describe(prototype, name).get;
    return function (self) {
      return apply(get, self, []);
    };
  }
  function method(prototype, name) {
    var call = prototype[name];
    return function (self, first, second, third) {
      return apply(call, self, [first, second, third]);
    };
  }
  var nodeType = getter(Node.prototype, "nodeType");
  var localName = getter(Element.prototype, "localName");
  var listLength = getter(NodeList.prototype, "length");
  var listItem = method(NodeList.prototype, "item");
  var attributesOf = getter(Element.prototype, "attributes");
  var attributeCount = getter(NamedNodeMap.prototype, "length");
  var attributeAt = method(NamedNodeMap.prototype, "item");
  var attributeName = getter(Attr.prototype, "localName");
  var removeAttributeNode = method(Element.prototype, "removeAttributeNode");
  var removeElement = method(Element.prototype, "remove");
  var queryElement = method(Element.prototype, "querySelectorAll");
  var queryFragment = method(DocumentFragment.prototype, "querySelectorAll");
  var queryDocument = method(Document.prototype, "querySelectorAll");
  var recordType = getter(MutationRecord.prototype, "type");
  var recordTarget = getter(MutationRecord.prototype, "target");
  var recordAdded = getter(MutationRecord.prototype, "addedNodes");
  var observe = method(MutationObserver.prototype, "observe");
  var preventDefault = method(Event.prototype, "preventDefault");
  var composedPath = method(Event.prototype, "composedPath");
  var button = getter(MouseEvent.prototype, "button");
  var modifiers = [
    getter(MouseEvent.prototype, "ctrlKey"),
    getter(MouseEvent.prototype, "metaKey"),
    getter(MouseEvent.prototype, "shiftKey"),
    getter(MouseEvent.prototype, "altKey")
  ];
  var attachShadow = method(Element.prototype, "attachShadow");
  var listen = method(EventTarget.prototype, "addEventListener");
  var closedHosts = new WeakSet();
  var isClosedHost = method(WeakSet.prototype, "has");
  var addClosedHost = method(WeakSet.prototype, "add");

  var webRtc = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"];
  for (var index = 0; index < webRtc.length; index += 1) {
    try {
      delete window[webRtc[index]];
    } catch (error) {}
  }

  function refuse(owner, name) {
    if (!(name in owner)) {
      return;
    }
    define(owner, name, {
      value: function () {
        throw new TypeError("A Page cannot call " + name + "().");
      },
      writable: false,
      configurable: false
    });
  }
  refuse(Document.prototype, "open");
  refuse(Document.prototype, "write");
  refuse(Document.prototype, "writeln");
  refuse(Document, "parseHTMLUnsafe");
  refuse(Document, "parseHTML");
  refuse(Element.prototype, "setHTMLUnsafe");
  refuse(Element.prototype, "setHTML");
  refuse(ShadowRoot.prototype, "setHTMLUnsafe");
  refuse(ShadowRoot.prototype, "setHTML");

  // By local name, so in every namespace: the address of a link in an SVG is one of XLink.
  function isAddress(attribute) {
    var name = attributeName(attribute);
    return name === "href" || name === "xlink:href" || name === "ping";
  }
  var FRAMES = "iframe,frame,frameset,object,embed,fencedframe,portal";
  function isElement(node) {
    return nodeType(node) === 1;
  }
  function isLink(node) {
    var name = localName(node);
    return name === "a" || name === "area";
  }
  function isFrame(node) {
    var name = localName(node);
    return (
      name === "iframe" ||
      name === "frame" ||
      name === "frameset" ||
      name === "object" ||
      name === "embed" ||
      name === "fencedframe" ||
      name === "portal"
    );
  }
  function hasAddress(link) {
    var attributes = attributesOf(link);
    for (var index = attributeCount(attributes) - 1; index >= 0; index -= 1) {
      if (isAddress(attributeAt(attributes, index))) {
        return true;
      }
    }
    return false;
  }
  function strip(link) {
    var attributes = attributesOf(link);
    for (var index = attributeCount(attributes) - 1; index >= 0; index -= 1) {
      var attribute = attributeAt(attributes, index);
      if (isAddress(attribute)) {
        removeAttributeNode(link, attribute);
      }
    }
  }
  function each(list, act) {
    for (var index = 0, length = listLength(list); index < length; index += 1) {
      act(listItem(list, index));
    }
  }
  function sweep(node) {
    var type = nodeType(node);
    if (type === 1) {
      if (isFrame(node)) {
        removeElement(node);
        return;
      }
      if (isLink(node)) {
        strip(node);
      }
    }
    var query = type === 1 ? queryElement : type === 9 ? queryDocument : type === 11 ? queryFragment : null;
    if (query) {
      each(query(node, FRAMES), removeElement);
      each(query(node, "a,area"), strip);
    }
  }
  var observer = new MutationObserver(function (records) {
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index];
      if (recordType(record) === "attributes") {
        var target = recordTarget(record);
        if (isLink(target) && hasAddress(target)) {
          strip(target);
        }
      } else {
        each(recordAdded(record), sweep);
      }
    }
  });
  // No attribute filter: a filter leaves out every attribute that has a namespace.
  var watched = { subtree: true, childList: true, attributes: true };
  function watch(root) {
    observe(observer, root, watched);
    sweep(root);
  }
  watch(document);

  // A shadow tree is not below the document, so each one is watched as it is made.
  define(Element.prototype, "attachShadow", {
    value: function (init) {
      var root = attachShadow(this, init);
      if (init && init.mode !== "open") {
        addClosedHost(closedHosts, this);
      }
      watch(root);
      return root;
    },
    writable: false,
    configurable: false
  });

  function cancel(event) {
    var modified = button(event) !== 0;
    for (var index = 0; index < modifiers.length; index += 1) {
      modified = modified || modifiers[index](event);
    }
    var path = composedPath(event);
    for (var step = 0; step < path.length; step += 1) {
      var node = path[step];
      if (node === window || !isElement(node)) {
        continue;
      }
      if (
        (isLink(node) && (modified || hasAddress(node))) ||
        (modified && isClosedHost(closedHosts, node))
      ) {
        preventDefault(event);
        return;
      }
    }
  }
  var events = ["click", "auxclick", "dragstart"];
  for (var kind = 0; kind < events.length; kind += 1) {
    listen(window, events[kind], cancel, true);
  }

  // The Page, now that everything above holds. The parser reads it from here on.
  apply(write, document, [page]);
  }
})`;

/**
 * The script of one Page document: the guard, called with the stored HTML as a text. No `<` of
 * the HTML is in the script as such, so nothing in it ends the script element early.
 */
function composePageScript(storedHtml: string): string {
  return `${PAGE_GUARD_SOURCE}(${JSON.stringify(storedHtml).replaceAll("<", "\\u003c")});`;
}

// The document the frame is given holds the platform's script and nothing else. The stored
// HTML is never searched for a place to put anything: a tag name in a comment or an attribute
// would be found too. What the script writes follows it in the head, and the parser merges a
// later `<html>`, `<head>` or `<body>` of the stored HTML.
function composePageDocument(pageScript: string): string {
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    `<script>${pageScript}</script>`
  ].join("");
}

const SHELL_STYLE =
  "html, body { height: 100%; margin: 0; overflow: hidden; } iframe { display: block; width: 100%; height: 100%; border: 0; }";

export interface PageShell {
  document: string;
  /** The SHA-256 of the one inline script of the Page document, as a policy names it. */
  pageScriptHash: string;
}

/**
 * The shell document for one HTML file of a file set. The Page's frame is written here, by the
 * server, with the sandbox it always has: scripts and nothing else. The Page document is the
 * value of an attribute, so only the two characters that end or change an attribute value are
 * escaped. The answer that carries the shell names `pageScriptHash` in its policy.
 */
export function composePageShell(storedHtml: string): PageShell {
  const pageScript = composePageScript(storedHtml);
  const pageDocument = composePageDocument(pageScript);
  const document = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Page</title>',
    `<style>${SHELL_STYLE}</style>`,
    "</head><body>",
    `<iframe sandbox="allow-scripts" title="Page" srcdoc="${escapeAttribute(pageDocument)}"></iframe>`,
    "</body></html>",
    ""
  ].join("\n");
  return { document, pageScriptHash: createHash("sha256").update(pageScript).digest("base64") };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
