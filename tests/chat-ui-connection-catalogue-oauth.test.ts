import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  CatalogueInstall,
  ConnectionApprovalList,
  afterApprove,
  afterConnect,
  afterSignIn,
  partCandidates,
  partModes,
  reviewGroups,
  scopesFor,
  signsIn,
  withPartScopes,
  type CatalogueEntryOffer,
  type ConnectionSource
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  connectorTypeOffers,
  createCatalogue,
  createHttpApiConnectorType,
  expandCataloguePart,
  loadCatalogueEntries
} from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { NameWithAddress } from "@work-shape/catalyst-ui";
import { sampleResultShapers } from "../clients/demo/src/result-shapers";
import { required } from "./support/assertions";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// A catalogue part that signs in with OAuth (CAT-OAUTH-UI): whose account, the redirect URI in
// the checklist, the order of its steps, and the access a sign-in asks for per ticked group.
// These tests fail where the dialog would show other scopes than the instance writes, where a
// sign-in would come before the approval that sets its scopes, or where a personal part would
// say that one shared account reads for everyone.

/** The scopes of a definition's `settings.oauth`. */
const scopesOf = (settings: unknown): unknown =>
  (settings as { oauth?: { scopes?: unknown } } | undefined)?.oauth?.scopes;

const REDIRECT = "https://chat.example.test/api/v1/connections/mailbox/oauth/callback";

/** A mail entry with an identity group, a recommended reading group and two further ones. */
const mailbox: CatalogueEntryOffer = {
  id: "mailbox",
  version: 2,
  service: "mailbox",
  title: { en: "Mailbox", de: "Postfach" },
  description: { en: "Read your mail.", de: "Deine Post lesen." },
  category: "mail",
  examplePrompts: [{ en: "What came in today?", de: "Was kam heute rein?" }],
  mark: { color: "#7a3b2e" },
  offered: true,
  parts: [
    {
      part: "tools",
      connectorType: "http_api",
      name: "mailbox",
      description: { en: "Agents read mail.", de: "Agenten lesen Post." },
      authScheme: "oauth",
      credentialModes: ["user", "shared"],
      defaultCredentialMode: "user",
      groups: [
        { id: "identity", title: { en: "Identity", de: "Identität" }, scopes: ["openid", "email"] },
        { id: "read", title: { en: "Read", de: "Lesen" }, scopes: ["mail.read"] },
        { id: "organise", title: { en: "Organise", de: "Ordnen" }, scopes: ["mail.modify"] },
        { id: "send", title: { en: "Send", de: "Senden" }, scopes: ["mail.send"] }
      ],
      settings: {
        baseUrl: "https://mail.example.test/v1",
        oauth: {
          authorizationUrl: "https://login.example.test/authorize",
          tokenUrl: "https://login.example.test/token",
          scopes: ["openid", "email"]
        }
      },
      fields: [
        {
          label: { en: "Client ID", de: "Client-ID" },
          optional: false,
          setting: "oauth.clientId",
          secret: false
        },
        { label: { en: "Client secret", de: "Client-Secret" }, optional: false, secret: true }
      ],
      prerequisites: [{ text: { en: "Create a web client.", de: "Leg einen Web-Client an." } }],
      hosts: ["mail.example.test", "login.example.test"],
      redirectUri: REDIRECT,
      sharedAccountNote: {
        en: "Everyone reads the one shared mailbox.",
        de: "Alle lesen das eine gemeinsame Postfach."
      },
      documentSource: false,
      operations: [
        {
          name: "searchMessages",
          group: "read",
          effect: "reading",
          recommended: true,
          declaration: { method: "GET", path: "/messages" }
        },
        {
          name: "getMessage",
          group: "read",
          effect: "reading",
          recommended: true,
          declaration: { method: "GET", path: "/messages/{id}" }
        },
        {
          name: "listLabels",
          group: "organise",
          effect: "reading",
          recommended: false,
          declaration: { method: "GET", path: "/labels" }
        },
        {
          name: "sendMessage",
          group: "send",
          effect: "changing",
          recommended: true,
          declaration: { method: "POST", path: "/send" }
        }
      ]
    }
  ]
};
const part = required(mailbox.parts[0]);

describe("an OAuth part's modes and steps", () => {
  it("starts with the entry's default mode, and allows only what the entry allows", () => {
    expect(partModes(part)).toEqual({ modes: ["user", "shared"], initial: "user" });
    expect(partModes({ credentialModes: ["user"] })).toEqual({ modes: ["user"], initial: "user" });
    // An older offer without modes is shared, as every part was before personal ones.
    expect(partModes({})).toEqual({ modes: ["shared"], initial: "shared" });
    expect(signsIn(part)).toBe(true);
    expect(signsIn({ authScheme: "bearer" })).toBe(false);
  });

  it("reviews before any sign-in, so the first sign-in asks for what was approved", () => {
    // Verbinden saves; nothing signs in before Freigeben has set the scopes.
    expect(afterConnect({ part, mode: "shared" })).toBe("review");
    expect(afterConnect({ part, mode: "user" })).toBe("review");
    // Freigeben: the shared account signs in; a personal part offers the admin's own connect.
    expect(afterApprove({ part, mode: "shared", gives: true })).toBe("sign-in");
    expect(afterApprove({ part, mode: "user", gives: true })).toBe("personal");
    expect(afterApprove({ part, mode: "user", gives: false })).toBe("personal");
    // After the shared sign-in: the give where agents may use the tools, else the page.
    expect(afterSignIn({ gives: true })).toBe("approved");
    expect(afterSignIn({ gives: false })).toBe("done");
    // A part without operations, such as a source, signs in straight after Verbinden.
    const source = { ...part, operations: [] };
    expect(afterConnect({ part: source, mode: "shared" })).toBe("sign-in");
    // A key part keeps CAT-1's steps.
    const keyed = { ...part, authScheme: "bearer" };
    expect(afterConnect({ part: keyed, mode: "shared" })).toBe("review");
    expect(afterApprove({ part: keyed, mode: "shared", gives: true })).toBe("approved");
    expect(afterApprove({ part: keyed, mode: "shared", gives: false })).toBe("done");
    expect(afterConnect({ part: { ...keyed, operations: [] }, mode: "shared" })).toBe("done");
  });
});

describe("the access a sign-in asks for", () => {
  it("asks for identity, plus the groups of the ticked operations, in the part's order", () => {
    expect(scopesFor(part, [])).toEqual(["openid", "email"]);
    expect(scopesFor(part, ["searchMessages", "getMessage"])).toEqual([
      "openid",
      "email",
      "mail.read"
    ]);
    expect(scopesFor(part, ["listLabels", "searchMessages"])).toEqual([
      "openid",
      "email",
      "mail.read",
      "mail.modify"
    ]);
    // An operation the part does not name widens nothing.
    expect(scopesFor(part, ["deleteEverything"])).toEqual(["openid", "email"]);
  });

  it("groups the review, ticks the recommended reading group, and flags a further one", () => {
    const candidates = partCandidates(part);
    const ticked = new Set(["searchMessages", "getMessage"]);
    const groups = reviewGroups(part, candidates, ticked);
    // Identity has no operation, so no rows; the changing send is unticked.
    expect(groups.map((group) => [group.id, group.candidates.map((row) => row.name)])).toEqual([
      ["read", ["searchMessages", "getMessage"]],
      ["organise", ["listLabels"]],
      ["send", ["sendMessage"]]
    ]);
    expect(candidates.find((row) => row.name === "sendMessage")?.recommended).toBe(false);
    expect(groups.map((group) => group.widens)).toEqual([false, false, false]);
    // Ticking a tool of a group the entry does not recommend asks for more access.
    const wider = reviewGroups(part, candidates, new Set([...ticked, "listLabels"]));
    expect(wider.find((group) => group.id === "organise")?.widens).toBe(true);
    expect(wider.find((group) => group.id === "read")?.widens).toBe(false);
  });

  it("puts operations no group names last, under no title", () => {
    const loose = {
      ...part,
      operations: [
        ...part.operations,
        { name: "ping", effect: "reading" as const, recommended: false, declaration: {} }
      ]
    };
    const groups = reviewGroups(loose, partCandidates(loose), new Set());
    expect(groups.at(-1)).toMatchObject({ id: "", title: undefined, widens: false });
    expect(groups.at(-1)?.candidates.map((row) => row.name)).toEqual(["ping"]);
  });

  it("writes the scopes of the enabled operations, as the instance expands them", () => {
    const entry = required(
      loadCatalogueEntries(new URL("../clients/demo/catalogue", import.meta.url)).find(
        (candidate) => candidate.id === "sample-oauth"
      )
    );
    const catalogue = createCatalogue({
      entries: [entry],
      named: ["sample-oauth"],
      connectorTypes: createConnectorTypeRegistry([
        createHttpApiConnectorType(sampleResultShapers)
      ]),
      resultShapers: sampleResultShapers
    });
    const offered = required(
      connectorTypeOffers(
        createConnectorTypeRegistry([]),
        catalogue,
        (name) => `${REDIRECT}#${name}`
      ).entries[0]?.parts[0]
    );
    const view = required(catalogue.entries[0]?.parts[0]);
    for (const enabled of [[], ["listCustomers"]]) {
      const config = {
        settings: { oauth: { clientId: "client", scopes: ["stale"] } },
        operations: enabled.map((name) => ({ name, enabled: true }))
      };
      const written = withPartScopes(config, offered);
      const expanded = expandCataloguePart(view, {
        operations: enabled.map((name) => ({ name })),
        settings: { oauth: { clientId: "client" } }
      });
      expect(written.settings).toEqual({
        oauth: { clientId: "client", scopes: scopesOf(expanded.settings) }
      });
      expect(scopesOf(written.settings)).toEqual(scopesFor(offered, enabled));
    }
    // An operation saved but not enabled asks for nothing.
    expect(
      withPartScopes(
        {
          settings: { oauth: { clientId: "client" } },
          operations: [{ name: "listCustomers", enabled: false }]
        },
        offered
      ).settings
    ).toEqual({ oauth: { clientId: "client", scopes: ["sample.identity"] } });
    // A key part's definition stays as it is.
    const keyed = { settings: { baseUrl: "https://x.example.test" }, operations: [] };
    expect(withPartScopes(keyed, { ...offered, groups: undefined })).toBe(keyed);
  });
});

describe("the OAuth install's first step", () => {
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail(),
    test: async () => ({ status: "ready", testedAt: "2026-10-23T10:00:00.000Z" }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => "",
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    }
  };
  const render = (entry: CatalogueEntryOffer, locale: "de" | "en" = "de") =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale,
        children: createElement(CatalogueInstall, {
          entry,
          source,
          checkName: async () => ({ available: true as const }),
          put: async () => ({ revision: 1 }),
          onClose: () => undefined,
          onCreated: () => undefined,
          onBack: () => undefined
        })
      })
    );

  it("offers both modes with the entry's default, and the exact redirect URI to register", () => {
    const markup = render(mailbox);
    expect(markup).toContain('data-credential-mode="user"');
    expect(markup).toContain("Wessen Konto");
    expect(markup).toContain(`data-catalogue-redirect-uri="${REDIRECT}"`);
    expect(markup).toContain("Trag diese Redirect-URI beim Anbieter ein:");
    // The client id, and the secret that is typed and never shown.
    expect(markup).toContain('data-connection-field="oauth.clientId"');
    expect(markup).toMatch(/type="password"[^>]*data-connection-field="secret"/u);
    // Each person reads their own account: no sentence on one shared account.
    expect(markup).not.toContain("data-catalogue-shared-note");
    expect(markup).not.toContain("Alle lesen das eine gemeinsame Postfach.");
  });

  it("says whose account it is only for a shared install", () => {
    const shared = render({
      ...mailbox,
      parts: [{ ...part, credentialModes: ["shared", "user"], defaultCredentialMode: "shared" }]
    });
    expect(shared).toContain('data-credential-mode="shared"');
    const note = shared.indexOf("data-catalogue-shared-note");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(shared.indexOf('data-connection-field="secret"'));
  });

  it("shows no choice for a part with one mode, and says when the instance names no URI", () => {
    const { redirectUri: _redirectUri, ...unnamed } = part;
    const markup = render({ ...mailbox, parts: [{ ...unnamed, credentialModes: ["user"] }] }, "en");
    expect(markup).not.toContain('data-connection-field="credentialMode"');
    expect(markup).toContain("Each person connects their own account.");
    expect(markup).toContain('data-catalogue-redirect-uri=""');
    expect(markup).toContain("cannot name its redirect URI");
  });
});

describe("a fixed address", () => {
  it("shows the part's name and cannot be typed over", () => {
    const markup = renderToStaticMarkup(
      createElement(NameWithAddress, {
        value: { name: "Mailbox", typedAddress: "mailbox" },
        onChange: () => undefined,
        derive: () => "derived",
        check: { state: "free" },
        nameLabel: "Name",
        addressLabel: "Id",
        advancedLabel: "Details",
        advancedOpen: true,
        addressFixed: true
      })
    );
    expect(markup).toMatch(/<input[^>]*readOnly=""[^>]*data-name-with-address-field="address"/u);
    expect(markup).toContain('value="mailbox"');
  });
});

describe("the grouped review list", () => {
  it("shows each group under its title with its rows", () => {
    const candidates = partCandidates(part);
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(ConnectionApprovalList, {
          candidates,
          choice: { selected: new Set(["searchMessages"]), surfaces: new Set(["agent"] as const) },
          onSelectedChange: () => undefined,
          onSurfacesChange: () => undefined,
          declared: true,
          groups: [
            { id: "read", title: "Read", names: ["searchMessages", "getMessage"] },
            { id: "send", title: "Send", note: "More access", names: ["sendMessage"] }
          ]
        })
      })
    );
    const read = markup.indexOf('data-approval-group="read"');
    const send = markup.indexOf('data-approval-group="send"');
    expect(read).toBeGreaterThan(-1);
    expect(markup.indexOf('data-approval-tool="getMessage"')).toBeGreaterThan(read);
    expect(markup.indexOf('data-approval-tool="getMessage"')).toBeLessThan(send);
    expect(markup.indexOf('data-approval-tool="sendMessage"')).toBeGreaterThan(send);
    expect(markup).toContain("More access");
    // A tool no group names is not shown twice or loose.
    expect(markup).not.toContain('data-approval-tool="listLabels"');
  });
});
