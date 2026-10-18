// The messages a page may report as an error without failing its test, by name and reason.
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
export const BESIDE_TOP_ANCHORED_TURN = " (beside a turn anchored to the top)";

const PERSON_CONTEXT_TEST =
  "person context mappings are chosen by name, saved, refused when stale and removed";

const SESSION_CHANGE_TESTS = [
  "the next person in the same tab after a sign-out sees nothing of the person before",
  "a tab whose browser is signed in as another person without a sign-out forgets the person before"
] as const;

const allowedPageErrors: readonly AllowedPageError[] = [
  {
    name: "outside-app-font-refused",
    reason:
      "The font spec deliberately names Google Fonts and proves CSP prevents a network request.",
    matches:
      /^Loading the font 'https:\/\/fonts\.googleapis\.com\/blocked\.woff2' violates the following Content Security Policy directive: "font-src 'self' data:"\. The action has been blocked\.\s*$/u,
    tests: [
      "folder, kit and data fonts render in draft and published Apps without outside requests"
    ]
  },
  {
    name: "reply-remote-image-refused",
    reason:
      "Chromium's own log line for an image the interface's content policy refused. The test " +
      "plants remote images in a Mermaid diagram of a reply and asserts no request left.",
    matches:
      /^Loading the image 'https:\/\/outside-pixel\.example\.test\/[^']*' violates the following Content Security Policy directive: "img-src [^"]*"\. The action has been blocked\.\s*$/u,
    tests: ["a reply with remote images, also in a Mermaid diagram, makes no request outside"]
  },
  {
    name: "planted-send-now-failure",
    reason:
      "Chromium's own log line for the Send now request the picture test aborts on purpose, to " +
      "show the queue's error line.",
    matches: REQUEST_FAILED,
    path: /^\/api\/v1\/conversations\/[^/]+\/follow-ups\/dispatch$/u,
    tests: ["pictures of the queue's passing states"]
  },
  {
    name: "planted-phone-send-failure",
    reason:
      "The phone layout regression deliberately aborts a send to show its pinned run notice above a paused queue.",
    matches: REQUEST_FAILED,
    path: /^\/api\/v1\/conversations\/[^/]+\/runs$/u,
    tests: ["pinned chat bands cover the transcript and the return button clears the whole footer"]
  },
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
    name: "refused-default-agent",
    reason:
      "Chromium's own log line: the test asks for an agent that is not offered everywhere to " +
      "become the default, and asserts what the page shows for the 422.",
    matches: requestAnswered(422),
    path: /^\/api\/v1\/assets\/agent\/default$/u,
    tests: ["an agent's availability and the default agent are changed by the asset operations"]
  },
  {
    name: "refused-config-asset",
    reason:
      "Chromium's own log line: the test saves an asset that does not validate and one that " +
      "changed meanwhile, and asserts what the page shows for the 422 and the 412.",
    matches: new RegExp(`${requestAnswered(422).source}|${requestAnswered(412).source}`, "u"),
    path: /^\/api\/v1\/assets\//u,
    tests: ["superadmin manages config assets with validation and conflict protection"]
  },
  {
    name: "refused-skill-file",
    reason:
      "Chromium's own log line: the test saves a skill with a compiled program under scripts/ and " +
      "one with a Git LFS pointer, and asserts what the page shows for each 422.",
    matches: requestAnswered(422),
    path: /^\/api\/v1\/assets\/skill\/e2e_skill_files$/u,
    tests: [
      "a skill's files are uploaded, written, replaced and deleted, and a refused one is named"
    ]
  },
  {
    name: "drafted-connection-that-is-new",
    reason:
      "Chromium's own log line: the card of the agent's draft reads the Connection of its id, " +
      "for a new id the instance answers 404 and the card opens the New connection dialog, " +
      "which the test asserts.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/assets\/connection\/e2e-draft-new-/u,
    tests: ["en", "de"].map(
      (locale) =>
        `${locale}: the agent's draft is a card that opens the approval list, and only the approval saves it`
    )
  },
  {
    name: "asset-that-is-not-there",
    reason:
      "Chromium's own log line: the test opens the address of an agent that does not exist, " +
      "the instance answers 404 and the page says that there is no such agent.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/assets\/agent\/not_an_agent$/u,
    tests: ["Studio opens on a list, and a list and an asset each have an address"]
  },
  {
    name: "workflow-or-agent-that-is-not-there",
    reason:
      "Chromium's own log line: the tests open the address of a Workflow and of an agent that " +
      "do not exist, the instance answers 404 and the page shows the not-found state.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/assets\/(?:workflow\/e2e-missing-workflow|agent\/e2e_missing_agent)$/u,
    tests: [
      "a Workflow that is not there waits for the answer, then says so and leads to the list",
      "an agent's address without an agent waits for the answer, then says so without the id",
      "pictures of the not-found state on each surface, wide and narrow, light and dark, in both languages"
    ]
  },
  {
    name: "asset-of-another-owner",
    reason:
      "Chromium's own log line: Studio is set to the instance while the Data Store is a " +
      "workspace's, so its page asks the instance first, gets 404, and finds it in the workspace.",
    matches: requestAnswered(404),
    path: /^\/api\/v1\/assets\/data_store\/team-[0-9a-f]{6}$/u,
    tests: [
      "a workspace's Data Store opens from the Working on line and by its address after Studio was set to another owner"
    ]
  },
  {
    name: "refused-asset-in-build",
    reason:
      "Chromium's own log line: the test saves an agent with a tool its Namespace does not " +
      "allow and one that changed meanwhile, and opens an agent outside the Namespace. It " +
      "asserts what the page shows for the 403 and the 412.",
    matches: new RegExp(`${requestAnswered(403).source}|${requestAnswered(412).source}`, "u"),
    path: /^\/api\/v1\/assets\/agent\/(?:kai-helper|research_assistant)$/u,
    tests: [
      "a Namespace holder builds an agent in the Namespace, is refused, meets a conflict and restores"
    ]
  },
  {
    name: "asset-changed-or-gone-in-build",
    reason:
      "Chromium's own log lines: these tests save a skill that somebody saved or deleted " +
      "meanwhile and read one that is gone or whose read they cut off. They assert what the " +
      "page shows for the 412, the 404 and the failed read.",
    matches: new RegExp(
      `${requestAnswered(412).source}|${requestAnswered(404).source}|net::ERR_FAILED`,
      "u"
    ),
    path: /^\/api\/v1\/assets\/skill\/e2e_(?:reload|deleted|phone)_probe$/u,
    tests: [
      "the notice of a newer version leaves the text in reach on a phone, in German",
      "a newer version that cannot be loaded leaves the page as it is and says so",
      "an asset that was deleted meanwhile says so, keeps the text and offers the way out"
    ]
  },
  {
    name: "refused-right-for-a-principal",
    reason:
      "Chromium's own log line: the test gives a service principal a right on a Connection " +
      "that was deleted meanwhile, the instance answers 422, and the dialog says what was " +
      "refused and what to do, which the test asserts.",
    matches: requestAnswered(422),
    path: /^\/api\/v1\/instance\/access\/grants$/u,
    tests: [
      "a superadmin gives a service principal a Connection, is refused one that is gone, and removes the right"
    ]
  },
  {
    name: "start-input-refused",
    reason:
      "Chromium's own log line: the test publishes a Workflow again with a smaller limit while " +
      "its start form is open, the instance answers the start with 422, and the form puts the " +
      "refusal under the field, which the test asserts.",
    matches: requestAnswered(422),
    path: /^\/api\/v1\/workflows\/start-form-[0-9a-f]{8}\/runs$/u,
    tests: [
      "a member starts a Workflow with inputs from its form and sees the run end; a reader sees no start"
    ]
  },
  {
    name: "grant-already-there",
    reason:
      "Chromium's own log line: the test asks for two grants of which one exists, the " +
      "instance answers 409 for that one, and the page says that it left it alone, which the " +
      "test asserts.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/instance\/access\/grants$/u,
    tests: ["an administrator registers a Namespace, grants, checks, denies, revokes and deletes"]
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
    name: "connection-test-that-is-refused",
    reason:
      "Chromium's own log line: the test answers one test of a Connection with 403 and asserts " +
      "that the page says the reader may not test it.",
    matches: requestAnswered(403),
    path: /^\/api\/v1\/connections\/[^/]+\/test$/u,
    tests: [
      "a Connection's page shows its definition, its state in every case and the test, and writes nothing"
    ]
  },
  {
    name: "connection-state-that-fails",
    reason:
      "Chromium's own log line: the test answers the read of a Connection's state with 500 and " +
      "asserts that the page says so, offers a retry and still shows the definition.",
    matches: requestAnswered(500),
    path: /^\/api\/v1\/connections\/[^/]+$/u,
    tests: [
      "a Connection's page shows its definition, its state in every case and the test, and writes nothing"
    ]
  },
  {
    name: "app-action-refused-for-a-missing-right",
    reason:
      "Chromium's own log line: a member without the right on the Connection opens the App, " +
      "the call of its tile is answered with 403, and the test asserts that the tile names the right.",
    matches: requestAnswered(403),
    path: /^\/api\/v1\/app-content-sessions\/[^/]+\/actions\/load-rows$/u,
    tests: ["a tile of a published App reads rows through a named action with the viewer's rights"]
  },
  {
    name: "app-workflow-action-refused-for-a-missing-right",
    reason:
      "Chromium's own log line: a member without the use right on the Workflow presses the " +
      "App's button, the call is answered with 403, and the test asserts that the App names the right.",
    matches: requestAnswered(403),
    path: /^\/api\/v1\/app-content-sessions\/[^/]+\/actions\/log-visit$/u,
    tests: [
      "an App button starts a published Workflow and shows its output; the draft and a member without the right start nothing"
    ]
  },
  {
    name: "app-actions-list-that-fails",
    reason:
      "Chromium's own log line: the test answers one read of an App's actions with 500 and " +
      "asserts that the Actions side says so and offers a retry.",
    matches: requestAnswered(500),
    path: /^\/api\/v1\/app-actions$/u,
    tests: [
      "a builder reads the actions of a draft, tests a reading one and finds its run in Operations"
    ]
  },
  {
    name: "app-action-test-that-is-refused",
    reason:
      "Chromium's own log line: the test answers one test call of an action with 403 and " +
      "asserts that the dialog shows the refusal with its status.",
    matches: requestAnswered(403),
    path: /^\/api\/v1\/app-content-sessions\/[^/]+\/actions\/load-rows$/u,
    tests: [
      "a builder reads the actions of a draft, tests a reading one and finds its run in Operations"
    ]
  },
  {
    name: "settings-refusals-that-name-an-admin",
    reason:
      "Chromium's own log line: the tests answer a read or a change on Usage, API keys and " +
      "Members with 403 and assert that the refusal names an instance admin to ask.",
    matches: requestAnswered(403),
    path: /^\/api\/v1\/(?:instance\/usage|me\/api-keys(?:\/[^/]+\/revoke)?|workspaces\/[^/]+\/access-requests\/[^/]+\/approve)$/u,
    tests: [
      "Usage opens with the month's cost of its budget and the tokens under it, and a refusal names an instance admin",
      "API keys open with the person's keys, and refusals name an instance admin",
      "Members come first, requests show only while somebody asks, and a refusal names an instance admin in its section"
    ]
  },
  {
    name: "save-as-app-under-a-taken-id",
    reason:
      "Chromium's own log line: the test saves a Page under the id of an App that exists, the " +
      "save is answered with 409, and the test asserts that the dialog offers to update that App.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/apps$/u,
    tests: ["a Page is put into an App that was saved before Apps remembered their Page"]
  },
  {
    name: "app-update-over-a-draft-that-moved",
    reason:
      "Chromium's own log line: the test writes the draft of an App with the API while the " +
      "update of it is asked for, the update is answered with 412, and the test asserts that " +
      "the dialog says so and offers to replace the draft.",
    matches: requestAnswered(412),
    path: /^\/api\/v1\/apps\/[^/]+\/update-from-page$/u,
    tests: ["a Page saved as an App updates the draft of that App, and nothing that is published"]
  },
  {
    name: "oauth-start-without-a-client",
    reason:
      "Chromium's own log line: the provider of the sample registers no client, the start of " +
      "the sign-in is answered with 409, and the test asserts that the step asks for the client " +
      "the provider issued.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/connections\/[^/]+\/oauth\/start$/u,
    tests: [
      "en: a provider that registers no client asks for the one it issued, and an unticked permission is not asked for"
    ]
  },
  {
    name: "agent-draft-saved-over-a-newer-draft",
    reason:
      "Chromium's own log line: the test saves the agent's draft with the API while a writer " +
      "edits it on the page, the writer's save is answered with 412, and the test asserts that " +
      "the page names who saved the newer draft and offers to load it.",
    matches: requestAnswered(412),
    path: /^\/api\/v1\/assets\/agent\/[^/]+$/u,
    tests: [
      "a writer without agent.publish, a draft written meanwhile, a reader, and a publish grant on the agent"
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
    name: "session-change-refused-upload",
    reason:
      "The account-switch tests deliberately refuse A's unsupported file before switching to B.",
    matches: requestAnswered(422),
    path: /^\/api\/v1\/conversations\/[^/]+\/draft-attachments$/u,
    tests: SESSION_CHANGE_TESTS
  },
  {
    name: "session-change-foreign-reads",
    reason:
      "After B signs in, in-flight reads of A's workspace and conversations are correctly refused. The tests assert no A state is shown to B.",
    matches: new RegExp(`${requestAnswered(403).source}|${requestAnswered(404).source}`, "u"),
    path: /^\/api\/v1\/(?:conversations(?:\/[^/]+\/(?:thread|draft-attachments|resources|runs|subagents))?|workspaces\/[^/]+\/agents)$/u,
    tests: SESSION_CHANGE_TESTS
  },
  {
    name: "dock-thread-rate-limited",
    reason:
      "Chromium's own log line: the test answers the dock's thread once with 429 and asserts " +
      "that it is asked for again.",
    matches: requestAnswered(429),
    path: /^\/api\/v1\/conversations\/[^/]+\/thread$/u,
    tests: ["a thread answered once with 429 is tried again and shows in the dock"]
  },
  {
    name: "person-context-save-that-is-stale",
    reason:
      "Chromium's own log line: the test saves a mapping from an outdated version, the " +
      "instance answers 409 and the test asserts that the page refuses the stale save.",
    matches: requestAnswered(409),
    path: /^\/api\/v1\/connections\/e2e-person-context-[0-9a-f]{8}\/person-context$/u,
    tests: [PERSON_CONTEXT_TEST]
  },
  {
    name: "person-context-read-that-fails",
    reason:
      "Chromium's own log line: the test answers the read of a Connection's person context " +
      "mappings with 500 and asserts that the page says so.",
    matches: requestAnswered(500),
    path: /^\/api\/v1\/connections\/e2e-person-context-[0-9a-f]{8}\/person-context$/u,
    tests: [PERSON_CONTEXT_TEST]
  },
  {
    name: "person-context-user-list-that-fails-or-is-refused",
    reason:
      "Chromium's own log line: the test replaces the list of the instance's users with a 500 " +
      "failure and a 403 refusal and asserts the page's failure and no-permission states.",
    matches: new RegExp(`${requestAnswered(500).source}|${requestAnswered(403).source}`, "u"),
    path: /^\/api\/v1\/instance\/users$/u,
    tests: [PERSON_CONTEXT_TEST]
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

export function isAllowed(text: string, address: string, testTitle: string): boolean {
  const path = /^https?:/u.test(address) ? new URL(address).pathname : "";
  return allowedPageErrors.some(
    (allowed) =>
      allowed.matches.test(text) &&
      (allowed.path === undefined || allowed.path.test(path)) &&
      (allowed.tests === undefined || allowed.tests.includes(testTitle))
  );
}
