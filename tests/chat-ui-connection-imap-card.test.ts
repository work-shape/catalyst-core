// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorTypeOffers } from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { createImapConnectorType } from "@work-shape/catalyst-imap-connector";
import {
  ConnectionCreateFlow,
  typedConnectionConfig,
  typedInitialValues,
  type ConnectionSource,
  type ConnectorTypeOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { TranslationProvider } from "./chat-ui-render-harness";

// The card "Postfach (IMAP)" in the New connection dialog, clicked through (MBX-1b): the type's
// own form with the port under "Technische Details", the password only through set_secret,
// the sentence of what everyone who may use it reads, and the approval list with both reading
// operations ticked and agents as the only place they may be used. Fails where the password
// reached a definition, where the card offered Apps or Workflows, or where an operation was
// approved for anything but agents.

const PASSWORD = "mailbox-app-password-never-shown-5";
const SHARED_DE = "Alle, die diese Verbindung nutzen dürfen, lesen jede Mail in diesen Ordnern.";

const imap: ConnectorTypeOffer = required(
  connectorTypeOffers(createConnectorTypeRegistry([createImapConnectorType()])).types[0]
);

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

function testSource() {
  const log: string[] = [];
  const puts: Record<string, unknown>[] = [];
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail("feedback-mailbox"),
    test: async () => {
      log.push("connections.test");
      return { status: "ready", testedAt: "2026-11-10T10:00:00.000Z" };
    },
    setSecret: async (_name, value) => {
      log.push(`connections.set_secret(${value === PASSWORD ? "password" : "?"})`);
    },
    discover: async () => {
      log.push("connections.discover");
    },
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("A mailbox signs nothing in.");
    },
    useConnectorTypes: () => [imap]
  };
  const put = async (input: {
    config: Record<string, unknown>;
    expectedRevision: number | null;
  }) => {
    log.push(`assets.put(${input.expectedRevision ?? "null"})`);
    puts.push(input.config);
    return { revision: puts.length };
  };
  return { source, put, puts, log };
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

describe("the card Postfach (IMAP)", () => {
  it("is the type's form, offered beside an MCP server and a REST API", () => {
    expect(imap).toMatchObject({
      type: "imap",
      title: { en: "Mailbox (IMAP)", de: "Postfach (IMAP)" },
      authScheme: "password",
      exposures: ["agent"],
      operations: [
        { name: "search_messages", effect: "reading" },
        { name: "get_message", effect: "reading" }
      ]
    });
    expect(imap.fields.map((field) => field.setting ?? "secret")).toEqual([
      "host",
      "username",
      "secret",
      "folders",
      "port"
    ]);
    // What the fields start with: one folder and the port of implicit TLS. Never a password.
    expect(typedInitialValues(imap)).toEqual({ 3: "INBOX", 4: "993" });
  });

  it("writes a port as a number and folders as a list, and never the password", () => {
    const config = typedConnectionConfig(
      imap,
      { name: "feedback-mailbox", title: "Feedback mailbox", description: "" },
      {
        0: "imap.example.test",
        1: "feedback@example.test",
        2: PASSWORD,
        3: "INBOX, Feedback\nArchive",
        4: "993"
      }
    );
    expect(config).toMatchObject({
      connectorType: "imap",
      authScheme: "password",
      settings: {
        host: "imap.example.test",
        username: "feedback@example.test",
        folders: ["INBOX", "Feedback", "Archive"],
        port: 993
      },
      operations: []
    });
    expect(JSON.stringify(config)).not.toContain(PASSWORD);
  });

  it("starts with what a proposal named, and the password empty", () => {
    expect(
      typedInitialValues(imap, {
        host: "imap.example.test",
        port: 993,
        username: "feedback@example.test",
        folders: ["INBOX", "Feedback"],
        password: "never-taken"
      })
    ).toEqual({
      0: "imap.example.test",
      1: "feedback@example.test",
      3: "INBOX, Feedback",
      4: "993"
    });
  });

  it("connects, tests and approves both tools for agents only", async () => {
    const run = testSource();
    const created = vi.fn();
    act(() =>
      root.render(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(
            TranslationProvider,
            { locale: "de", children: null },
            createElement(ConnectionCreateFlow, {
              source: run.source,
              checkName: async () => ({ available: true as const }),
              put: run.put,
              remove: async () => undefined,
              mayDelete: () => true,
              onClose: () => undefined,
              onCreated: created
            })
          )
        )
      )
    );
    await settle();
    expect(element('[data-connection-type="imap"]').textContent).toContain("Postfach (IMAP)");
    await click('[data-connection-type="imap"] button');

    // The sentence stands before the password; the port waits under "Technische Details".
    expect(element("[data-connection-shared-note]").textContent).toBe(SHARED_DE);
    expect(document.querySelector('[data-connection-field="port"]')).toBeNull();
    await click("[data-name-with-address-fold]");
    expect(element('[data-connection-field="port"]').getAttribute("value")).toBe("993");
    expect(element('[data-connection-field="secret"]').getAttribute("type")).toBe("password");

    typeInto('[data-name-with-address-field="name"]', "Feedback mailbox");
    typeInto('[data-connection-field="host"]', "imap.example.test");
    typeInto('[data-connection-field="username"]', "feedback@example.test");
    typeInto('[data-connection-field="secret"]', PASSWORD);
    typeInto('[data-connection-field="folders"]', "INBOX, Feedback");
    await click("[data-connection-connect]");

    // Saved, the password set apart, tested; nothing is discovered.
    expect(run.log).toEqual([
      "assets.put(null)",
      "connections.set_secret(password)",
      "connections.test"
    ]);
    expect(run.puts[0]).toMatchObject({
      name: "feedback-mailbox",
      connectorType: "imap",
      settings: {
        host: "imap.example.test",
        username: "feedback@example.test",
        folders: ["INBOX", "Feedback"],
        port: 993
      }
    });

    // Both reading tools ticked; "Nutzen dürfen" offers Agenten and nothing else.
    expect(document.querySelector('[data-connection-typed-review="imap"]')).not.toBeNull();
    expect(
      [...document.querySelectorAll("[data-approval-surface]")].map((node) =>
        node.getAttribute("data-approval-surface")
      )
    ).toEqual(["agent"]);
    expect(element("[data-approval-count]").textContent).toContain("2");
    await click("[data-connection-approve]");
    expect(run.log.at(-1)).toBe("assets.put(1)");
    const approved = required(run.puts[1]);
    expect(approved.operations).toEqual([
      expect.objectContaining({ name: "search_messages", effect: "reading", exposure: ["agent"] }),
      expect.objectContaining({ name: "get_message", effect: "reading", exposure: ["agent"] })
    ]);
    expect(JSON.stringify(run.puts)).not.toContain(PASSWORD);

    // The last step: what everyone who may use it reads, and where they are chosen.
    expect(element("[data-connection-who-uses]").textContent).toContain(SHARED_DE);
    await click("[data-connection-who-uses-open]");
    expect(created).toHaveBeenCalledWith("feedback-mailbox", expect.any(Function));
  });
});
