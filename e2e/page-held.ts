import type { Page } from "@playwright/test";
import { SETTLE_MS, WEBRTC_WAIT_MS, type OtherHost } from "./exit-fixtures";
import { pageTestTitles } from "./page-exits";
import {
  expectOnInterface,
  expectPageRan,
  framePage,
  openPage,
  pageFrame,
  storePage,
  watchOpened
} from "./page-fixtures";
import { expect } from "./test";
import { apiOrigin, showView, signIn, uiOrigin, viewFrame, viewTitle } from "./view-fixtures";

// The Page tests of `view-exits.spec.ts` that are no entry of a list: what holds when the guard
// does not run, what a Page takes from a frame of its own, and what it can do to the page that
// holds it. The spec runs one test per entry.

interface HeldFixtures {
  page: Page;
  otherHost: OtherHost;
  refusals: string[];
}

export interface PageHeldTest {
  title: string;
  run(fixtures: HeldFixtures): Promise<void>;
}

const text = (value: string) => JSON.stringify(value);
const linkStyle = "display:block;width:240px;height:40px";

/** Opens a WebRTC connection with a constructor and writes on the body that it made an offer. */
const offerWith = (constructor: string, stunServer: string) =>
  `const peer = new (${constructor})({ iceServers: [{ urls: ${text(stunServer)} }] }); peer.createDataChannel("rows"); peer.createOffer().then((offer) => peer.setLocalDescription(offer)).then(() => document.body.setAttribute("data-offered", "true"), (error) => document.body.setAttribute("data-offered", "failed " + error.name));`;

function appContentRequests(page: Page, part: string): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/app-content/") && pathname.includes(part)) {
      asked.push(pathname.replace(/^\/app-content\/[^/]+\/[^/]+\//u, ""));
    }
  });
  return asked;
}

export const pageHeldTests: readonly PageHeldTest[] = [
  {
    title: pageTestTitles.failClosed,
    async run({ page, refusals }) {
      // The guard is the one script the policy of the answer names. Here the answer arrives
      // without that name, so the browser runs no script in the Page's frame.
      await page.route(
        (address) => address.pathname.startsWith("/app-content/"),
        async (route) => {
          const answer = await route.fetch();
          const headers = answer.headers();
          const policy = headers["content-security-policy"] ?? "";
          expect(policy).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/u);
          await route.fulfill({
            response: answer,
            headers: {
              ...headers,
              "content-security-policy": policy.replace(/ 'sha256-[A-Za-z0-9+/=]+'/u, "")
            }
          });
        },
        { times: 1 }
      );
      const asked = appContentRequests(page, "assets/");

      const view = await openPage(page, { html: '<p id="planted">planted</p>' });

      await expect
        .poll(() => refusals.filter((line) => line.startsWith("Executing inline script violates")))
        .toHaveLength(1);
      await page.waitForTimeout(SETTLE_MS);
      // The Page is written by the guard and by nothing else: its frame stays empty, and none
      // of its files was asked for.
      await expect(view.locator("head")).toHaveCount(1);
      await expect(view.locator("#page-title, #planted, link, body *")).toHaveCount(0);
      expect(asked).toEqual([]);
    }
  },
  {
    title: pageTestTitles.noGuardRequest,
    async run({ page, otherHost }) {
      const opened = watchOpened(page);
      const address = `${otherHost.origin}/hit?nested=1&rows=secret`;
      // Requests an author could answer are failed, and none is made.
      const reserved: string[] = [];
      await page.route(
        (url) => url.pathname.includes("__catalyst"),
        async (route) => {
          reserved.push(route.request().url());
          await route.abort();
        }
      );

      const view = await openPage(
        page,
        {
          files: {
            "sub/page.html": `<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="page-title">Nested</h1><a id="go" style="${linkStyle}" href="${address}">Open</a><script type="module" src="../assets/main.js"></script></body></html>`,
            // What a save refuses to store, written past it: a file where an address that
            // depends on the folder of the HTML file would look for the guard.
            "sub/__catalyst/guard-1.js": `document.documentElement.setAttribute("data-planted", "true");`,
            "__catalyst/guard-1.js": `document.documentElement.setAttribute("data-planted", "true");`
          }
        },
        "sub/page.html"
      );
      await expectPageRan(page);
      await expect(view.locator("#page-title")).toHaveText("Nested");
      await expect(view.locator("html")).not.toHaveAttribute("data-planted");
      await expect(view.locator("#go")).not.toHaveAttribute("href");
      await view.locator("#go").click({ modifiers: ["ControlOrMeta"] });

      await page.waitForTimeout(SETTLE_MS);
      expect(reserved).toEqual([]);
      expect(opened).toEqual([]);
      expect(otherHost.requests).toEqual([]);
      expect(otherHost.connections).toBe(0);
    }
  },
  {
    title: pageTestTitles.frameRead,
    async run({ page, otherHost }) {
      // A frame is in the document from the statement that adds it until the guard's observer
      // runs, which is after the script's task. In between the Page holds its window. Were
      // that window a realm the Page may read, every built-in method the guard removed or
      // refused would be back: the WebRTC constructors, and an `attachShadow` that makes a
      // tree the guard is not told of.
      const taken = [
        "realm.RTCPeerConnection",
        "realm.Document.prototype.write",
        "realm.Element.prototype.attachShadow",
        "window[0].RTCPeerConnection"
      ];
      const view = await openPage(page, {
        script: [
          `const frame = document.createElement("iframe"); document.body.appendChild(frame); const realm = frame.contentWindow;`,
          `const take = (get) => { try { return typeof get(); } catch (error) { return error.name; } };`,
          `document.body.setAttribute("data-realm", [${taken.map((name) => `take(() => ${name})`).join(", ")}, String(frame.contentDocument)].join(","));`,
          `try { ${offerWith("realm.RTCPeerConnection", otherHost.stunServer)} } catch (error) { document.body.setAttribute("data-offered", "threw " + error.name); }`
        ].join("\n")
      });
      await expectPageRan(page);
      // The frame of a Page has no origin, and a frame inside it gets another: the browser
      // refuses each read, in the task that added the frame as at any later time.
      await expect(view.locator("body")).toHaveAttribute(
        "data-realm",
        "SecurityError,SecurityError,SecurityError,SecurityError,null"
      );
      await expect(view.locator("body")).toHaveAttribute("data-offered", "threw SecurityError");
      await page.waitForTimeout(WEBRTC_WAIT_MS);

      await expect(view.locator("iframe")).toHaveCount(0);
      expect(otherHost.packets).toBe(0);
    }
  },
  {
    title: pageTestTitles.nameAndHistory,
    async run({ page }) {
      await page.goto(`${apiOrigin}/health`);
      const attempts = [
        `() => { parent.name = "planted"; }`,
        `() => { top.name = "planted"; }`,
        `() => parent.history.length`,
        `() => top.history.back()`
      ];
      const view = await openPage(page, {
        html: `<button id="back" type="button" style="${linkStyle}">Back</button>`,
        script: [
          `window.name = "planted";`,
          `const tried = []; for (const attempt of [${attempts.join(", ")}]) { try { attempt(); tried.push("done"); } catch (error) { tried.push(error.name); } }`,
          `document.body.setAttribute("data-tried", tried.join(","));`,
          `document.getElementById("back").addEventListener("click", () => { history.back(); history.go(-1); history.go(-2); document.body.setAttribute("data-went", "true"); });`
        ].join("\n")
      });
      await expectPageRan(page);
      // The page that holds a Page is another origin to it: its name and its history are not
      // the Page's to read or write.
      await expect(view.locator("body")).toHaveAttribute(
        "data-tried",
        "SecurityError,SecurityError,SecurityError,SecurityError"
      );
      await page.waitForTimeout(SETTLE_MS);
      const state = () => page.evaluate(() => ({ name: window.name, entries: history.length }));
      const before = { address: page.url(), ...(await state()) };
      expect(before.name).toBe("");
      expect(before.entries).toBeGreaterThan(1);

      // The Page's own history is the one thing it may call. It moves no page but its own.
      await view.locator("#back").click();
      await expect(view.locator("body")).toHaveAttribute("data-went", "true");
      await page.waitForTimeout(SETTLE_MS);

      expectOnInterface(page);
      expect({ address: page.url(), ...(await state()) }).toEqual(before);
      await expect(view.locator("#page-title")).toHaveText("Page");
      const shell = page
        .frames()
        .find((frame) => frame.url().startsWith(`${apiOrigin}/app-content/`));
      expect(await shell?.evaluate(() => window.name)).toBe("");
    }
  },
  {
    title: pageTestTitles.forgedMessage,
    async run({ page }) {
      // The interface listens for the messages of the shell of a view. A Page sends each of
      // them, to the page at the top and to its own shell.
      const types = ["view-shell-ready", "view-shell-document", "view-shell-loaded"]
        .map((name) => `vivd-catalyst:${name}`)
        .concat(["vivd-catalyst:display-height", "vivd-catalyst:display-blocked"]);
      const headers = await signIn(page, uiOrigin);
      const conversation = await showView(
        page.request,
        headers,
        `<h2>${viewTitle}</h2><p>rows</p>`
      );
      await page.goto(`${uiOrigin}/c/${encodeURIComponent(conversation.id)}`);
      const viewHolder = page.locator(`iframe[title="${viewTitle}"]`).first();
      await expect(viewFrame(page).getByRole("heading", { name: viewTitle })).toBeVisible();
      await expect(page.getByText("Loading view…")).toHaveCount(0);
      const height = () => viewHolder.evaluate((frame) => frame.getBoundingClientRect().height);
      const before = await height();

      // What arrives at the top page, as the interface's own listener meets it.
      const arrived = page.evaluate(
        (expected) =>
          new Promise<{ type: unknown; origin: string; fromOwnFrame: boolean }[]>((done) => {
            const seen: { type: unknown; origin: string; fromOwnFrame: boolean }[] = [];
            window.addEventListener("message", (event) => {
              const data: unknown = event.data;
              if (typeof data !== "object" || data === null || !("forged" in data)) {
                return;
              }
              let fromOwnFrame = false;
              for (let index = 0; index < window.length; index += 1) {
                fromOwnFrame = fromOwnFrame || window[index] === event.source;
              }
              seen.push({
                type: "type" in data ? data.type : undefined,
                origin: event.origin,
                fromOwnFrame
              });
              if (seen.length === expected) {
                done(seen);
              }
            });
          }),
        types.length
      );
      const stored = await storePage(page, headers, {
        script: `for (const type of ${JSON.stringify(types)}) { const message = { type, forged: true, height: 4321, document: "<p id='forged'>forged</p>", scripts: true, title: "forged" }; top.postMessage(message, "*"); parent.postMessage({ ...message, forged: undefined }, "*"); }`
      });
      await framePage(page, stored.url);
      await expectPageRan(page);

      // Each message arrived, from a window that is no frame of the top page: the interface
      // answers only the frame it made itself, so it does nothing with any of them.
      expect(await arrived).toEqual(
        types.map((type) => ({ type, origin: "null", fromOwnFrame: false }))
      );
      await page.waitForTimeout(SETTLE_MS);
      expect(await height()).toBe(before);
      await expect(page.getByText("Part of this view could not load.")).toHaveCount(0);
      await expect(page.getByText("Loading view…")).toHaveCount(0);
      await expect(viewFrame(page).getByRole("heading", { name: viewTitle })).toBeVisible();
      await expect(viewFrame(page).locator("#forged")).toHaveCount(0);
      // The shell of a Page holds no script, so the same messages meet no listener there.
      await expect(pageFrame(page).locator("#forged")).toHaveCount(0);
    }
  }
];
