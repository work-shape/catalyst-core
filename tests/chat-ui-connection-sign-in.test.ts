// @vitest-environment happy-dom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type ConnectionDetail,
  type ConnectionOAuthStart
} from "@work-shape/catalyst-api-client";
import {
  ConnectionSignInLanding,
  SignInActions,
  SignInBody,
  needsSignIn,
  readSignInLanding,
  readSignInMessage,
  scopesToWrite,
  signInHeading,
  signedInSince,
  useConnectionSignIn,
  waitForSignIn,
  withOAuthSettings,
  type SignInBrowser,
  type SignInCalls,
  type SignInLanding
} from "@work-shape/catalyst-chat-ui/build-area";
import { useTranslation } from "@work-shape/catalyst-chat-ui";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// The shared OAuth sign-in of a Connection (CS-4b4): the step the New connection dialog and the
// Connection page show, against a browser of the test's own. The step names the provider's host
// and the permissions, writes changed permissions before the provider's page opens, waits until
// the Connection is signed in anew, and says why a sign-in that came back refused did not work.

const HOST = "auth.example.test";
const CLIENT_SECRET = "client-secret-never-shown-42";
const CONNECTED_AT = "2026-10-17T09:00:00.000Z";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function start(n: number, scopes = ["files.read", "files.write"]): ConnectionOAuthStart {
  return {
    signInId: `setup_${n}`,
    authorizationUrl: `https://${HOST}/authorize?attempt=${n}`,
    providerHost: HOST,
    scopes,
    expiresAt: new Date(10 * 60_000).toISOString()
  };
}

function refusal(reason: string): ApiError {
  return new ApiError(409, "refused", {
    error: { code: "CONFLICT", message: "refused", correlationId: "corr_1", details: { reason } }
  });
}

/** A browser whose clock, tabs and landing tabs the test moves. */
function testBrowser(input: { blocked?: boolean } = {}) {
  let clock = 0;
  const opened: { urls: string[]; closed: boolean }[] = [];
  const listeners = new Set<(landing: SignInLanding) => void>();
  const pauses: (() => void)[] = [];
  const browser: SignInBrowser = {
    openTab() {
      if (input.blocked) return undefined;
      const tab = { urls: [] as string[], closed: false };
      opened.push(tab);
      return { go: (url) => tab.urls.push(url), close: () => (tab.closed = true) };
    },
    listen(onLanding) {
      listeners.add(onLanding);
      return () => listeners.delete(onLanding);
    },
    pause: (ms, signal) =>
      new Promise((resolve) => {
        pauses.push(() => {
          clock += ms;
          resolve();
        });
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    now: () => clock
  };
  return {
    browser,
    opened,
    /** The landing tab tells the outcome on the channel. */
    land: (landing: SignInLanding) => [...listeners].forEach((listener) => listener(landing)),
    /** The waits that are due end. */
    tick: () => pauses.splice(0).forEach((resume) => resume()),
    listening: () => listeners.size
  };
}

/** The Connection's calls, recorded in order. Its binding is what the test sets. */
function testCalls(
  input: { starts?: (() => ConnectionOAuthStart)[]; detail?: Partial<ConnectionDetail> } = {}
) {
  const log: string[] = [];
  const state: { binding?: ConnectionDetail["binding"] } = {};
  const starts = [...(input.starts ?? [])];
  let attempt = 0;
  const calls: Required<SignInCalls> = {
    connection: "crm",
    start: async () => {
      attempt += 1;
      log.push("connections.oauth_start");
      const next = starts.shift();
      return next ? next() : start(attempt);
    },
    readDetail: async () => {
      log.push("connections.get");
      return connectionDetail("crm", {
        oauth: { registration: "dcr", providerHost: HOST },
        ...input.detail,
        ...(state.binding ? { binding: state.binding } : {})
      });
    },
    writeOAuth: async (oauth) => {
      log.push(`assets.put(${JSON.stringify(oauth)})`);
      return 4;
    },
    setSecret: async (value, expectedVersion, expectedRevision) => {
      log.push(
        `connections.set_secret(${value === CLIENT_SECRET ? "secret" : "?"},${expectedVersion},${expectedRevision})`
      );
    }
  };
  const signIn = () => {
    state.binding = {
      state: "connected",
      scopes: ["files.read"],
      connectedAt: CONNECTED_AT,
      connectedBy: "user_admin"
    };
  };
  return { calls, log, signIn };
}

function SignInHarness({
  calls,
  browser,
  onConnected
}: {
  calls: SignInCalls;
  browser: SignInBrowser;
  onConnected(detail: ConnectionDetail): void;
}) {
  const { t } = useTranslation();
  const signIn = useConnectionSignIn(calls, { onConnected, browser });
  return createElement(
    "section",
    null,
    createElement("h2", null, signInHeading(signIn, t)),
    createElement(SignInBody, { signIn }),
    createElement(SignInActions, { signIn })
  );
}

function mount(node: ReactElement, locale: "en" | "de") {
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(TranslationProvider, { locale, children: null }, node)
      )
    )
  );
}

/** Lets the promises the step waits on settle. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function element(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`nothing matches ${selector}: ${host.innerHTML}`);
  return found;
}

async function click(selector: string) {
  await act(async () => element(selector).click());
  await settle();
}

function typeInto(selector: string, value: string) {
  const input = element(selector);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${selector} is no input`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the sign-in step", () => {
  it("names the host and the permissions, writes an unticked one, opens the page and goes on once signed in", async () => {
    const run = testCalls();
    const tabs = testBrowser();
    const connected = vi.fn();
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: connected
      }),
      "de"
    );
    await settle();

    expect(element("h2").textContent).toBe(`Anmeldung bei ${HOST}`);
    expect(element("[data-sign-in-shared]").textContent).toBe(
      "Alle, die diese Verbindung nutzen dürfen, lesen und handeln über das Konto, mit dem du dich jetzt anmeldest."
    );
    const scopes = [...host.querySelectorAll("[data-sign-in-scope]")].map((box) =>
      box.getAttribute("data-sign-in-scope")
    );
    expect(scopes).toEqual(["files.read", "files.write"]);
    expect(element("[data-sign-in-open]").textContent).toBe(`Bei ${HOST} anmelden`);

    // files.write is not asked for: the definition says so before the provider's page opens.
    await click('[data-sign-in-scope="files.write"]');
    await click("[data-sign-in-open]");
    expect(run.log).toEqual([
      "connections.get",
      "connections.oauth_start",
      'assets.put({"scopes":["files.read"]})',
      "connections.oauth_start",
      "connections.get"
    ]);
    // The tab opened in the click goes to the page of the start made with the written scopes.
    expect(tabs.opened).toEqual([{ urls: [`https://${HOST}/authorize?attempt=2`], closed: false }]);
    expect(element("[data-sign-in-step]").getAttribute("data-sign-in-step")).toBe("waiting");
    expect(element("[data-sign-in-cancel]").textContent).toBe("Abbrechen");

    // Still nobody signed in: the step reads again and waits.
    tabs.tick();
    await settle();
    expect(connected).not.toHaveBeenCalled();

    run.signIn();
    tabs.tick();
    await settle();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connected.mock.calls[0]?.[0]).toMatchObject({ binding: { state: "connected" } });
    expect(tabs.listening()).toBe(0);
  });

  it("says at the step that the provider declined, and starts again on the next open", async () => {
    const run = testCalls();
    const tabs = testBrowser();
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: vi.fn()
      }),
      "de"
    );
    await settle();
    await click("[data-sign-in-open]");
    expect(tabs.opened[0]?.urls).toEqual([`https://${HOST}/authorize?attempt=1`]);

    act(() => tabs.land({ outcome: "oauth_denied", connection: "crm" }));
    await settle();
    expect(element("[data-sign-in-error]").getAttribute("data-sign-in-error")).toBe("oauth_denied");
    expect(element("[data-sign-in-error]").textContent).toBe(
      `Die Anmeldung wurde bei ${HOST} abgelehnt oder abgebrochen.`
    );

    // The start the provider sent back is spent: the next open makes a new one.
    await click("[data-sign-in-open]");
    expect(tabs.opened[1]?.urls).toEqual([`https://${HOST}/authorize?attempt=2`]);
  });

  it("hears no landing of another Connection, and cancels its wait", async () => {
    const run = testCalls();
    const tabs = testBrowser();
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: vi.fn()
      }),
      "en"
    );
    await settle();
    await click("[data-sign-in-open]");
    act(() => tabs.land({ outcome: "oauth_denied", connection: "other" }));
    await settle();
    expect(element("[data-sign-in-step]").getAttribute("data-sign-in-step")).toBe("waiting");
    await click("[data-sign-in-cancel]");
    expect(host.querySelector("[data-sign-in-error]")).toBeNull();
    expect(element("[data-sign-in-open]").textContent).toBe(`Sign in at ${HOST}`);
  });

  it("asks to allow pop-ups where the browser opened no tab", async () => {
    const run = testCalls();
    const tabs = testBrowser({ blocked: true });
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: vi.fn()
      }),
      "en"
    );
    await settle();
    await click("[data-sign-in-open]");
    expect(element("[data-sign-in-error]").getAttribute("data-sign-in-error")).toBe("tab_blocked");
    expect(run.log).toEqual(["connections.get", "connections.oauth_start"]);
  });

  it("asks for the client of a provider that registers none, with the redirect URI to copy", async () => {
    const run = testCalls({
      starts: [
        () => {
          throw refusal("oauth_client_required");
        }
      ],
      detail: {
        oauth: {
          registration: "preregistered",
          providerHost: HOST,
          redirectUri: "https://chat.example.com/api/v1/connections/oauth/callback"
        }
      }
    });
    const tabs = testBrowser();
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: vi.fn()
      }),
      "de"
    );
    await settle();
    expect(element("h2").textContent).toBe("Instanz beim Anbieter registrieren");
    expect(element("[data-sign-in-redirect-uri]").textContent).toBe(
      "https://chat.example.com/api/v1/connections/oauth/callback"
    );
    expect(element("[data-sign-in-save-client]").hasAttribute("disabled")).toBe(true);

    typeInto('[data-sign-in-field="clientId"]', " client-123 ");
    typeInto('[data-sign-in-field="clientSecret"]', CLIENT_SECRET);
    await click("[data-sign-in-save-client]");
    expect(run.log).toEqual([
      "connections.get",
      "connections.oauth_start",
      'assets.put({"clientId":"client-123"})',
      "connections.get",
      // The client secret is for the revision that wrote the client.
      "connections.set_secret(secret,2,4)",
      "connections.get",
      "connections.oauth_start"
    ]);
    expect(element("h2").textContent).toBe(`Anmeldung bei ${HOST}`);
    expect(host.innerHTML).not.toContain(CLIENT_SECRET);
  });

  it("says why a start was refused, and tries again", async () => {
    const run = testCalls({
      starts: [
        () => {
          throw refusal("oauth_pkce_unsupported");
        }
      ]
    });
    const tabs = testBrowser();
    mount(
      createElement(SignInHarness, {
        calls: run.calls,
        browser: tabs.browser,
        onConnected: vi.fn()
      }),
      "en"
    );
    await settle();
    expect(element("[data-sign-in-error]").getAttribute("data-sign-in-error")).toBe(
      "oauth_pkce_unsupported"
    );
    await click("[data-sign-in-retry]");
    expect(element("[data-sign-in-step]").getAttribute("data-sign-in-step")).toBe("ready");
  });
});

describe("waiting for the other tab", () => {
  const detail = (binding?: ConnectionDetail["binding"]) =>
    connectionDetail("crm", binding ? { binding } : {});
  const signedIn = { state: "connected" as const, scopes: [], connectedAt: CONNECTED_AT };

  it("ends when the session of the start runs out", async () => {
    let clock = 0;
    const waited = waitForSignIn(
      {
        readDetail: async () => detail(),
        pause: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        listen: () => () => undefined
      },
      {
        connection: "crm",
        start: start(1),
        before: undefined,
        signal: new AbortController().signal
      }
    );
    await expect(waited).resolves.toEqual({
      status: "failed",
      error: { failure: "oauth_session_expired" }
    });
  });

  it("tells a sign-in made now from the one the Connection had", () => {
    expect(signedInSince(detail(signedIn), detail())).toBe(true);
    expect(signedInSince(detail(signedIn), detail(signedIn))).toBe(false);
    expect(
      signedInSince(
        detail({ ...signedIn, connectedAt: "2026-10-17T10:00:00.000Z" }),
        detail(signedIn)
      )
    ).toBe(true);
    expect(signedInSince(detail({ ...signedIn, state: "needs_reconnect" }), undefined)).toBe(false);
  });

  it("finds a Connection that signs in with nobody signed in", () => {
    const oauth = { registration: "dcr" as const, providerHost: HOST };
    expect(needsSignIn(connectionDetail("crm", { oauth }))).toBe(true);
    expect(needsSignIn(connectionDetail("crm", { oauth, binding: signedIn }))).toBe(false);
    expect(needsSignIn(connectionDetail("crm"))).toBe(false);
  });

  it("writes only the permissions that differ from those asked for, in their order", () => {
    const offered = ["a", "b", "c"];
    expect(scopesToWrite(offered, new Set(["a", "b", "c"]), ["a", "b", "c"])).toBeUndefined();
    expect(scopesToWrite(offered, new Set(["c", "a"]), ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(scopesToWrite(offered, new Set(), ["a"])).toEqual([]);
  });

  it("keeps the definition's settings when it writes the OAuth ones", () => {
    expect(
      withOAuthSettings(
        { authScheme: "none", settings: { url: "https://x.test/mcp", oauth: { clientId: "c" } } },
        { scopes: ["a"] }
      )
    ).toEqual({
      authScheme: "oauth",
      settings: { url: "https://x.test/mcp", oauth: { clientId: "c", scopes: ["a"] } }
    });
  });
});

describe("the page a sign-in lands on", () => {
  it("reads the outcome and the Connection's name from its address and nothing else", () => {
    expect(
      readSignInLanding({
        pathname: "/build/connections",
        search: "?signIn=connected&connection=crm"
      })
    ).toEqual({ outcome: "connected", connection: "crm" });
    expect(
      readSignInLanding({ pathname: "/build/connections/", search: "?signIn=oauth_denied" })
    ).toEqual({ outcome: "oauth_denied" });
    // An outcome nobody knows is "did not work"; a name that is no Connection's is left out.
    expect(
      readSignInLanding({
        pathname: "/build/connections",
        search: "?signIn=%3Cscript%3E&connection=..%2Fsettings"
      })
    ).toEqual({ outcome: "failed" });
    expect(readSignInLanding({ pathname: "/build/connections", search: "" })).toBeUndefined();
    expect(
      readSignInLanding({ pathname: "/build/agents", search: "?signIn=connected" })
    ).toBeUndefined();
    expect(readSignInMessage({ outcome: "oauth_state_invalid", connection: 3 })).toEqual({
      outcome: "oauth_state_invalid"
    });
    expect(readSignInMessage("connected")).toBeUndefined();
  });

  it("says why a sign-in did not work, takes the outcome out of the address and tells the waiting tab", async () => {
    window.history.replaceState(
      null,
      "",
      "/build/connections?signIn=oauth_session_expired&connection=crm"
    );
    const told: unknown[] = [];
    const channel = new BroadcastChannel("catalyst:connection-sign-in");
    channel.onmessage = (event: MessageEvent<unknown>) => told.push(event.data);
    const open = vi.fn();
    const landing = readSignInLanding(window.location);
    if (!landing) throw new Error("The address holds no landing.");
    mount(createElement(ConnectionSignInLanding, { landing, onOpen: open }), "de");
    await settle();

    expect(element("[data-sign-in-landing]").getAttribute("data-sign-in-landing")).toBe(
      "oauth_session_expired"
    );
    expect(host.textContent).toContain("Die Anmeldung hat nicht geklappt");
    expect(host.textContent).toContain("Die Anmeldung hat zu lange gedauert. Starte sie neu.");
    expect(window.location.pathname + window.location.search).toBe("/build/connections");
    expect(told).toEqual([{ outcome: "oauth_session_expired", connection: "crm" }]);
    channel.close();

    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Zur Verbindung"
    );
    await act(async () => button?.click());
    expect(open).toHaveBeenCalledWith("crm");
  });

  it("closes a tab that signed in", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    mount(
      createElement(ConnectionSignInLanding, {
        landing: { outcome: "connected" },
        onOpen: vi.fn()
      }),
      "de"
    );
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Verbunden. Du kannst diesen Tab schließen.");
    expect(host.textContent).toContain("Zu den Verbindungen");
  });

  it("says a declined sign-in without a host it does not know", async () => {
    mount(
      createElement(ConnectionSignInLanding, {
        landing: { outcome: "oauth_denied" },
        onOpen: vi.fn()
      }),
      "de"
    );
    await settle();
    expect(host.textContent).toContain(
      "Die Anmeldung wurde beim Anbieter abgelehnt oder abgebrochen."
    );
  });
});
