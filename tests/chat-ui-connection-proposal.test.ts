import {
  connectionDraftForm,
  connectionDraftEntry,
  isConnectionProposal
} from "../packages/chat-ui/src/studio/build-area/connection-draft";
import type { CatalogueEntryOffer } from "@work-shape/catalyst-chat-ui/build-area";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  ConnectionCreateFlow,
  ConnectionDraftCardView,
  connectionReadyMessage,
  openConnectionDraft,
  readConnectionProposal,
  type ConnectionDraft,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The agent's proposal of a new Connection (CHAT-CONN-1): what the card reads of the tool's
// answer, what it shows, the New connection dialog it opens at the form of its type, and the
// message the person's tab sends back once the Connection is ready. Neither the card, the
// dialog nor the message carries a key; the message names no address.

/** A text that stands for a key. Nothing below may repeat it. */
const SECRET = "sk-live-proposal-1a2b3c";
const ADDRESS = "https://brain.example.test/mcp";

const answer = {
  output: {
    connection: {
      connectorType: "mcp",
      name: "brain",
      title: "Brain",
      url: ADDRESS,
      keyHeader: "x-brain-key",
      headerNames: [],
      apiKey: SECRET
    }
  }
};

function proposal(): ConnectionDraft {
  const read = readConnectionProposal(answer);
  if (!read) throw new Error("The answer is a proposal");
  return read;
}

describe("the proposal the card reads", () => {
  it("takes the type, id, name, address and key header's name, and no key", () => {
    const read = proposal();
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(read).toEqual({
      connection: {
        connectorType: "mcp",
        name: "brain",
        title: "Brain",
        baseUrl: ADDRESS,
        keyHeader: "x-brain-key",
        headerNames: []
      },
      operations: []
    });
  });

  it("is no proposal for a refusal or a call still running", () => {
    expect(readConnectionProposal(undefined)).toBeUndefined();
    expect(
      readConnectionProposal({
        status: "failed",
        error: { code: "validation_failed", message: "x" }
      })
    ).toBeUndefined();
  });
});

describe("the proposal's card", () => {
  const render = (locale: "en" | "de", writer: boolean) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConnectionDraftCardView, {
          draft: proposal(),
          ...(writer ? { onOpen: async () => "opened" as const } : {})
        })
      )
    );

  it("names what is connected and where, and says the key is entered in the dialog", () => {
    const en = render("en", true);
    expect(en).toContain('data-connection-proposal="mcp"');
    expect(en).toContain("Connect Brain");
    expect(en).toContain(`MCP server · ${ADDRESS}`);
    expect(en).toContain("Set up connection");
    expect(en).toContain("You enter the key or sign in there.");
    expect(en).not.toContain("data-connection-draft-tool");
    expect(en).not.toContain(SECRET);
    const de = render("de", true);
    expect(de).toContain("Brain verbinden");
    expect(de).toContain("Verbindung einrichten");
  });

  it("has no button for a reader who may write no Connection", () => {
    const en = render("en", false);
    expect(en).not.toContain("data-connection-draft-open");
    expect(en).toContain("Someone who may edit connections connects it.");
  });
});

describe("the card's button", () => {
  it("shows the page of a Connection that exists already, and opens the dialog for a new id", async () => {
    const shown: (string | undefined)[] = [];
    let dialogs = 0;
    const host = (exists: boolean) => ({
      connectorTypeOf: async () => (exists ? "mcp" : undefined),
      showConnection: (name: string | undefined) => shown.push(name),
      requestCreateDialog: () => {
        dialogs += 1;
      }
    });
    expect(await openConnectionDraft(proposal(), host(true))).toBe("exists");
    expect(shown).toEqual(["brain"]);
    expect(dialogs).toBe(0);
    expect(await openConnectionDraft(proposal(), host(false))).toBe("opened");
    expect(shown).toEqual(["brain", undefined]);
    expect(dialogs).toBe(1);
  });
});

describe("the New connection dialog opened from a proposal", () => {
  it("starts at the MCP server's form with the name, address and key header, and writes nothing", async () => {
    const writes: unknown[] = [];
    await openConnectionDraft(proposal(), {
      connectorTypeOf: async () => undefined,
      showConnection: () => undefined,
      requestCreateDialog: () => undefined
    });
    const source: ConnectionSource = {
      mayTest: () => true,
      useDetail: () => ({ status: "loading" }),
      readDetail: async () => connectionDetail(),
      test: async () => ({ status: "ready", testedAt: "2026-10-21T10:00:00.000Z" }),
      setSecret: async () => undefined,
      discover: async () => undefined,
      useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
      useHolders: () => ({ status: "hidden" }),
      principalHref: () => "",
      oauthStart: async () => {
        throw new Error("This test signs nothing in.");
      }
    };
    const markup = renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(ConnectionCreateFlow, {
          source,
          checkName: async () => ({ available: true as const }),
          put: async (input) => {
            writes.push(input);
            return { revision: 1 };
          },
          remove: async () => undefined,
          mayDelete: () => true,
          onClose: () => undefined,
          onCreated: () => undefined
        })
      )
    );
    expect(markup).toContain('data-connection-create-form="mcp"');
    expect(markup).toContain('value="Brain"');
    expect(markup).toContain(`value="${ADDRESS}"`);
    expect(markup).toContain('value="x-brain-key"');
    expect(markup).not.toContain(SECRET);
    expect(writes).toEqual([]);
  });
});

describe("the message the person's tab sends once the Connection is ready", () => {
  const connection = { name: "brain", title: "Brain" };

  it("says what is connected and which tools are approved for what, in the person's language", () => {
    const de = createTranslationContext("de").t;
    expect(
      connectionReadyMessage(
        connection,
        { kind: "approved", tools: ["search", "read_page"], surfaces: ["agent", "workflow"] },
        de
      )
    ).toBe(
      "Brain ist verbunden (brain), 2 Werkzeuge freigegeben für Agenten und Workflows: search, read_page."
    );
    const en = createTranslationContext("en").t;
    expect(
      connectionReadyMessage(
        connection,
        { kind: "approved", tools: ["search"], surfaces: ["agent"] },
        en
      )
    ).toBe("Brain is connected (brain), 1 tool approved for agents: search.");
    expect(connectionReadyMessage(connection, { kind: "none" }, en)).toBe(
      "Brain is connected (brain), no tools approved yet."
    );
    expect(connectionReadyMessage(connection, { kind: "draft" }, de)).toBe(
      "Brain ist verbunden (brain). Entwirf bitte die Werkzeuge."
    );
  });

  it("names at most twenty tools and never the address", () => {
    const en = createTranslationContext("en").t;
    const tools = Array.from({ length: 25 }, (_, index) => `tool_${index}`);
    const message = connectionReadyMessage(
      connection,
      { kind: "approved", tools, surfaces: ["agent", "bridge", "workflow"] },
      en
    );
    expect(message).toContain("25 tools approved for agents, Apps and Workflows");
    expect(message).toContain("tool_19, …");
    expect(message).not.toContain("tool_20");
    expect(message).not.toContain("example.test");
  });
});

describe("complete proposal dialog models", () => {
  it("maps OAuth, personal mode and GET declarations without carrying secret fields", () => {
    const draft = readConnectionProposal({
      output: {
        connection: {
          connectorType: "http_api",
          name: "mail",
          title: "Mail",
          url: "https://api.example.test",
          authScheme: "oauth",
          credentialMode: "user",
          headerNames: [],
          oauth: {
            authorizationUrl: "https://login.example.test/authorize",
            tokenUrl: "https://login.example.test/token",
            revocationUrl: "https://login.example.test/revoke",
            clientId: "public-client",
            scopes: ["mail.read", "openid"],
            clientSecret: SECRET
          }
        },
        operations: [
          {
            name: "list",
            method: "GET",
            path: "/messages",
            effect: "reading",
            description: "Reads messages"
          }
        ]
      }
    });
    if (!draft) throw new Error("Expected proposal");
    expect(draft.connection.credentialMode).toBe("user");
    expect(isConnectionProposal(draft)).toBe(true);
    expect(draft.operations).toHaveLength(1);
    expect(connectionDraftForm(draft)).toMatchObject({
      authScheme: "oauth",
      url: "https://api.example.test",
      oauth: {
        clientId: "public-client",
        scopes: "mail.read openid",
        tokenUrl: "https://login.example.test/token",
        authorizationUrl: "https://login.example.test/authorize",
        revocationUrl: "https://login.example.test/revoke"
      }
    });
    expect(JSON.stringify(draft)).not.toContain(SECRET);
  });
  it("carries an entry's card state and opens Dienste at the requested part without looking up a default Connection id", async () => {
    const draft = readConnectionProposal({
      output: {
        entry: { id: "files", part: "source" },
        state: "needs_setup",
        mayWrite: false,
        bindingState: "not_connected",
        connection: { connectorType: "http_api", name: "files", title: "Files", headerNames: [] }
      }
    });
    if (!draft) throw new Error("Expected entry proposal");
    expect(draft).toMatchObject({
      entry: { id: "files", part: "source" },
      state: "needs_setup",
      mayWrite: false,
      bindingState: "not_connected"
    });
    const part = {
      part: "tools" as const,
      connectorType: "http_api",
      name: "files",
      description: "Files",
      authScheme: "none",
      credentialModes: ["shared" as const],
      defaultCredentialMode: "shared" as const,
      settings: {},
      fields: [],
      prerequisites: [],
      hosts: [],
      operations: [],
      sharedAccountNote: "Shared",
      documentSource: false
    };
    const entry: CatalogueEntryOffer = {
      id: "files",
      version: 1,
      service: "files",
      title: "Files",
      description: "Files",
      category: "files",
      examplePrompts: [],
      mark: {},
      offered: true,
      parts: [part, { ...part, part: "source" }]
    };
    expect(connectionDraftEntry(draft, [entry])?.parts[0]?.part).toBe("source");
    expect(entry.parts[0]?.part).toBe("tools");
    expect(connectionDraftEntry(draft, [{ ...entry, offered: false }])).toBeUndefined();
    let opened = false;
    expect(
      await openConnectionDraft(draft, {
        connectorTypeOf: async () => {
          throw new Error("An entry needs no custom Connection lookup");
        },
        showConnection: () => undefined,
        requestCreateDialog: () => {
          opened = true;
        }
      })
    ).toBe("opened");
    expect(opened).toBe(true);
  });
});
