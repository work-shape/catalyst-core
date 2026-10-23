// The messages a page may report as an error without failing its test, by name and reason.
import { pageExitTitle, pageLoadExits, pageNavigationExits, pageTestTitles } from "./page-exits";

/**
 * A message a page may report as an error without failing its test. Every entry names one
 * known message and says why it is let through; a new error is fixed, or filed and added with
 * its reason to the spec that causes it (here only when several specs do), never matched by a
 * wider pattern.
 */
export interface AllowedPageError {
  name: string;
  reason: string;
  matches: RegExp;
  /** For the browser's line about a request: the path of the address that was asked for. */
  path?: RegExp;
  /** The tests that cause the message on purpose, by title. Without it, any test may meet it. */
  tests?: readonly string[];
}

/**
 * A spec's own allowed messages: `test.use({ allowedPageErrors: { errors: [...] } })`. The list
 * is wrapped because Playwright reads an array given to `test.use` as a value and its options,
 * which took a spec's second entry for the options of its first.
 */
export interface SpecPageErrors {
  readonly errors: readonly AllowedPageError[];
}

export const REQUEST_FAILED = /^Failed to load resource: net::ERR_(?:CONNECTION_)?FAILED$/u;
export const requestAnswered = (status: number) =>
  new RegExp(`^Failed to load resource: the server responded with a status of ${status} `, "u");

/** Appended to the report of a resize observer loop while a turn is anchored to the top. */
export const BESIDE_TOP_ANCHORED_TURN = " (beside a turn anchored to the top)";

/**
 * The entries more than one spec meets. An entry for one spec's tests lives in that spec, as
 * `test.use({ allowedPageErrors: { errors: [...] } })`, so a new spec does not edit this list.
 */
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
    name: "grant-already-there",
    reason:
      "Chromium's own log line: the test raises a level, whose lower rows exist, the " +
      "instance answers 409 for those, and the page says that it left them alone, which the " +
      "test asserts.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/instance\/access\/grants$/u,
    tests: [
      "an administrator grants by level, checks, denies and revokes rights",
      "an admin gives a member reading and using on one Workflow and removes both"
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
        /^Sending form data to '[^']*' violates the following Content Security Policy directive: "form-action 'none'"\. The request has been blocked\.\s*$/u,
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
      pageTestTitles.failClosed,
      "a Page built in chat shows beside the conversation, changes with the next save and is found again after a reload"
    ]
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
      "a view with private rows sends no WebRTC packet",
      "the gallery shows MailPreview, RecipientField and TemplateTextField light, dark and at 390",
      "show_view in a marked conversation stores a static view and sends no WebRTC packet"
    ]
  },
  {
    name: "dock-conversation-not-readable",
    reason:
      "Chromium's own log line: the address names a conversation of another person, or one " +
      "nobody has, in the dock, the instance refuses its thread, and the dock opens empty, " +
      "which the test asserts or starts from.",
    matches: new RegExp(`${requestAnswered(403).source}|${requestAnswered(404).source}`, "u"),
    path: /^\/api\/v1\/conversations(?:\/[^/]+\/(?:thread|draft-attachments|resources|runs))?$/u,
    tests: [
      "a person who may not read the dock's conversation gets an empty dock and no error",
      "a link to a conversation the person may not read opens the empty dock at once, and a message typed meanwhile raises no error",
      "on a slow connection, a message typed into the dock of a refused link is not sent",
      "an agent has the same mark on the Agents page, in Studio and in the dock"
    ]
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

export function isAllowed(
  text: string,
  address: string,
  testTitle: string,
  specErrors: readonly AllowedPageError[] = []
): boolean {
  const path = /^https?:/u.test(address) ? new URL(address).pathname : "";
  return [...allowedPageErrors, ...specErrors].some(
    (allowed) =>
      allowed.matches.test(text) &&
      (allowed.path === undefined || allowed.path.test(path)) &&
      (allowed.tests === undefined || allowed.tests.includes(testTitle))
  );
}
