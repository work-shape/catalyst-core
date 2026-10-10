import { expect, test as base, type BrowserContext } from "@playwright/test";
import {
  REPLACED_BUILT_INS_LINK,
  pageExitTitle,
  pageLinkTitle,
  pageLoadExits,
  pageNavigationExits,
  pageTestTitles,
  tabOpeningClicks
} from "./page-exits";

/**
 * A message a page may report as an error without failing its test. Every entry names one
 * known message and says why it is let through; a new error is fixed, or filed and added here
 * with its reason, never matched by a wider pattern.
 */
interface AllowedPageError {
  name: string;
  reason: string;
  matches: RegExp;
  /** For the browser's line about a request: the path of the address that was asked for. */
  path?: RegExp;
  /** The tests that cause the message on purpose, by title. Without it, any test may meet it. */
  tests?: readonly string[];
}

const REQUEST_FAILED = /^Failed to load resource: net::ERR_(?:CONNECTION_)?FAILED$/u;
const requestAnswered = (status: number) =>
  new RegExp(`^Failed to load resource: the server responded with a status of ${status} `, "u");

/** Appended to the report of a resize observer loop while a turn is anchored to the top. */
const BESIDE_TOP_ANCHORED_TURN = " (beside a turn anchored to the top)";

const allowedPageErrors: readonly AllowedPageError[] = [
  {
    name: "signed-out-session",
    reason:
      "Chromium's own log line, written by no script: every page asks who is signed in, and " +
      "before the sign-in the instance answers 401.",
    matches: requestAnswered(401),
    path: /^\/api\/v1\/me$/u
  },
  {
    name: "planted-request-failure",
    reason:
      "Chromium's own log line for a request the test aborts on purpose. What the page makes " +
      "of the failure is what these tests assert.",
    matches: REQUEST_FAILED,
    path: /^\/api\/v1\/(?:instance\/config|conversations|conversations\/runs)$/u,
    tests: [
      "a configuration the interface cannot read shows an error that a retry recovers from",
      "the rail shows placeholder rows while its list loads and offers a retry when the load failed",
      "a first message that fails leaves the start page with the agent and its name"
    ]
  },
  {
    name: "workspace-that-is-gone",
    reason:
      "Chromium's own log line: these tests open a workspace that does not exist or was just " +
      "deleted, the instance answers 404 and the page falls back, which they assert.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/(?:conversations|workspaces\/cw_not_a_workspace\/agents)$/u,
    tests: [
      "collaboration workspaces scope navigation, settings, and discovery",
      "collaboration workspace settings delete a workspace and fall back to personal"
    ]
  },
  {
    name: "refused-config-asset",
    reason:
      "Chromium's own log line: the test saves an asset that does not validate and one that " +
      "changed meanwhile, and asserts what the page shows for the 422 and the 409.",
    matches: new RegExp(`${requestAnswered(422).source}|${requestAnswered(409).source}`, "u"),
    path: /^\/api\/v1\/assets\//u,
    tests: ["superadmin manages config assets with validation and conflict protection"]
  },
  {
    name: "grant-already-there",
    reason:
      "Chromium's own log line: the test asks for three grants of which two exist, the " +
      "instance answers 409 for each of the two, and the page says that it left them alone, " +
      "which the test asserts.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/instance\/access\/grants$/u,
    tests: [
      "an administrator registers a Namespace, grants in it, checks, denies, revokes and deletes"
    ]
  },
  {
    name: "planted-policy-refusal",
    reason:
      "Chromium's own log line for a load the policy of a generated view refused. These tests " +
      "plant the loads and assert that none of them left the browser.",
    matches:
      /^(?:Loading the script|Connecting to) '\S+' violates the following Content Security Policy directive: |^Fetch API cannot load \S+ Refused to connect because it violates the document's Content Security Policy\.$/u,
    tests: [
      "and no script of the API's origin outside the runtime directory",
      "and nothing of another host for a script placed before the document",
      "and no script of another host that borrows the hash of an inline script (html.rendered)",
      "and no script of another host that borrows the hash of an inline script (private_hydrated_view)"
    ]
  },
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
    name: "planted-page-exit",
    reason:
      "Chromium's own log line for what it refused a Page: a move of its frame or of a frame " +
      "that holds it, a window, a form, or a load its policy names no host for. These tests " +
      "plant each of them in a Page and assert that nothing reached the other host.",
    matches: new RegExp(
      [
        /^Framing '[^']*' violates the following Content Security Policy directive: "frame-(?:src 'none'|ancestors 'self' [^"]*)"\. The request has been blocked\.\s*$/u,
        /^(?:Connecting to|Fetching content from|Creating a worker from|Loading the (?:image|script|stylesheet|font)|Loading media from |Setting the document's base URI to) '[^']*' violates the following Content Security Policy directive: "[^"]*"\. (?:Note that '[a-z-]+' was not explicitly set, so '[a-z-]+' is used as a fallback\. )?The action has been blocked\.\s*$/u,
        /^Fetch API cannot load \S+ Refused to connect because it violates the document's Content Security Policy\.$/u,
        /^(?:Executing inline script|Applying inline speculation rules) violates the following Content Security Policy directive 'script-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')?'\. Either the 'unsafe-inline' keyword, a hash \('sha256-[A-Za-z0-9+/=]+'\), or a nonce \('nonce-\.\.\.'\) is required to enable inline execution\. The action has been blocked\.\s*$/u,
        /^Blocked form submission to '[^']*' because the form's frame is sandboxed and the 'allow-forms' permission is not set\.\s*$/u,
        /^Blocked opening '[^']*' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set\.\s*$/u,
        /^Unsafe attempt to initiate navigation for frame with (?:URL|origin) '[^']*' from frame with URL 'about:srcdoc'\. The frame attempting navigation (?:is sandboxed, and is therefore disallowed from navigating its ancestors|of the top-level window is sandboxed, but the flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is not set)\.\s*$/u,
        /^Unsafe attempt to load URL \S+ from frame with URL about:srcdoc\. Domains, protocols and ports must match\.\s*$/u
      ]
        .map((line) => line.source)
        .join("|"),
      "u"
    ),
    tests: [
      ...[...pageNavigationExits, ...pageLoadExits].map(pageExitTitle),
      pageTestTitles.instanceAddress,
      pageTestTitles.otherSite,
      pageTestTitles.noOrigin,
      pageTestTitles.failClosed
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
        pageLoadExits.find((exit) => exit.name === "a base address") ?? { name: "a base address" }
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
    tests: tabOpeningClicks.map((click) => pageLinkTitle({ name: REPLACED_BUILT_INS_LINK }, click))
  },
  {
    name: "page-address-in-a-tab",
    reason:
      "Chromium's own log line: the test opens the address of a Page in a tab of its own, " +
      "the instance answers 403 because only a frame is given a Page, which the test asserts.",
    matches: requestAnswered(403),
    path: /^\/app-content\//u,
    tests: [pageTestTitles.ownTab]
  },
  {
    name: "script-in-scriptless-view",
    reason:
      "Chromium's own log line for a script in a frame that runs none. A view that holds " +
      "private rows is such a frame, and the test runner reads and clicks in it with a script " +
      "of its own.",
    matches:
      /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set\.$/u,
    tests: [
      "and no script of another host that borrows the hash of an inline script (private_hydrated_view)",
      "it keeps an image only when it is a raster image held in its address",
      "it writes nothing that reads differently the second time",
      "a view with private rows reaches no other host through a click on a link",
      "a view with private rows reaches no other host through a click on a download link",
      "a view with private rows reaches no other host through a Control or Meta click on a link",
      "a view with private rows reaches no other host through a Shift click on a link",
      "a view with private rows reaches no other host through an Alt click on a link",
      "a view with private rows reaches no other host through a middle click on a link",
      "it keeps nothing that names a host",
      "it shows row text that is markup as it stands on the allowlist, or not at all",
      "a view with private rows sends no WebRTC packet"
    ]
  },
  {
    name: "request-that-is-gone",
    reason:
      "Chromium's own log line: the test opens the address of an Inbox item that does not " +
      "exist, the instance answers 404 and the page says so, which it asserts.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/approval-requests\/apr_not_a_request$/u,
    tests: [
      "a member's proposal waits in the reviewer's Inbox, is rejected there and comes back decided"
    ]
  },
  {
    name: "decision-that-came-too-late",
    reason:
      "Chromium's own log line: the test decides a request the instance has already decided, " +
      "the instance answers 409 and the page says who decided, which it asserts.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/approval-requests\/[^/]+\/decide$/u,
    tests: ["a decision on a request that was decided meanwhile is refused in a sentence"]
  },
  {
    name: "page-of-conversations-that-fails",
    reason:
      "Chromium's own log line: the test answers one request for an older page of the " +
      "sidebar's conversations with 503 and asserts that the sidebar says so and tries again.",
    matches: requestAnswered(503),
    path: /^\/api\/v1\/conversations$/u,
    tests: [
      "the rail is the list of conversations: it loads a page at a time, the search finds what no loaded page holds, and an older open conversation is the first row"
    ]
  },
  {
    name: "unread-configuration-diagnostic",
    reason:
      "The interface writes this line itself when the instance configuration does not fit it, " +
      "for whoever operates the instance. The test serves such a configuration on purpose.",
    matches: /^The instance configuration does not fit this interface at: /u,
    tests: ["a configuration the interface cannot read shows an error that a retry recovers from"]
  },
  {
    // C-95: resize observer loop of the top-anchored thread.
    name: "thread-resize-observer-loop",
    reason:
      "Known and filed, not fixed here: while a turn is anchored to the top, the observers " +
      "with which assistant-ui keeps room under it change the layout they observe, and Chromium " +
      "delivers the rest a frame later. It depends on timing, so it is tied to the anchored turn " +
      "being on the page and not to a list of tests: a loop on any other page fails.",
    matches: new RegExp(
      `^Error event without an exception: ResizeObserver loop completed with undelivered notifications\\.${escapeRegExp(BESIDE_TOP_ANCHORED_TURN)}$`,
      "u"
    )
  }
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isAllowed(text: string, address: string, testTitle: string): boolean {
  const path = /^https?:/u.test(address) ? new URL(address).pathname : "";
  return allowedPageErrors.some(
    (allowed) =>
      allowed.matches.test(text) &&
      (allowed.path === undefined || allowed.path.test(path)) &&
      (allowed.tests === undefined || allowed.tests.includes(testTitle))
  );
}

export interface PageErrorWatch {
  /** Watches a context a test opened itself, such as a second user's, before it opens a page. */
  watch(context: BrowserContext): Promise<void>;
}

/**
 * The `test` of every browser spec. It fails a test whose pages threw an uncaught JavaScript
 * error or logged one with `console.error`, after the test's own steps have run.
 */
export const test = base.extend<{ pageErrors: PageErrorWatch }>({
  pageErrors: [
    async ({ context }, use, testInfo) => {
      const reported: string[] = [];
      const report = (kind: "pageerror" | "console.error", text: string, address = "") => {
        if (!isAllowed(text, address, testInfo.title)) {
          reported.push(address ? `${kind}: ${text} (${address})` : `${kind}: ${text}`);
        }
      };
      const watch = async (watched: BrowserContext) => {
        // An error event without an exception, such as a resize observer loop, reaches neither
        // the console nor `weberror`. The page logs it, so it is reported like the rest.
        await watched.addInitScript((besideTopAnchoredTurn) => {
          window.addEventListener("error", (event) => {
            if (event.error === null || event.error === undefined) {
              const anchored = document.querySelector("[data-aui-top-anchor-target]") !== null;
              console.error(
                `Error event without an exception: ${event.message}${anchored ? besideTopAnchoredTurn : ""}`
              );
            }
          });
        }, BESIDE_TOP_ANCHORED_TURN);
        watched.on("weberror", (webError) => report("pageerror", webError.error().message));
        watched.on("console", (message) => {
          if (message.type() === "error") {
            report("console.error", message.text(), message.location().url);
          }
        });
      };
      await watch(context);
      await use({ watch });
      expect(reported, "JavaScript errors on the page").toEqual([]);
    },
    { auto: true }
  ]
});

export { expect };
