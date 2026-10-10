import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

// What the tests of `view-exits.spec.ts` share: the other host that counts what reaches it,
// the browser's own lines about what it refused, and the ways a person clicks a link.

/** How long a refused move is given to reach the other host after all. */
export const SETTLE_MS = 1_000;
/** How long a view is given to send WebRTC packets. One that may send them does so at once. */
export const WEBRTC_WAIT_MS = 3_000;

export const refusedByShell =
  /^Framing '[^']*' violates the following Content Security Policy directive: "frame-src 'none'"\./u;

export interface OtherHost {
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

export const exitTest = test.extend<{ otherHost: OtherHost; refusals: string[] }>({
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

/** The browser said it refused, and after a while the other host has still seen nothing. */
export async function expectRefused(
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

export interface LinkClick {
  name: string;
  attributes?: string;
  options?: Parameters<Locator["click"]>[0];
}

export const linkClicks: LinkClick[] = [
  { name: "a click on a link" },
  { name: "a click on a download link", attributes: "download" },
  // The key that opens a link in a new tab: Meta on macOS, Control elsewhere.
  { name: "a Control or Meta click on a link", options: { modifiers: ["ControlOrMeta"] } },
  { name: "a Shift click on a link", options: { modifiers: ["Shift"] } },
  { name: "an Alt click on a link", options: { modifiers: ["Alt"] } },
  { name: "a middle click on a link", options: { button: "middle" } }
];
