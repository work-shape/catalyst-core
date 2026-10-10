import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  FILE_SET_RESERVED_SEGMENT,
  type ClientInstanceId,
  type FileSetId
} from "@vivd-catalyst/core";
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

/** How long an address a frame was given stays valid. A frame that outlives it asks for a new one. */
export const APP_CONTENT_TOKEN_TTL_SECONDS = 3600;
/** The purpose of the key. Another value here is another key from the same secret. */
const APP_CONTENT_KEY_LABEL = "app-content/v1";
const APP_CONTENT_KEY_BYTES = 32;
/** Longer than any token this file mints. A longer one is refused before it is read. */
const APP_CONTENT_TOKEN_MAX_CHARS = 512;

/** The version of the shell document and the guard script. A change to either is a new one. */
const PAGE_SHELL_VERSION = "1";
/** Where the platform's own script of a Page frame is, below the address of every file set. */
export const PAGE_GUARD_PATH = `${FILE_SET_RESERVED_SEGMENT}/guard-${PAGE_SHELL_VERSION}.js`;

/** The key that signs content tokens, derived from a secret the instance already holds. */
export function deriveAppContentKey(secret: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", secret, new Uint8Array(0), APP_CONTENT_KEY_LABEL, APP_CONTENT_KEY_BYTES)
  );
}

export interface AppContentClaims {
  fileSetId: FileSetId;
  /** The user the address was made for, after the check that this user may read the Page. */
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

const APP_CONTENT_PREFIX = "/app-content/";

/** The path a frame loads a file set from. It ends with a slash and answers the entry file. */
export function appContentPath(fileSetId: FileSetId, token: string): string {
  return `${APP_CONTENT_PREFIX}${fileSetId}/${token}/`;
}

/** Whether a request address is one of the content route, and so holds a token. */
export function isAppContentAddress(url: string | undefined): boolean {
  return url?.startsWith(APP_CONTENT_PREFIX) ?? false;
}

/**
 * The policy of every answer of the content route. It is the policy of the shell document and,
 * by inheritance, of the Page inside it. There is no setting that removes a part of it.
 *
 * `frameAncestors` are the origins the interface runs on. The shell is framed by the interface
 * and by no other site.
 */
function appContentPolicy(frameAncestors: readonly string[]): string {
  return [
    // No origin: the Page cannot read the instance's cookies or storage. Scripts run. Forms,
    // popups, downloads, top navigation and same-origin are not allowed, each of them is a way
    // out of the frame.
    "sandbox allow-scripts",
    "default-src 'none'",
    // 'self' is the instance. It takes no path; see `view-shell.ts` for why none is named.
    // No inline script and no eval: the build moves inline scripts into files.
    "script-src 'self'",
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
    `frame-ancestors ${["'self'", ...frameAncestors].join(" ")}`
  ].join("; ");
}

/** What every answer of the content route carries, an error included. */
export function appContentHeaders(frameAncestors: readonly string[]): Record<string, string> {
  return {
    "content-security-policy": appContentPolicy(frameAncestors),
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
 * request is for is answered, and gets nothing from it that a frame would not.
 */
export function appContentDestinationAllowed(
  fetchDestination: string | string[] | undefined,
  isDocument: boolean
): boolean {
  if (fetchDestination === undefined) {
    return true;
  }
  if (typeof fetchDestination !== "string") {
    return false;
  }
  return isDocument
    ? fetchDestination === "iframe"
    : !NAVIGATION_DESTINATIONS.has(fetchDestination);
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

// The platform's own script of a Page frame. It runs before the first byte of the Page.
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
const PAGE_GUARD_SCRIPT = `(function () {
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
  var removeAttribute = method(Element.prototype, "removeAttribute");
  var removeAttributeNS = method(Element.prototype, "removeAttributeNS");
  var hasAttribute = method(Element.prototype, "hasAttribute");
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

  var XLINK = "http://www.w3.org/1999/xlink";
  var addresses = ["href", "xlink:href", "ping"];
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
    return hasAttribute(link, "href") || hasAttribute(link, "xlink:href") || hasAttribute(link, "ping");
  }
  function strip(link) {
    for (var index = 0; index < addresses.length; index += 1) {
      removeAttribute(link, addresses[index]);
    }
    removeAttributeNS(link, XLINK, "href");
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
  var watched = { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "ping"] };
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
  }
})();
`;

export const PAGE_GUARD_FILE = {
  body: PAGE_GUARD_SCRIPT,
  contentType: "text/javascript; charset=utf-8"
} as const;

// The head of the Page document comes first, before any byte of the stored HTML, and the
// stored HTML is never searched for a place to put it: a tag name in a comment or an attribute
// would be found too. A later `<html>`, `<head>` or `<body>` of the stored HTML is merged by
// the parser. The guard is a classic script without `async`, so it has run before the parser
// reads the first byte of the Page.
const PAGE_DOCUMENT_HEAD = [
  "<!doctype html><html><head>",
  '<meta charset="utf-8">',
  '<meta http-equiv="x-dns-prefetch-control" content="off">',
  `<script src="${PAGE_GUARD_PATH}"></script>`,
  "</head>"
].join("");

const SHELL_STYLE =
  "html, body { height: 100%; margin: 0; overflow: hidden; } iframe { display: block; width: 100%; height: 100%; border: 0; }";

/**
 * The shell document for one HTML file of a file set. The Page's frame is written here, by the
 * server, with the sandbox it always has: scripts and nothing else. The stored HTML is the
 * value of an attribute, so only the two characters that end or change an attribute value are
 * escaped; the frame's parser reads the HTML exactly as it was stored.
 */
export function composePageShellDocument(storedHtml: string): string {
  const pageDocument = `${PAGE_DOCUMENT_HEAD}\n${storedHtml}`;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>Page</title>',
    `<style>${SHELL_STYLE}</style>`,
    "</head><body>",
    `<iframe sandbox="allow-scripts" title="Page" srcdoc="${escapeAttribute(pageDocument)}"></iframe>`,
    "</body></html>",
    ""
  ].join("\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
