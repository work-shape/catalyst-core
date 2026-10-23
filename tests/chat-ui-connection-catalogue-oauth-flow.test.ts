// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import {
  CatalogueInstall,
  type CatalogueEntryOffer,
  type ConnectionSource,
  type SignInBrowser
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";
import { mailbox } from "./chat-ui-catalogue-oauth-fixtures";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// The install of an OAuth catalogue part, clicked through (CAT-OAUTH-UI). Verbinden saves and
// sets the client secret without a test; Freigeben writes the approved operations with their
// scopes; only then does a shared part sign in, or a personal part offer the admin's own
// account. Fails where a sign-in would start before the approval, where the review would write
// other scopes than its groups name, or where a step would skip one of these.

const CLIENT_SECRET = "client-secret-never-shown-7";
const part = required(mailbox.parts[0]);

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

/** A browser whose tabs and waits the test moves. */
function testBrowser() {
  const opened: string[][] = [];
  const pauses: (() => void)[] = [];
  const browser: SignInBrowser = {
    openTab() {
      const urls: string[] = [];
      opened.push(urls);
      return { go: (url) => urls.push(url), close: () => undefined };
    },
    listen: () => () => undefined,
    pause: (_ms, signal) =>
      new Promise((resolve) => {
        pauses.push(() => resolve());
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    now: () => 0
  };
  return { browser, opened, tick: () => pauses.splice(0).forEach((resume) => resume()) };
}

/** The instance's side: each call in order, and the sign-ins the test completes. */
function testSource() {
  const log: string[] = [];
  const puts: Record<string, unknown>[] = [];
  /** The revision each write named. */
  const bases: (number | null)[] = [];
  const state: { shared?: boolean; own?: boolean } = {};
  const binding: ConnectionDetail["binding"] = {
    state: "connected",
    scopes: ["openid"],
    connectedAt: "2026-10-23T10:00:00.000Z",
    connectedBy: "user_admin"
  };
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () =>
      connectionDetail("mailbox", {
        oauth: { registration: "preregistered", providerHost: "login.example.test" },
        ...(state.shared ? { binding } : {})
      }),
    readOwnSignIn: async () => (state.own ? { binding } : {}),
    test: async () => {
      log.push("connections.test");
      return { status: "ready", testedAt: "2026-10-23T10:00:00.000Z" };
    },
    setSecret: async (_name, value) => {
      log.push(`connections.set_secret(${value === CLIENT_SECRET ? "secret" : "?"})`);
    },
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      log.push("connections.oauth_start");
      return {
        signInId: "setup_1",
        authorizationUrl: "https://login.example.test/authorize?attempt=1",
        providerHost: "login.example.test",
        scopes: ["openid", "email", "mail.read"],
        expiresAt: new Date(10 * 60_000).toISOString()
      };
    }
  };
  const put = async (input: {
    config: Record<string, unknown>;
    expectedRevision: number | null;
  }) => {
    log.push("assets.put");
    puts.push(input.config);
    bases.push(input.expectedRevision);
    return { revision: puts.length };
  };
  return { source, put, puts, bases, log, state };
}

function mount(
  entry: CatalogueEntryOffer,
  run: ReturnType<typeof testSource>,
  browser: SignInBrowser
) {
  const created = vi.fn();
  act(() =>
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(
          TranslationProvider,
          { locale: "en", children: null },
          createElement(CatalogueInstall, {
            entry,
            source: run.source,
            browser,
            checkName: async () => ({ available: true as const }),
            put: run.put,
            onClose: () => undefined,
            onCreated: created,
            onBack: () => undefined
          })
        )
      )
    )
  );
  return created;
}

async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
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

/** Client id and secret, Verbinden, then Freigeben with what the entry recommends. */
async function connectAndApprove(run: ReturnType<typeof testSource>) {
  typeInto('[data-connection-field="oauth.clientId"]', "client-1");
  typeInto('[data-connection-field="secret"]', CLIENT_SECRET);
  await click("[data-connection-connect]");
  // Saved with its secret; no test, no sign-in yet.
  expect(run.log).toEqual(["assets.put", "connections.set_secret(secret)"]);
  expect(document.querySelector("[data-catalogue-review]")).not.toBeNull();
  expect(element("[data-catalogue-scopes]").getAttribute("data-catalogue-scopes")).toBe(
    "openid email mail.read"
  );
  await click("[data-connection-approve]");
  const approved = required(run.puts[1]);
  expect(approved.operations).toEqual([
    expect.objectContaining({ name: "searchMessages", enabled: true, exposure: ["agent"] }),
    expect.objectContaining({ name: "getMessage", enabled: true, exposure: ["agent"] })
  ]);
  expect(approved.settings).toMatchObject({
    oauth: { clientId: "client-1", scopes: ["openid", "email", "mail.read"] }
  });
  return approved;
}

describe("the install of an OAuth part", () => {
  it("shared: saves, approves with the group's scopes, then signs the shared account in", async () => {
    const run = testSource();
    const tabs = testBrowser();
    const shared = {
      ...mailbox,
      parts: [{ ...part, defaultCredentialMode: "shared" as const }]
    };
    const created = mount(shared, run, tabs.browser);
    await settle();
    expect(document.querySelector("[data-catalogue-shared-note]")).not.toBeNull();

    const approved = await connectAndApprove(run);
    expect(approved).not.toHaveProperty("credentialMode");
    expect(JSON.stringify(run.puts)).not.toContain(CLIENT_SECRET);

    // The sign-in step, started only now, with the approved access.
    await settle();
    expect(element("[data-sign-in-step]").getAttribute("data-sign-in-step")).toBe("ready");
    expect(run.log.filter((call) => call === "connections.oauth_start")).toHaveLength(1);
    // The access was decided by the review just made, not at the instance's setup.
    expect(element("[data-sign-in-scopes]").textContent).toContain(
      "They follow from the tools you just approved."
    );
    await click("[data-sign-in-open]");
    expect(tabs.opened).toEqual([["https://login.example.test/authorize?attempt=1"]]);

    run.state.shared = true;
    tabs.tick();
    await settle();
    // Signed in, with no agent to give the tools to: the Connection's page opens.
    expect(run.log).toContain("connections.test");
    expect(created).toHaveBeenCalledWith("mailbox");
  });

  it("personal: saves for each person, approves, and offers the admin's own account", async () => {
    const run = testSource();
    const tabs = testBrowser();
    const created = mount(mailbox, run, tabs.browser);
    await settle();
    expect(document.querySelector("[data-catalogue-shared-note]")).toBeNull();

    typeInto('[data-connection-field="oauth.clientId"]', "client-1");
    typeInto('[data-connection-field="secret"]', CLIENT_SECRET);
    await click("[data-connection-connect]");
    expect(run.puts[0]).toMatchObject({
      name: "mailbox",
      credentialMode: "user",
      catalogue: { entry: "mailbox", part: "tools", version: 2 },
      operations: []
    });
    await click("[data-connection-approve]");
    expect(run.puts[1]).toMatchObject({ credentialMode: "user" });

    // No shared sign-in: each person connects; the admin may connect now, in one click.
    expect(document.querySelector("[data-sign-in-step]")).toBeNull();
    expect(element("[data-catalogue-personal]").textContent).toContain(
      "Settings > You > Connections"
    );
    await click("[data-catalogue-connect-own]");
    expect(tabs.opened).toEqual([["https://login.example.test/authorize?attempt=1"]]);
    run.state.own = true;
    tabs.tick();
    await settle();
    expect(document.querySelector("[data-catalogue-own-connected]")).not.toBeNull();

    await click("[data-connection-approved-done]");
    expect(created).toHaveBeenCalledWith("mailbox");
  });

  it("personal, without the use right: says so and leads to the use rights, no connect", async () => {
    const run = testSource();
    run.source.mayConnectOwn = async () => false;
    const created = mount(mailbox, run, testBrowser().browser);
    await settle();
    typeInto('[data-connection-field="oauth.clientId"]', "client-1");
    typeInto('[data-connection-field="secret"]', CLIENT_SECRET);
    await click("[data-connection-connect]");
    await click("[data-connection-approve]");

    expect(document.querySelector("[data-catalogue-connect-own]")).toBeNull();
    expect(element("[data-catalogue-own-needs-use]").textContent).toContain(
      "you need the right to use this connection"
    );
    await click("[data-catalogue-own-access]");
    // The Connection's page opens, then its use rights.
    expect(created).toHaveBeenCalledWith("mailbox", expect.any(Function));
    expect(run.log).not.toContain("connections.oauth_start");
  });

  it("installs anew at the address of a deleted connection, writing over its delete", async () => {
    const run = testSource();
    const tabs = testBrowser();
    run.source.deletedRevision = async (name) => (name === "mailbox" ? 7 : undefined);
    mount(mailbox, run, tabs.browser);
    await settle();
    expect(element("[data-catalogue-recreates]").textContent).toContain(
      "A deleted connection had this address"
    );
    await connectAndApprove(run);
    // The first write names the delete; the approval names the revision it made.
    expect(run.bases).toEqual([7, 1]);
  });

  it("flags a further group when one of its tools is ticked, and asks for its access", async () => {
    const run = testSource();
    mount(mailbox, run, testBrowser().browser);
    await settle();
    typeInto('[data-connection-field="oauth.clientId"]', "client-1");
    typeInto('[data-connection-field="secret"]', CLIENT_SECRET);
    await click("[data-connection-connect]");
    expect(document.querySelector("[data-catalogue-widens]")).toBeNull();

    const labels = element('[data-approval-group="organise"] li[data-approval-tool="listLabels"]');
    await act(async () => required(labels.querySelector<HTMLElement>("button")).click());
    await settle();
    expect(element("[data-catalogue-widens]").getAttribute("data-catalogue-widens")).toBe(
      "organise"
    );
    expect(element("[data-catalogue-scopes]").getAttribute("data-catalogue-scopes")).toBe(
      "openid email mail.read mail.modify"
    );
  });
});
