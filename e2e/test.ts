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
}

const allowedPageErrors: readonly AllowedPageError[] = [
  {
    name: "browser-network-log",
    reason:
      "Chromium's own log line for a request that failed or was answered with an error status. " +
      "No script wrote it: the sign-in page asks for a session and is told 401, and tests abort " +
      "or fail requests on purpose. What the page makes of the answer is what those tests assert.",
    matches: /^Failed to load resource: /u
  },
  {
    name: "content-security-policy-refusal",
    reason:
      "Chromium's own log line for a load a generated view's policy refused. The view runtime " +
      "tests plant such loads on purpose and assert that nothing reached the other host.",
    matches:
      /violates the following Content Security Policy directive: |^Fetch API cannot load \S+ Refused to connect because it violates the document's Content Security Policy\.$/u
  },
  {
    name: "unread-configuration-diagnostic",
    reason:
      "The interface writes this line itself when the instance configuration does not fit it, " +
      "for whoever operates the instance. One test serves such a configuration on purpose.",
    matches: /^The instance configuration does not fit this interface at: /u
  },
  {
    name: "view-policy-navigate-to",
    reason:
      "Known and filed, not fixed here: the policy of a generated view names the directive " +
      "`navigate-to`, which Chromium does not know and reports for every view it shows.",
    matches: /^Unrecognized Content-Security-Policy directive 'navigate-to'\.$/u
  },
  {
    name: "thread-resize-observer-loop",
    reason:
      "Known and filed, not fixed here: while a run answers in a thread anchored to the top, " +
      "the observers with which assistant-ui keeps room under the turn change the layout they " +
      "observe, and Chromium delivers the rest a frame later. Without the top anchor the message " +
      "is gone. The composer growing does not cause it, which its own test asserts.",
    matches:
      /^Error event without an exception: ResizeObserver loop completed with undelivered notifications\.$/u
  }
];

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
    async ({ context }, use) => {
      const reported: string[] = [];
      const report = (kind: "pageerror" | "console.error", text: string) => {
        if (!allowedPageErrors.some((allowed) => allowed.matches.test(text))) {
          reported.push(`${kind}: ${text}`);
        }
      };
      const watch = async (watched: BrowserContext) => {
        // An error event without an exception, such as a resize observer loop, reaches neither
        // the console nor `weberror`. The page logs it, so it is reported like the rest.
        await watched.addInitScript(() => {
          window.addEventListener("error", (event) => {
            if (event.error === null || event.error === undefined) {
              console.error(`Error event without an exception: ${event.message}`);
            }
          });
        });
        watched.on("weberror", (webError) => report("pageerror", webError.error().message));
        watched.on("console", (message) => {
          if (message.type() === "error") {
            report("console.error", message.text());
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
