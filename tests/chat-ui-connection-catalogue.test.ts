import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  CatalogueInstall,
  ConnectionCreateFlow,
  afterApprove,
  afterConnect,
  afterSignIn,
  askedGroups,
  catalogueLink,
  catalogueUpdateOf,
  changedSettings,
  entriesToShow,
  managedSettings,
  partCandidates,
  partDefaults,
  partModes,
  partOffer,
  readingNames,
  recommendedNames,
  reviewGroups,
  scopesFor,
  selectedCandidates,
  signsIn,
  typedConnectionConfig,
  typesWithEntries,
  withApprovedOperations,
  withPartScopes,
  type CatalogueEntryOffer,
  type ConnectionSource,
  type ConnectorTypeOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  connectorTypeOffers,
  createCatalogue,
  createHttpApiConnectorType,
  expandCataloguePart,
  loadCatalogueEntries,
  type ManagedOAuthClients
} from "@work-shape/catalyst-connections";
import { AppError, createConnectorTypeRegistry, type JsonValue } from "@work-shape/catalyst-core";
import { z } from "zod";
import { required } from "./support/assertions";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { mailbox, REDIRECT } from "./chat-ui-catalogue-oauth-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The catalogue (CAT-1, CAT-OAUTH-UI, MS-APP-RELINK). An entry only recommends: these tests fail
// where its install would enable an operation, where a changing operation would be ticked in
// advance, where an entry the operator has not named could be chosen, where a sign-in would ask
// for other scopes than the instance writes, or where a managed Connection's guard would pass a
// stale or altered link.

/** The demo entry's shaper, as the release registers one: it only passes the result on. */
const sampleResultShapers = { "sample.customers": (result: JsonValue) => result };
const part = required(mailbox.parts[0]);

const connectionSource: ConnectionSource = {
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
const installProps = {
  checkName: async () => ({ available: true as const }),
  put: async () => ({ revision: 1 }),
  onClose: () => undefined,
  onCreated: () => undefined
};

/** A Connector type with a form of its own, which the entry `files` installs through. */
const folderType: ConnectorTypeOffer = {
  type: "folder_store",
  title: { en: "Folder store", de: "Ordnerablage" },
  description: { en: "Syncs shared folders.", de: "Synchronisiert geteilte Ordner." },
  service: "folder-store",
  documentSource: true,
  operations: [],
  exposures: ["agent", "bridge", "workflow", "outside"],
  authScheme: "client_credentials",
  settings: {},
  fields: [{ label: { en: "Secret", de: "Secret" }, optional: false, secret: true }]
};

const ledger: CatalogueEntryOffer = {
  id: "ledger",
  version: 3,
  service: "ledger",
  title: { en: "Ledger", de: "Hauptbuch" },
  description: { en: "The books of the firm.", de: "Die Bücher der Kanzlei." },
  category: "accounting",
  examplePrompts: [{ en: "Which clients booked in May?", de: "Wer hat im Mai gebucht?" }],
  mark: { color: "#2f6f4f" },
  offered: true,
  parts: [
    {
      part: "tools",
      connectorType: "http_api",
      name: "ledger",
      description: { en: "Agents read the books.", de: "Agenten lesen die Bücher." },
      authScheme: "bearer",
      settings: { testPath: "/health" },
      fields: [
        {
          label: { en: "Address", de: "Adresse" },
          optional: false,
          setting: "baseUrl",
          secret: false,
          default: "https://ledger.example.test/api"
        },
        { label: { en: "Key", de: "Schlüssel" }, optional: false, secret: true }
      ],
      prerequisites: [
        {
          text: { en: "Open port 443 outbound.", de: "Öffne Port 443 nach außen." },
          value: "ledger.example.test:443"
        }
      ],
      hosts: ["ledger.example.test"],
      sharedAccountNote: {
        en: "The key is the firm's, not a person's.",
        de: "Der Schlüssel gehört der Kanzlei, nicht einer Person."
      },
      documentSource: false,
      operations: [
        {
          name: "listClients",
          effect: "reading",
          recommended: true,
          declaration: {
            title: "List clients",
            description: "Lists the clients.",
            method: "GET",
            path: "/clients"
          }
        },
        {
          name: "listPostings",
          effect: "reading",
          recommended: false,
          declaration: { description: "Lists postings.", method: "GET", path: "/postings" }
        },
        // A changing operation an offer marks as recommended, as a forged answer could.
        { name: "bookPosting", effect: "changing", recommended: true, declaration: {} }
      ]
    }
  ]
};

const files: CatalogueEntryOffer = {
  ...ledger,
  id: "files",
  service: "files",
  title: { en: "Files", de: "Dateien" },
  offered: false,
  parts: [
    {
      ...required(ledger.parts[0]),
      part: "source",
      connectorType: "folder_store",
      name: "files",
      documentSource: true,
      operations: []
    }
  ]
};

describe("the catalogue model", () => {
  it("ticks only the reading operations the entry recommends", () => {
    const part = required(ledger.parts[0]);
    const candidates = partCandidates(part);
    expect(candidates.map((candidate) => [candidate.name, candidate.recommended])).toEqual([
      ["listClients", true],
      ["listPostings", false],
      ["bookPosting", false]
    ]);
    expect(recommendedNames(part)).toEqual(["listClients"]);
    expect(readingNames(candidates)).toEqual(["listClients"]);
  });

  it("installs a Connection with no operation, and enables only what the admin approves", () => {
    const part = required(ledger.parts[0]);
    const offer = partOffer(ledger, part);
    const config = {
      ...typedConnectionConfig(
        offer,
        { name: "ledger", title: "Ledger", description: "" },
        { ...partDefaults(part), 1: "a-key-never-written" }
      ),
      catalogue: catalogueLink(ledger, "tools")
    };
    expect(config).toMatchObject({
      service: "ledger",
      connectorType: "http_api",
      settings: { testPath: "/health", baseUrl: "https://ledger.example.test/api" },
      catalogue: { entry: "ledger", part: "tools", version: 3 },
      operations: []
    });
    expect(JSON.stringify(config)).not.toContain("a-key-never-written");
    expect(partDefaults(part)).toEqual({ 0: "https://ledger.example.test/api" });

    const candidates = partCandidates(part);
    const approved = withApprovedOperations(
      config,
      selectedCandidates(candidates, new Set(recommendedNames(part))),
      ["agent"]
    );
    expect(approved.operations).toEqual([
      {
        title: "List clients",
        description: "Lists the clients.",
        method: "GET",
        path: "/clients",
        name: "listClients",
        effect: "reading",
        exposure: ["agent"],
        enabled: true
      }
    ]);
  });

  it("stands in for the type of an offered entry only, offered entries first", () => {
    expect([...typesWithEntries([ledger, files])]).toEqual(["http_api"]);
    expect(entriesToShow([files, ledger]).map((entry) => entry.id)).toEqual(["ledger", "files"]);
    expect(entriesToShow([{ ...ledger, parts: [] }])).toEqual([]);
  });
});

describe("New connection and the install of an entry", () => {
  const source: ConnectionSource = {
    ...connectionSource,
    useConnectorTypes: () => [folderType],
    useCatalogueEntries: () => [files, ledger]
  };
  const dialog = (connections: ConnectionSource, start?: string) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(ConnectionCreateFlow, {
          ...installProps,
          source: connections,
          remove: async () => undefined,
          mayDelete: () => true,
          ...(start ? { start } : {})
        })
      })
    );

  it("lets an entry's card stand in for its type's only once the operator names the entry", () => {
    const markup = dialog(source);
    expect(markup).not.toContain("data-catalogue-entry");
    expect(markup).toContain('data-connection-type="mcp"');
    expect(markup).toContain('data-connection-type="http_api"');
    expect(markup).toContain('data-connection-type="folder_store"');
    const named = dialog({
      ...source,
      useCatalogueEntries: () => [{ ...files, offered: true }, ledger]
    });
    expect(named).not.toContain('data-connection-type="folder_store"');
  });

  it("opens at the install of the entry a service's card names, and never an unnamed entry", () => {
    const markup = dialog(source, "ledger");
    expect(markup).toContain('data-catalogue-intro="ledger"');
    expect(markup).not.toContain("data-connection-type");
    // An entry the operator has not named is never installed, whatever the card asked.
    expect(dialog(source, "files")).not.toContain("data-catalogue-intro");
    expect(dialog(source, "files")).toContain('data-connection-type="mcp"');
  });
});

/** The scopes of a definition's `settings.oauth`. */
const scopesOf = (settings: unknown): string[] =>
  z.object({ oauth: z.object({ scopes: z.array(z.string()) }) }).parse(settings).oauth.scopes;

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
    // The same, by group: what the review names in words.
    expect(askedGroups(part, ["listLabels", "searchMessages"]).map((group) => group.id)).toEqual([
      "identity",
      "read",
      "organise"
    ]);
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
  const render = (entry: CatalogueEntryOffer) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "en",
        children: createElement(CatalogueInstall, {
          ...installProps,
          entry,
          source: connectionSource,
          onBack: () => undefined
        })
      })
    );

  it("names the exact redirect URI, takes the secret typed and unshown, and says whose account only when shared", () => {
    const markup = render(mailbox);
    expect(markup).toContain(`data-catalogue-redirect-uri="${REDIRECT}"`);
    expect(markup).toContain('data-connection-field="oauth.clientId"');
    expect(markup).toMatch(/type="password"[^>]*data-connection-field="secret"/u);
    // Each person reads their own account: no sentence on one shared account.
    expect(markup).not.toContain("data-catalogue-shared-note");
    const shared = render({
      ...mailbox,
      parts: [{ ...part, credentialModes: ["shared", "user"], defaultCredentialMode: "shared" }]
    });
    const note = shared.indexOf("data-catalogue-shared-note");
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(shared.indexOf('data-connection-field="secret"'));
  });

  it("asks for no client id or secret on the operator's managed client", () => {
    const managed = { ...part, managedClient: "mail" };
    const markup = render({ ...mailbox, parts: [managed] });
    expect(markup).not.toContain('data-connection-field="oauth.clientId"');
    expect(markup).not.toContain('data-connection-field="secret"');
    // The managed definition names the client and holds no client id; the own app asks again.
    const offer = partOffer(mailbox, managed, true);
    expect(offer.fields).toEqual([]);
    expect(offer.settings).toMatchObject({ oauth: { managedClient: "mail" } });
    expect(JSON.stringify(offer.settings)).not.toContain("clientId");
    expect(partOffer(mailbox, managed).fields.map((field) => field.setting ?? "secret")).toEqual([
      "oauth.clientId",
      "secret"
    ]);
    // A part the instance has no managed client for keeps its fields, whatever is asked.
    expect(partOffer(mailbox, part, true).fields).toHaveLength(2);
  });
});

const managedClients: ManagedOAuthClients = {
  get: (id) => (id === "sample" ? { id, clientId: "demo-sample-client" } : undefined),
  secret: async () => "unused",
  awaitingSecret: () => false
};

/** The demo's sample entry as a later release ships it: version 2. */
function instance() {
  const shipped = required(
    loadCatalogueEntries(new URL("../clients/demo/catalogue", import.meta.url)).find(
      (candidate) => candidate.id === "sample-oauth"
    )
  );
  const catalogue = createCatalogue({
    entries: [{ ...shipped, version: 2 }],
    named: ["sample-oauth"],
    connectorTypes: createConnectorTypeRegistry([
      createHttpApiConnectorType(sampleResultShapers, managedClients)
    ]),
    resultShapers: sampleResultShapers,
    managedClients
  });
  const entries: CatalogueEntryOffer[] = connectorTypeOffers(
    createConnectorTypeRegistry([]),
    catalogue
  ).entries;
  return { catalogue, entries, part: required(entries[0]?.parts[0]) };
}

/**
 * What the install of version 1 wrote: the part's settings on the managed client before
 * version 2 added the admin-consent address, and the scopes of its enabled operation.
 */
function installedAtVersion1(part: CatalogueEntryOffer["parts"][number]) {
  const settings = managedSettings(part.settings, "sample");
  const { adminConsent: _adminConsent, ...oauth } = z.looseObject({}).parse(settings.oauth);
  return {
    name: "sample-oauth",
    displayName: "OAuth-Beispiel",
    service: "sample-oauth",
    connectorType: "http_api",
    ownerPrincipalId: "user_admin",
    authScheme: "oauth",
    credentialMode: "user",
    catalogue: { entry: "sample-oauth", part: "tools", version: 1 },
    settings: { ...settings, oauth: { ...oauth, scopes: ["sample.identity", "sample.read"] } },
    operations: [
      {
        name: "listCustomers",
        effect: "reading",
        method: "GET",
        path: "/customers",
        exposure: ["agent"],
        enabled: true
      }
    ],
    enabled: true,
    origin: "runtime"
  };
}

const settingsSchema = z.object({
  baseUrl: z.string(),
  oauth: z.looseObject({ tokenUrl: z.string(), scopes: z.array(z.string()) })
});

function refusalReason(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError)
      return z.object({ reason: z.string() }).parse(error.details).reason;
    throw error;
  }
  return undefined;
}

describe("a managed Connection set up from an earlier version of its catalogue entry", () => {
  // The relink's refusals and its write are proven against the instance in
  // connection-managed-oauth-relink.test.ts; these are the guards no server test names.
  it("keeps the guard: a relinked write may name no settings or link that are not the entry's", () => {
    const { catalogue, entries, part } = instance();
    const update = required(catalogueUpdateOf(installedAtVersion1(part), entries));
    expect(update.changed).toEqual(["oauth.adminConsent"]);
    expect(catalogue.managedClientIssue(update.config)).toBeUndefined();
    const settings = settingsSchema.parse(update.config.settings);
    // The current version's link with a token endpoint of the admin's choosing: refused.
    const moved = {
      ...update.config,
      settings: {
        ...settings,
        oauth: { ...settings.oauth, tokenUrl: `${settings.oauth.tokenUrl}/elsewhere` }
      }
    };
    expect(refusalReason(() => catalogue.prepareConnection(moved))).toBe(
      "managed_client_unavailable"
    );
    // A link whose version is not a number is no link to the entry at all.
    const malformed = {
      ...update.config,
      catalogue: { entry: "sample-oauth", part: "tools", version: "2" }
    };
    expect(catalogue.managedClientIssue(malformed)).toMatch(/^managed_client_unavailable: /u);
  });

  it("is offered only where the update is needed and the current part still has the client", () => {
    const { entries, part } = instance();
    const stale = installedAtVersion1(part);
    const entry = required(entries[0]);
    const cases: [string, Record<string, unknown>, readonly CatalogueEntryOffer[]][] = [
      ["release config", { ...stale, origin: "release" }, entries],
      ["current version", { ...stale, catalogue: { ...stale.catalogue, version: 2 } }, entries],
      [
        "own app registration",
        {
          ...stale,
          settings: {
            ...stale.settings,
            oauth: { ...stale.settings.oauth, managedClient: undefined, clientId: "own" }
          }
        },
        entries
      ],
      ["entry not offered", stale, [{ ...entry, offered: false }]],
      [
        "part without the client now",
        stale,
        [{ ...entry, parts: entry.parts.map(({ managedClient: _managed, ...rest }) => rest) }]
      ],
      ["another part", { ...stale, catalogue: { ...stale.catalogue, part: "source" } }, entries],
      ["not signing in", { ...stale, authScheme: "oauth_client" }, entries],
      ["no link", { ...stale, catalogue: undefined }, entries]
    ];
    for (const [why, config, offered] of cases) {
      expect(catalogueUpdateOf(config, offered), why).toBeUndefined();
    }
  });

  it("names the changed settings by path, the scopes aside", () => {
    expect(
      changedSettings(
        { baseUrl: "https://a.test", oauth: { tokenUrl: "https://t.test", scopes: ["a"] } },
        {
          baseUrl: "https://a.test",
          testPath: "/me",
          oauth: { tokenUrl: "https://u.test", scopes: ["a", "b"], adminConsent: { url: "x" } }
        }
      )
    ).toEqual(["oauth.adminConsent", "oauth.tokenUrl", "testPath"]);
    expect(changedSettings({ oauth: { b: 1, a: 2 } }, { oauth: { a: 2, b: 1 } })).toEqual([]);
  });
});
