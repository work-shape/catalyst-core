import { expect, test as base, type BrowserContext } from "@playwright/test";

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
    path: /^\/api\/v1\/instance\/config\/assets\//u,
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
    name: "unread-configuration-diagnostic",
    reason:
      "The interface writes this line itself when the instance configuration does not fit it, " +
      "for whoever operates the instance. The test serves such a configuration on purpose.",
    matches: /^The instance configuration does not fit this interface at: /u,
    tests: ["a configuration the interface cannot read shows an error that a retry recovers from"]
  },
  {
    // C-153: navigate-to directive.
    name: "view-policy-navigate-to",
    reason:
      "Known and filed, not fixed here: the policy of a generated view names the directive " +
      "`navigate-to`, which Chromium does not know and reports for every view it shows.",
    matches: /^Unrecognized Content-Security-Policy directive 'navigate-to'\.$/u
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

interface PageErrorWatch {
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
