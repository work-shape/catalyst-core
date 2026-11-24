import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { connectorTypeOffers } from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { createImapConnectorType } from "@work-shape/catalyst-imap-connector";
import {
  ConnectionCreateFlow,
  TypedConnectionCreate,
  connectConnection,
  offerText,
  typedComplete,
  typedConnectionConfig,
  typedInitialValues,
  typedSecret,
  type ConnectCalls,
  type ConnectionSource,
  type ConnectorTypeOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import { required } from "./support/assertions";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// A Connector type with a form of its own, such as a document source, in the New connection
// dialog: its card beside an MCP server and a REST API, the fields it declares, the
// definition Verbinden writes and the calls it makes.

const SECRET = "client-secret-of-the-test-123";
const TESTED_AT = "2026-10-21T10:00:00.000Z";

const offer: ConnectorTypeOffer = {
  type: "folder_store",
  title: { en: "Folder store", de: "Ordnerablage" },
  description: { en: "Syncs shared folders.", de: "Synchronisiert geteilte Ordner." },
  service: "folder-store",
  documentSource: true,
  operations: [],
  exposures: ["agent", "bridge", "workflow", "outside"],
  authScheme: "client_credentials",
  settings: { subject: { type: "enterprise" } },
  fields: [
    {
      label: { en: "Client ID", de: "Client-ID" },
      optional: false,
      setting: "clientId",
      secret: false
    },
    {
      label: { en: "Enterprise ID", de: "Enterprise-ID" },
      optional: false,
      setting: "subject.id",
      secret: false
    },
    {
      label: "Test folder",
      help: { en: "Defaults to the root.", de: "Sonst die Wurzel." },
      optional: true,
      setting: "testFolderId",
      secret: false
    },
    { label: { en: "Client secret", de: "Client-Secret" }, optional: false, secret: true }
  ]
};

describe("the definition of a Connection of a type with a form", () => {
  it("puts each value at its dotted path over the fixed settings, and leaves out an empty optional field", () => {
    const values = { 0: " client-1 ", 1: "4242", 2: "", 3: SECRET };
    expect(typedComplete(offer, values)).toBe(true);
    const config = typedConnectionConfig(
      offer,
      { name: "documents", title: "Documents", description: "" },
      values
    );
    expect(config).toEqual({
      name: "documents",
      displayName: "Documents",
      service: "folder-store",
      connectorType: "folder_store",
      authScheme: "client_credentials",
      settings: { clientId: "client-1", subject: { type: "enterprise", id: "4242" } },
      operations: [],
      enabled: true
    });
    // The secret goes through set_secret alone, never into the definition.
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(typedSecret(offer, values)).toBe(SECRET);
    // The offer's fixed settings stay as they were.
    expect(offer.settings).toEqual({ subject: { type: "enterprise" } });
  });

  it("is not complete while a field that is not optional is empty", () => {
    expect(typedComplete(offer, { 0: "client-1", 1: "4242" })).toBe(false);
    expect(typedComplete(offer, { 0: "client-1", 1: " ", 3: SECRET })).toBe(false);
  });

  it("reads a text in the reader's language, else English", () => {
    expect(offerText(offer.title, "de")).toBe("Ordnerablage");
    expect(offerText({ en: "Only English" }, "de")).toBe("Only English");
    expect(offerText("Plain", "en")).toBe("Plain");
  });

  it("is written, its secret sent and tested, and nothing is discovered", async () => {
    const calls: string[] = [];
    const api: ConnectCalls = {
      put: async (_config, expectedRevision) => {
        calls.push(`assets.put(${expectedRevision ?? "null"})`);
        return 1;
      },
      setSecret: async (_value, expectedVersion) => {
        calls.push(`connections.set_secret(${expectedVersion ?? "null"})`);
      },
      readDetail: async () => {
        calls.push("connections.get");
        return connectionDetail("documents");
      },
      test: async () => {
        calls.push("connections.test");
        return { status: "ready", testedAt: TESTED_AT };
      },
      discover: async () => {
        calls.push("connections.discover");
      },
      pause: async () => undefined,
      now: () => 0
    };
    const steps: string[] = [];
    const outcome = await connectConnection(
      api,
      { config: {}, url: "", key: SECRET, discovers: false },
      {},
      (step, state) => steps.push(`${step}:${state}`)
    );
    expect(outcome.status).toBe("connected");
    expect(calls).toEqual(["assets.put(null)", "connections.set_secret(null)", "connections.test"]);
    expect(steps).toEqual(["server:running", "server:done", "key:done"]);

    // A part that signs in after the connect (OAuth) is written and given its client secret;
    // no test runs, as none can pass before the sign-in.
    calls.length = 0;
    steps.length = 0;
    const signsIn = await connectConnection(
      api,
      { config: {}, url: "", key: SECRET, discovers: false, tests: false },
      {},
      (step, state) => steps.push(`${step}:${state}`)
    );
    expect(signsIn.status).toBe("connected");
    expect(calls).toEqual(["assets.put(null)", "connections.set_secret(null)"]);
    expect(steps).toEqual(["server:running", "server:done", "key:done"]);
  });
});

describe("the dialog for a type with a form", () => {
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail(),
    test: async () => ({ status: "ready", testedAt: TESTED_AT }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    },
    useConnectorTypes: () => [offer]
  };
  const props = {
    checkName: async () => ({ available: true as const }),
    put: async () => ({ revision: 1 }),
    onClose: () => undefined,
    onCreated: () => undefined
  };
  const render = (locale: "en" | "de", element: "pick" | "form") =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        element === "pick"
          ? createElement(ConnectionCreateFlow, {
              ...props,
              source,
              remove: async () => undefined,
              mayDelete: () => true
            })
          : createElement(TypedConnectionCreate, {
              ...props,
              source,
              offer,
              onBack: () => undefined
            })
      )
    );

  it("offers the type beside an MCP server and a REST API, and asks for its secret hidden", () => {
    const pick = render("en", "pick");
    expect(pick).toContain('data-connection-type="mcp"');
    expect(pick).toContain('data-connection-type="folder_store"');
    expect(render("en", "form")).toMatch(/type="password"[^>]*data-connection-field="secret"/u);
  });
});

// MBX-1b: the IMAP type's form, for agents alone, never carrying the password.
describe("the Mailbox (IMAP) type", () => {
  const PASSWORD = "mailbox-app-password-never-shown-5";
  const imap = required(
    connectorTypeOffers(createConnectorTypeRegistry([createImapConnectorType()])).types[0]
  );

  it("is offered to agents alone", () => {
    expect(imap).toMatchObject({ type: "imap", authScheme: "password", exposures: ["agent"] });
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
        4: "",
        5: "993"
      }
    );
    expect(config).toMatchObject({
      connectorType: "imap",
      settings: { folders: ["INBOX", "Feedback", "Archive"], port: 993 },
      operations: []
    });
    expect(JSON.stringify(config)).not.toContain(PASSWORD);
  });

  it("starts with what a proposal named, and the password empty", () => {
    expect(typedInitialValues(imap)).toEqual({ 3: "INBOX", 5: "993" });
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
      5: "993"
    });
  });
});
