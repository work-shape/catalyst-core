import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ConnectionCreateForm,
  createsPersonal,
  credentialModeOf,
  emptyConnectionForm,
  isPersonalConfig,
  mayRevoke,
  needsSignIn,
  newConnectionConfig,
  offersCredentialMode,
  ownActions,
  ownSignInOf,
  personalViewOf,
  showsPeople,
  signedInSince,
  type CreateFields
} from "@work-shape/catalyst-chat-ui/build-area";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// Personal connections (CS-9a-UI): how a person's own sign-in reads, which actions the person
// and an administrator are offered, and the choice of whose account in the New connection
// dialog. The instance decides every call; these decide only what is shown.

const CONNECTED_AT = "2026-10-23T09:00:00.000Z";

describe("a person's own sign-in", () => {
  it("reads a revoked sign-in as not connected", () => {
    expect(personalViewOf({ state: "connected" })).toBe("connected");
    expect(personalViewOf({ state: "needs_reconnect" })).toBe("needs_reconnect");
    expect(personalViewOf({ state: "revoked" })).toBe("not_connected");
    expect(personalViewOf({ state: "not_connected" })).toBe("not_connected");
  });

  it("offers Connect, Sign in again and Disconnect by state", () => {
    expect(ownActions({ state: "not_connected" })).toEqual({
      connect: "connect",
      disconnect: false
    });
    expect(ownActions({ state: "revoked" })).toEqual({ connect: "connect", disconnect: false });
    expect(ownActions({ state: "connected" })).toEqual({ disconnect: true });
    expect(ownActions({ state: "needs_reconnect" })).toEqual({
      connect: "reconnect",
      disconnect: true
    });
  });

  it("waits on the reader's own row, and on nothing where there is none", () => {
    const answer = {
      connections: [
        { name: "gmail", title: "Gmail", state: "connected" as const, connectedAt: CONNECTED_AT },
        { name: "outlook", title: "Outlook", state: "not_connected" as const }
      ]
    };
    const gmail = ownSignInOf(answer, "gmail");
    expect(gmail).toEqual({ binding: { state: "connected", connectedAt: CONNECTED_AT } });
    expect(ownSignInOf(answer, "outlook")).toEqual({});
    expect(ownSignInOf(answer, "other")).toEqual({});
    // The sign-in step goes on once the row says connected, and not for the same sign-in again.
    expect(signedInSince(gmail, {})).toBe(true);
    expect(signedInSince(gmail, gmail)).toBe(false);
  });
});

describe("rights and the People section", () => {
  it("shows People only on a personal Connection, to who may change it", () => {
    const personal = { credentialMode: "user" };
    expect(isPersonalConfig(personal)).toBe(true);
    expect(isPersonalConfig({ credentialMode: "shared" })).toBe(false);
    expect(isPersonalConfig({})).toBe(false);
    expect(showsPeople(personal, true)).toBe(true);
    expect(showsPeople(personal, false)).toBe(false);
    expect(showsPeople({ credentialMode: "shared" }, true)).toBe(false);
  });

  it("offers Revoke to a writer while there is a sign-in to end", () => {
    expect(mayRevoke({ state: "connected" }, true)).toBe(true);
    expect(mayRevoke({ state: "needs_reconnect" }, true)).toBe(true);
    expect(mayRevoke({ state: "revoked" }, true)).toBe(false);
    expect(mayRevoke({ state: "connected" }, false)).toBe(false);
  });

  it("never asks for the shared sign-in of a personal Connection", () => {
    const oauth = { registration: "dcr" as const, providerHost: "auth.example.test" };
    expect(needsSignIn(connectionDetail("mail", { oauth }))).toBe(true);
    expect(needsSignIn(connectionDetail("mail", { oauth, sharedCredential: false }))).toBe(false);
  });
});

describe("whose account, in the New connection dialog", () => {
  const fields = (input: Partial<CreateFields> & { connectorType?: "mcp" | "http_api" }) => {
    const { connectorType = "mcp", ...rest } = input;
    return {
      title: "Mail",
      description: "",
      form: { ...emptyConnectionForm(connectorType), url: "https://mail.example.test/mcp" },
      key: "",
      sendAs: "bearer" as const,
      auth: "key" as const,
      credentialMode: "shared" as const,
      ...rest
    } satisfies CreateFields;
  };
  const render = (value: CreateFields, locale: "en" | "de" = "de") =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConnectionCreateForm, {
          fields: value,
          check: { state: "free" },
          errors: {},
          busy: false,
          steps: [],
          onChange: () => undefined
        })
      )
    );

  it("is offered only where a person signs in: an MCP server, or a REST API's sign-in", () => {
    expect(offersCredentialMode("mcp", "key")).toBe(true);
    expect(offersCredentialMode("http_api", "oauth")).toBe(true);
    expect(offersCredentialMode("http_api", "key")).toBe(false);
    expect(offersCredentialMode("http_api", "oauth_client")).toBe(false);
    expect(createsPersonal(fields({ credentialMode: "user" }))).toBe(true);
    expect(
      createsPersonal(fields({ connectorType: "http_api", auth: "key", credentialMode: "user" }))
    ).toBe(false);
  });

  it("starts at Shared, and a personal MCP server takes no key", () => {
    const shared = render(fields({}));
    expect(shared).toContain("Wessen Konto");
    expect(shared).toContain('data-credential-mode="shared"');
    expect(shared).toContain('data-connection-field="secret"');
    const personal = render(fields({ credentialMode: "user" }), "en");
    expect(personal).toContain("Whose account");
    expect(personal).toContain("Each person connects their own account.");
    expect(personal).not.toContain('data-connection-field="secret"');
    // A REST API with a key has no choice to make.
    expect(render(fields({ connectorType: "http_api" }))).not.toContain("Wessen Konto");
  });

  it("writes a personal Connection that signs in with OAuth", () => {
    const personal = newConnectionConfig(
      { name: "mail", title: "Mail", credentialMode: "user" },
      { ...emptyConnectionForm("mcp"), url: "https://mail.example.test/mcp", authScheme: "none" }
    );
    expect(personal).toMatchObject({ credentialMode: "user", authScheme: "oauth" });
    expect(credentialModeOf(personal)).toBe("user");
    const shared = newConnectionConfig(
      { name: "mail", title: "Mail" },
      { ...emptyConnectionForm("mcp"), url: "https://mail.example.test/mcp", authScheme: "none" }
    );
    expect(shared).not.toHaveProperty("credentialMode");
    expect(credentialModeOf(shared)).toBe("shared");
  });
});
