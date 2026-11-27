import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ConnectionDetail,
  ConnectionOperationDetail,
  LocaleCode
} from "@work-shape/catalyst-api-client";
import {
  DISCOVERY_WAIT_MS,
  connectionConfigToForm,
  countConnectionFormChanges,
  discoveryWaitFrom,
  discoveryWaitsForSignIn,
  credentialOriginKey,
  newConnectionConfig,
  emptyConnectionForm,
  emptyOAuthForm,
  oauthFormComplete,
  personContextHeaderOf,
  waitsForDiscovery,
  withApprovedOperations,
  withConnectionAbout,
  withConnectionForm,
  withOperationEnabled,
  withOperationExposure,
  withReviewedOperation,
  withoutOperation,
  buildAssetKinds,
  BuildAssetKindsProvider,
  CatalogueServices,
  BuildFrame,
  BuildNavigationProvider,
  ConnectionEditor,
  httpOperationDeclaration,
  isEditableKind,
  listedHealth,
  mcpOperationDeclaration,
  OperationDetails,
  PARAMETERS_MAX,
  RAW_MAX_CHARS,
  resolveBuildRights,
  hiddenFromConnectionList,
  myConnectionCards,
  serviceCards,
  serviceFaceOf,
  TEXT_MAX_CHARS,
  VALUES_MAX,
  type BuildAsset,
  type BuildAssetKind,
  type BuildAssetRead,
  type BuildAssetRow,
  type BuildSource,
  type CatalogueEntryOffer,
  type ConnectionDetailRead,
  type ConnectionFormState,
  type ConnectionHoldersRead,
  type ConnectionSource,
  type ConnectionTestRun,
  type ConnectorTypeOffer,
  type MyConnectionCard,
  type OwnServerEntry
} from "@work-shape/catalyst-chat-ui/build-area";
import { SettingsPageProvider } from "@work-shape/catalyst-chat-ui/settings-page-context";
import { platformContext } from "./chat-ui-build-fixtures";
import { buildPageSettings } from "./chat-ui-build-page-harness";
import {
  connectionAsset,
  connectionDetail,
  FIXTURE_SECRET_HANDLE,
  recordedStates,
  testResult
} from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { mailbox } from "./chat-ui-catalogue-oauth-fixtures";
import { connectorTypeOffers } from "@work-shape/catalyst-connections";
import { required } from "./support/assertions";
import { createTranslationContext } from "./support/chat-ui/shared";
import { createConnectorTypeRegistry } from "@work-shape/catalyst-core";
import { createImapConnectorType } from "@work-shape/catalyst-imap-connector";

// The Connection page against the answers of the contract, handed in where the instance's
// answers will stand. Every test here fails without the page: before it, the address of a
// Connection showed the list.

const connectionKind = buildAssetKinds.find((kind) => kind.kind === "connection");
if (!connectionKind || connectionKind.Editor === undefined) {
  throw new Error("The platform registry has no connection entry with an editor.");
}
const editableConnections: BuildAssetKind = connectionKind;

const noop = () => undefined;
/** The revocation address a later version of the mailbox entry names. */
const REVOKE = "https://login.example.test/revoke";

interface PageInput {
  asset?: BuildAsset;
  /** What reading the asset answers, where it is not the asset. */
  assetRead?: BuildAssetRead;
  detail?: Partial<ConnectionDetail>;
  detailRead?: ConnectionDetailRead;
  run?: ConnectionTestRun;
  mayTest?: boolean;
  /** Whether the reader may change the Connection. Yes unless it says no. */
  canWrite?: boolean;
  /** Who was given the Connection. Without it the reader is not shown rights. */
  holders?: ConnectionHoldersRead;
  locale?: LocaleCode;
  /** Whether the page is handed the person context mappings. Yes unless it says no. */
  personContext?: boolean;
  /** Who the person context chooser lists. Two people unless it says otherwise. */
  subjects?: ReturnType<NonNullable<ConnectionSource["personContext"]>["useSubjects"]>;
  /** The catalogue's entries as the instance offers them. None unless it says so. */
  entries?: CatalogueEntryOffer[];
  /** The settings page's context, which the reader's own sign-in of a personal one reads. */
  settings?: boolean;
  /** The source writes the test credential. Yes unless it says no. */
  testCredentialWrites?: boolean;
  /** The Connector types with a form of their own the instance offers. None unless it says so. */
  types?: ConnectorTypeOffer[];
}

/** The page at the Connection's address, inside the frame, with fixed answers. */
function renderPage(input: PageInput = {}): string {
  const asset = input.asset ?? connectionAsset();
  const connections: ConnectionSource = {
    mayTest: () => input.mayTest ?? true,
    useDetail: (name) =>
      input.detailRead ?? { status: "ready", detail: connectionDetail(name, input.detail) },
    useTest: () => ({ run: input.run ?? { status: "idle" }, start: noop }),
    useHolders: () => input.holders ?? { status: "hidden" },
    useCatalogueEntries: () => input.entries ?? [],
    useConnectorTypes: () => input.types ?? [],
    setSecret: async () => undefined,
    ...(input.testCredentialWrites === false
      ? {}
      : { setTestCredential: async () => undefined, removeTestCredential: async () => undefined }),
    discover: async () => undefined,
    readDetail: async (name) => connectionDetail(name, input.detail),
    test: async () => testResult("ready"),
    principalHref: (principalId) => `/settings/instance/api-access?principal=${principalId}`,
    oauthStart: async () => {
      throw new Error("This test signs nothing in.");
    },
    ...(input.personContext === false
      ? {}
      : {
          personContext: {
            useSubjects: () =>
              input.subjects ?? {
                status: "ready",
                subjects: [
                  { id: "user_1", label: "Ada Lovelace", description: "ada@example.test" },
                  { id: "user_2", label: "Grace Hopper", description: "grace@example.test" }
                ]
              },
            useMapping: () => ({ status: "loading" }),
            setMapping: async () => undefined
          }
        })
  };
  const context = platformContext();
  const source: BuildSource = {
    kinds: [
      { kind: "agent", canCreate: false, canDelete: false },
      { kind: "connection", canCreate: true, canDelete: true }
    ],
    rights:
      input.canWrite === false
        ? { ...resolveBuildRights({ permissions: [] }, context), may: () => false }
        : resolveBuildRights({ permissions: ["config_assets.write"] }, context),
    loading: false,
    error: undefined,
    reload: async () => undefined,
    useList: () => ({
      rows: [],
      error: undefined,
      hasMore: false,
      loadingMore: false,
      loadMore: noop,
      retry: noop
    }),
    useAsset: () =>
      input.assetRead ?? {
        status: "ready",
        asset,
        loadedAt: 1,
        reload: async () => "loaded"
      },
    exists: async () => true,
    checkName: async () => ({ available: true }),
    writes: {
      put: async () => ({ revision: 1 }),
      readFiles: async () => [],
      delete: async () => undefined,
      publish: async () => ({ draftRevision: 1, publishedRevision: 1 }),
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const viewed: BuildAssetKind = {
    ...editableConnections,
    Editor: (frame) => createElement(ConnectionEditor, { frame, source: connections })
  };
  const kinds = buildAssetKinds.map((kind) => (kind.kind === "connection" ? viewed : kind));
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale ?? "en" },
      createElement(
        BuildAssetKindsProvider,
        { value: kinds },
        createElement(
          BuildNavigationProvider,
          {
            value: {
              location: { kindPath: "connections", name: asset.name },
              open: noop,
              href: (place) => `/build/${place.kindPath ?? ""}/${place.name ?? ""}`
            }
          },
          input.settings === true
            ? createElement(
                QueryClientProvider,
                { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
                createElement(SettingsPageProvider, {
                  value: buildPageSettings(async () => new Response(null, { status: 404 })),
                  children: createElement(BuildFrame, { source })
                })
              )
            : createElement(BuildFrame, { source })
        )
      )
    )
  );
}

/** The health the Status section names, by the marker of its sentence. */
function healthOf(markup: string): string | undefined {
  return /data-connection-health="([a-z_]+)"/u.exec(markup)?.[1];
}

describe("Connection page", () => {
  it("offers nothing to edit on a release Connection, and its writes on one made on the instance", () => {
    const release = renderPage();
    expect(release).toContain(">Sample business</h1>");
    for (const control of ["<input", "<textarea", "Save", ">Edit<", ">Accept<"]) {
      expect(release, control).not.toContain(control);
    }
    expect(release).not.toContain("data-connection-outside");
    expect(release).not.toContain("data-connection-exposure");
    expect(renderPage({ asset: connectionAsset("ledger", { origin: "runtime" }) })).not.toContain(
      "data-build-read-only"
    );
  });

  it("shows of the credential only whether it is there, never its handle", () => {
    const markup = renderPage();
    expect(markup).toContain('data-connection-credential="set"');
    expect(markup).toContain("Set, version 2");
    // A reader who may not change the Connection is told that it is set, not its version.
    expect(renderPage({ mayTest: false })).not.toContain("version 2");
    expect(markup).not.toContain(FIXTURE_SECRET_HANDLE);
    expect(markup).not.toContain("secret_");
    expect(markup).not.toContain("secretHandle");
    expect(renderPage({ detail: recordedStates.notConfigured })).toContain(
      'data-connection-credential="not_set"'
    );
    expect(renderPage({ detail: recordedStates.secretUnreadable })).toContain(
      'data-connection-credential="unreadable"'
    );
    // A Connection that sends no credential has none to set, and no account anybody shares.
    const open = renderPage({ asset: connectionAsset("open-data", { authScheme: "none" }) });
    expect(open).toContain('data-connection-credential="none_needed"');
    expect(open).not.toContain("data-connection-shared");
    expect(markup).toContain("data-connection-shared");
    expect(renderPage({ detail: { sharedCredential: false } })).not.toContain(
      "data-connection-shared"
    );
  });

  // DT-3: the test credential of a shared Connection, never its value.
  it("shows the test credential's state and offers its writes to a writer only", () => {
    const set = renderPage({
      detail: {
        testCredential: {
          state: "set",
          version: 3,
          account: "Sandbox tenant",
          endpoint: "https://sandbox.example.test/mcp",
          setAt: "2026-10-20T09:00:00.000Z",
          takesEndpoint: true
        }
      }
    });
    expect(set).toContain('data-test-credential-state="set"');
    expect(set).toContain("Sandbox tenant");
    expect(set).toContain(">Remove test credential<");
    expect(
      renderPage({ detail: { testCredential: { state: "not_set", takesEndpoint: true } } })
    ).not.toContain(">Remove test credential<");
    const stale = renderPage({
      detail: { testCredential: { state: "stale", version: 1, takesEndpoint: true } }
    });
    expect(stale).toContain("data-test-credential-stale");
    const readOnly = renderPage({
      mayTest: false,
      detail: { testCredential: { state: "set", version: 1, takesEndpoint: true } }
    });
    expect(readOnly).toContain('data-test-credential-state="set"');
    expect(readOnly).not.toContain("data-test-credential-open");
    expect(renderPage()).not.toContain("data-connection-test-credential");
  });

  it("maps each recorded state, and the answer of a test, to its health", () => {
    const states: [keyof typeof recordedStates, string][] = [
      ["neverTested", "never_tested"],
      ["ready", "ready"],
      ["unauthorized", "unauthorized"],
      ["networkDenied", "network_denied"],
      ["unavailable", "unavailable"],
      ["notConfigured", "not_configured"],
      ["secretUnreadable", "secret_unreadable"],
      ["failedUnnamed", "failed"]
    ];
    for (const [state, view] of states) {
      expect(healthOf(renderPage({ detail: recordedStates[state] })), state).toBe(view);
    }
    // Where the instance has no reason of its own it records the answer of the type's test.
    expect(
      healthOf(renderPage({ detail: { health: "failed", lastErrorCode: "network_denied" } }))
    ).toBe("network_denied");

    expect(healthOf(renderPage({ detail: recordedStates.ready, run: { status: "running" } }))).toBe(
      "testing"
    );
    // A test that fails after an earlier success says what it found now.
    expect(
      healthOf(
        renderPage({
          detail: recordedStates.ready,
          run: { status: "done", result: testResult("network_denied") }
        })
      )
    ).toBe("network_denied");
    // A failed test does not hide a missing or unreadable credential.
    expect(
      healthOf(
        renderPage({
          detail: recordedStates.notConfigured,
          run: { status: "done", result: testResult("unauthorized") }
        })
      )
    ).toBe("not_configured");
    expect(
      healthOf(
        renderPage({
          detail: recordedStates.secretUnreadable,
          run: { status: "done", result: testResult("unauthorized") }
        })
      )
    ).toBe("secret_unreadable");
  });

  it("says in the head what the last test or call found, not only that the Connection is on (ACCEPT-FIX-7 C5)", () => {
    const head = (markup: string) => /data-connection-head-health="([a-z_]+)"/u.exec(markup)?.[1];
    expect(head(renderPage({ detail: recordedStates.unauthorized }))).toBe("unauthorized");
    expect(head(renderPage({ detail: recordedStates.ready }))).toBe("ready");
    expect(renderPage({ detail: recordedStates.unauthorized })).not.toContain(">Enabled<");
    const off = renderPage({ asset: connectionAsset("ledger", { enabled: false }) });
    expect(head(off)).toBeUndefined();
    expect(off).toContain("Disabled");
  });

  it("says nothing in the head of an enabled Connection until its health is read (ACCEPT-FIX-7 C5)", () => {
    const pending: ConnectionDetailRead[] = [
      { status: "loading" },
      { status: "failed", message: undefined, retry: noop }
    ];
    for (const detailRead of pending) {
      const markup = renderPage({ detailRead });
      expect(markup).not.toContain(">Enabled<");
      expect(markup).not.toContain("data-connection-head-health");
      expect(markup).not.toContain("bg-success-soft");
    }
    expect(
      renderPage({
        asset: connectionAsset("ledger", { enabled: false }),
        detailRead: { status: "loading" }
      })
    ).toContain("Disabled");
  });

  it("tells a writer of a Connection that sends no key to set how it is sent, not to enter one (ACCEPT-FIX-7 C6)", () => {
    const asset = connectionAsset("ledger", { origin: "runtime", authScheme: "none" });
    const markup = renderPage({ asset, detail: recordedStates.unauthorized });
    expect(healthOf(markup)).toBe("unauthorized");
    expect(markup).toContain("set how the key is sent");
    expect(markup).not.toContain("Enter a new key under Credential.");
    expect(markup).not.toContain("refused the credential");
    const withKey = renderPage({
      asset: connectionAsset("ledger", { origin: "runtime" }),
      detail: recordedStates.unauthorized
    });
    expect(withKey).toContain("Enter a new key under Credential.");
  });

  it("offers the test to whoever may run it and shows the instance's refusal", () => {
    expect(renderPage()).toContain(">Test connection</button>");
    const readOnly = renderPage({ mayTest: false, detail: recordedStates.ready });
    expect(readOnly).not.toContain("Test connection");
    expect(readOnly).toContain("data-connection-test-not-allowed");
    // The reader still sees the recorded state.
    expect(healthOf(readOnly)).toBe("ready");
    expect(renderPage({ run: { status: "failed", message: "Too many requests." } })).toContain(
      "Too many requests."
    );
  });

  it("shows the shared OAuth sign-in's state and offers it to a writer only", () => {
    const oauthAsset = connectionAsset("files", {
      origin: "runtime",
      authScheme: "oauth",
      secretHandle: undefined,
      settings: { url: "https://files.example.test/mcp", oauth: { clientId: "catalyst-files" } }
    });
    const oauth = {
      registration: "preregistered" as const,
      providerHost: "auth.files.example.test",
      redirectUri: "https://chat.example.com/api/v1/connections/oauth/callback"
    };
    const unsigned = renderPage({
      asset: oauthAsset,
      detail: { health: "needs_configuration", secret: { state: "not_set" }, oauth }
    });
    expect(unsigned).toContain('data-sign-in-state="none"');
    expect(unsigned).toContain('data-sign-in-begin=""');
    expect(unsigned).not.toContain("data-connection-shared");

    const binding = {
      state: "connected" as const,
      account: "team@files.example.test",
      scopes: ["files.read"],
      connectedAt: "2026-10-17T09:00:00.000Z"
    };
    const signedIn = renderPage({ asset: oauthAsset, detail: { health: "ok", oauth, binding } });
    expect(signedIn).toContain('data-sign-in-state="connected"');
    expect(signedIn).toContain("team@files.example.test");
    expect(signedIn).not.toContain("data-connection-failing");
    const failing = renderPage({
      asset: oauthAsset,
      detail: { health: "failed", lastErrorCode: "upstream_unauthorized", oauth, binding }
    });
    expect(failing).toContain('data-connection-failing="unauthorized"');

    const member = renderPage({
      asset: oauthAsset,
      detail: { health: "needs_configuration", oauth },
      canWrite: false,
      mayTest: false
    });
    expect(member).toContain("data-connection-sign-in");
    expect(member).not.toContain("data-sign-in-begin");
    expect(renderPage()).not.toContain("data-connection-sign-in");
  });

  it("lists the operations by name, never the tool id, with what is not ready", () => {
    const markup = renderPage();
    const row = (name: string) => {
      const start = markup.indexOf(`data-connection-operation="${name}"`);
      expect(start, name).toBeGreaterThan(-1);
      return markup.slice(start, markup.indexOf("</li>", start));
    };
    expect(row("revenue_by_month")).toContain(">Revenue by month<");
    expect(row("revenue_by_month")).not.toContain("connection.sample-business.revenue_by_month");
    expect(row("list_customers")).toContain("Awaiting discovery");
    expect(row("update_customer")).toContain("Needs review");
    expect(row("update_customer")).toContain(">sha256:9f2c41d07a<");
    expect(row("delete_order")).toContain("Disabled");
  });

  it("keeps the definition when the state cannot be read, and shows nothing unread as empty", () => {
    const failed = renderPage({
      detailRead: { status: "failed", message: "The instance is busy.", retry: noop }
    });
    expect(failed).toContain("The instance is busy.");
    expect(failed).toContain("https://sample-business.example.test/mcp");
    expect(healthOf(failed)).toBeUndefined();
    expect(failed).not.toContain("Test connection");
    expect(failed).not.toContain("Agents may not do anything with this connection yet.");
    expect(healthOf(renderPage({ detailRead: { status: "loading" } }))).toBeUndefined();
    expect(renderPage({ assetRead: { status: "missing" } })).toContain(
      "There is no connection with the id sample-business."
    );
    expect(renderPage({ assetRead: { status: "refused" } })).toContain(
      "You may not read this asset."
    );
  });

  describe("who may use it", () => {
    it("has no section for a reader the instance refuses it", () => {
      expect(renderPage()).not.toContain('id="access"');
    });

    // CONN-WHO-1: the roles first, then each holder of a right of its own.
    it("lists the roles first, then people and service principals", () => {
      const holders: ConnectionHoldersRead = {
        status: "ready",
        access: {
          roles: [
            { id: "admin", name: "admin", builtIn: true, verbs: ["read", "use", "write"] },
            { id: "role_bookkeeping", name: "Bookkeeping", builtIn: false, verbs: ["use"] }
          ],
          holders: [
            { kind: "user", id: "user_kai", title: "Kai Example", verbs: ["read", "use"] },
            {
              kind: "service_principal",
              id: "spn_1",
              title: "Monthly check",
              disabled: true,
              verbs: ["use"]
            }
          ],
          holdersShown: true
        }
      };
      const markup = renderPage({ holders });
      const kinds = [...markup.matchAll(/data-holder-kind="([a-z_]+)"/gu)].map((match) => match[1]);
      expect(kinds).toEqual(["role", "role", "person", "service_principal"]);
      expect(markup).toContain('href="/settings/instance/api-access?principal=spn_1"');
      expect(markup).not.toContain("data-holders-not-shown");
    });

    // A reader who manages no users is told the built-in roles, and that the rest is not shown.
    it("names only the built-in roles to a reader who manages no users", () => {
      const markup = renderPage({
        holders: {
          status: "ready",
          access: {
            roles: [{ id: "admin", name: "admin", builtIn: true, verbs: ["read", "use"] }],
            holders: [],
            holdersShown: false
          }
        }
      });
      const kinds = [...markup.matchAll(/data-holder-kind="([a-z_]+)"/gu)].map((match) => match[1]);
      expect(kinds).toEqual(["role"]);
      expect(markup).toContain("data-holders-not-shown");
      expect(markup).not.toContain("No role and nobody has a right on this Connection.");
    });
  });

  it("shows the whole new description of an operation whose description is accepted again", () => {
    const markup = renderPage({
      asset: connectionAsset("ledger", { origin: "runtime" }),
      detail: {
        operations: [
          {
            name: "update_customer",
            toolName: "connection.ledger.update_customer",
            effect: "changing",
            exposure: ["agent"],
            enabled: true,
            status: "needs_review",
            description: "Changes one customer.\nTwo.\nThree.\nThe fourth line.",
            discoveredFingerprint: "b".repeat(64)
          }
        ]
      }
    });
    const row =
      /<li[^>]*data-connection-operation="update_customer".*?<\/li>/su.exec(markup)?.[0] ?? "";
    expect(row).toMatch(
      /<p class="(?![^"]*line-clamp)[^"]*">Changes one customer\.[^<]*The fourth line\.</u
    );
  });

  it("lets a writer approve discovered tools, the changing ones unticked, and a reader nothing", () => {
    const runtime = connectionAsset("ledger", { origin: "runtime" });
    const detail: Partial<ConnectionDetail> = {
      health: "needs_configuration",
      secret: { state: "not_set" },
      discovered: [
        {
          name: "list_invoices",
          description: "Lists the invoices of one customer.\nTwo.\nThree.\nThe fourth line.",
          proposedEffect: "reading",
          fingerprint: "a".repeat(64)
        },
        {
          name: "void_invoice",
          description: "Voids one invoice.",
          proposedEffect: "changing",
          fingerprint: "b".repeat(64)
        }
      ]
    };
    const markup = renderPage({ asset: runtime, detail });
    expect(markup).toContain(">Edit<");
    expect(markup).toContain(">Enter the key<");
    const row = (name: string) =>
      new RegExp(`data-approval-tool="${name}"[\\s\\S]*?</li>`, "u").exec(markup)?.[0] ?? "";
    expect(row("list_invoices")).toContain('aria-checked="true"');
    expect(row("void_invoice")).toContain('aria-checked="false"');
    const surface = (name: string) =>
      new RegExp(`<button[^>]*data-approval-surface="${name}"[^>]*>`, "u").exec(markup)?.[0] ?? "";
    expect(surface("agent")).toContain('aria-checked="true"');
    expect(surface("workflow")).toContain('aria-checked="false"');
    // Whoever approves it reads all of what the model will read, not three lines of it.
    expect(markup).toMatch(
      /<span class="(?![^"]*line-clamp)[^"]*">Lists the invoices[^<]*The fourth line\.</u
    );
    expect(markup).toContain('data-connection-remove="revenue_by_month"');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain(FIXTURE_SECRET_HANDLE);

    const reader = renderPage({ asset: runtime, detail, canWrite: false });
    for (const control of [
      ">Edit<",
      ">Enter the key<",
      "data-connection-approve",
      "data-connection-remove"
    ]) {
      expect(reader, control).not.toContain(control);
    }
  });

  it("offers a managed Connection set up from an earlier entry version the update, to whoever may change it (MS-APP-RELINK)", () => {
    const entry: CatalogueEntryOffer = {
      ...mailbox,
      parts: mailbox.parts.map((part) => ({
        ...part,
        managedClient: "workshape",
        settings: {
          ...part.settings,
          oauth: { ...z.looseObject({}).parse(part.settings.oauth), revocationUrl: REVOKE }
        }
      }))
    };
    const stale = connectionAsset("mailbox", {
      origin: "runtime",
      connectorType: "http_api",
      authScheme: "oauth",
      credentialMode: "user",
      catalogue: { entry: "mailbox", part: "tools", version: 1 },
      settings: {
        baseUrl: "https://mail.example.test/v1",
        oauth: {
          authorizationUrl: "https://login.example.test/authorize",
          tokenUrl: "https://login.example.test/token",
          scopes: ["openid", "email"],
          managedClient: "workshape"
        }
      }
    });
    expect(renderPage({ asset: stale, entries: [entry] })).toContain(
      "data-connection-catalogue-update-apply"
    );
    expect(renderPage({ asset: stale, entries: [entry], canWrite: false })).not.toContain(
      "data-connection-catalogue-update"
    );
    const current = connectionAsset("mailbox", {
      ...stale.config,
      catalogue: { entry: "mailbox", part: "tools", version: 2 }
    });
    expect(renderPage({ asset: current, entries: [entry] })).not.toContain(
      "data-connection-catalogue-update"
    );
  });

  it("says of a personal Connection that each person connects, not that a key is missing", () => {
    const personal = connectionAsset("mailbox", {
      origin: "runtime",
      connectorType: "http_api",
      authScheme: "oauth",
      credentialMode: "user",
      secretHandle: undefined,
      settings: {
        baseUrl: "https://mail.example.test/v1",
        oauth: {
          authorizationUrl: "https://login.example.test/authorize",
          tokenUrl: "https://login.example.test/token",
          managedClient: "workshape"
        }
      }
    });
    const detail = {
      health: "needs_configuration" as const,
      secret: { state: "not_set" as const },
      sharedCredential: false,
      oauth: { registration: "managed" as const, providerHost: "login.example.test" }
    };
    const managed = renderPage({ asset: personal, detail, settings: true });
    expect(managed).toContain('data-connection-health="personal"');
    expect(managed).not.toContain("Enter the key under Credential");
    // Nor a shared sign-in nobody is meant to make.
    expect(managed).not.toContain('data-sign-in-state="none"');
    expect(managed).not.toContain("data-admin-consent-url");
    const consent = renderPage({
      asset: personal,
      detail: {
        ...detail,
        oauth: { ...detail.oauth, adminConsentUrl: "https://login.example.test/adminconsent" }
      },
      settings: true
    });
    expect(consent).toContain("data-admin-consent-url");
  });

  it("adds a REST API's tools by pasting them, for a writer, never by discovery", () => {
    const rest = connectionAsset("exampledata", {
      origin: "runtime",
      connectorType: "http_api",
      settings: { baseUrl: "https://gateway.example.test/datevconnect" }
    });
    const markup = renderPage({ asset: rest, detail: { operations: [] } });
    expect(markup).toContain("data-connection-paste");
    // Without a chat beside the page there is nothing to draft in.
    expect(markup).not.toContain("data-connection-draft");
    expect(markup).not.toContain("Discovered tools");
    expect(renderPage({ asset: rest, canWrite: false })).not.toContain("data-connection-paste");
  });

  it("offers a mailbox's operations to agents alone, and lists those its type declares that wait for approval (MBX-1b)", () => {
    const imap = connectorTypeOffers(
      createConnectorTypeRegistry([createImapConnectorType()])
    ).types;
    const asset = connectionAsset("feedback-mailbox", {
      origin: "runtime",
      connectorType: "imap",
      authScheme: "password",
      settings: {
        host: "imap.example.test",
        port: 993,
        username: "f@example.test",
        folders: ["INBOX"]
      },
      operations: [
        { name: "search_messages", effect: "reading", exposure: ["agent"], enabled: true }
      ]
    });
    const detail = {
      operations: [
        {
          name: "search_messages",
          toolName: "connection.feedback-mailbox.search_messages",
          effect: "reading" as const,
          exposure: ["agent" as const],
          enabled: true,
          status: "ready" as const,
          description: "Search one folder of the mailbox."
        }
      ]
    };
    const markup = renderPage({ asset, detail, types: imap });
    expect(markup).toContain('data-connection-exposure="agent:search_messages"');
    for (const surface of ["bridge", "workflow", "outside"]) {
      expect(markup, surface).not.toContain(
        `data-connection-exposure="${surface}:search_messages"`
      );
    }
    expect(markup).toContain('data-approval-tool="get_message"');
    expect(markup).not.toContain('data-approval-tool="search_messages"');
    expect(
      [...markup.matchAll(/data-approval-surface="([a-z]+)"/gu)].map((match) => match[1])
    ).toEqual(["agent"]);
    const all = connectionAsset("feedback-mailbox", {
      ...asset.config,
      operations: [
        { name: "list_folders", effect: "reading", exposure: ["agent"], enabled: true },
        { name: "search_messages", effect: "reading", exposure: ["agent"], enabled: true },
        { name: "get_message", effect: "reading", exposure: ["agent"], enabled: true },
        { name: "create_draft", effect: "changing", exposure: ["agent"], enabled: true }
      ]
    });
    expect(renderPage({ asset: all, detail, types: imap })).not.toContain(
      "data-connection-type-tools"
    );
  });

  it("ticks each operation's exposure as it names it, outside clients never by default", () => {
    const runtime = connectionAsset("ledger", { origin: "runtime" });
    const markup = renderPage({ asset: runtime });
    const box = (attribute: string, value: string) =>
      new RegExp(`<button[^>]*${attribute}="${value}"[^>]*>`, "u").exec(markup)?.[0] ?? "";
    expect(box("data-connection-outside", "list_customers")).toContain('aria-checked="true"');
    for (const name of ["revenue_by_month", "update_customer", "top_products", "delete_order"]) {
      expect(box("data-connection-outside", name), name).toContain('aria-checked="false"');
    }
    expect(box("data-connection-exposure", "bridge:list_customers")).toContain(
      'aria-checked="true"'
    );
    expect(box("data-connection-exposure", "bridge:revenue_by_month")).toContain(
      'aria-checked="false"'
    );
    expect(renderPage({ asset: runtime, canWrite: false })).not.toContain(
      "data-connection-outside"
    );
  });

  describe("person context", () => {
    const mapped = (settings: Record<string, unknown>, origin = "runtime") =>
      connectionAsset("records", {
        origin,
        connectorType: "http_api",
        authScheme: "none",
        settings: { baseUrl: "https://records.example.test/api", ...settings }
      });

    it("offers a writer the mappings of a REST API that sends the header, a person chosen by name", () => {
      const markup = renderPage({ asset: mapped({ personContextHeader: "X-Person-Ref" }) });
      expect(markup).toContain('id="person-context"');
      expect(markup).toContain('data-connection-field="personContextSubject"');
      expect(markup).not.toContain('data-connection-field="personContextSubjectId"');
      // Nothing is read before an admin names a subject.
      expect(markup).not.toContain("data-person-context-mapping");
      // The mappings are instance data, so a release Connection has them too.
      expect(
        renderPage({ asset: mapped({ personContextHeader: "X-Person-Ref" }, "release") })
      ).toContain('id="person-context"');
    });

    it("offers no list of people to a reader who may not list them, and handles a failed or empty one", () => {
      const asset = mapped({ personContextHeader: "X-Person-Ref" });
      const hidden = renderPage({ asset, subjects: { status: "hidden" } });
      expect(hidden).toContain('data-person-context-list="hidden"');
      expect(hidden).not.toContain('data-connection-field="personContextSubject"');
      expect(hidden).not.toContain('data-connection-field="personContextSubjectId"');
      expect(renderPage({ asset, subjects: { status: "failed", retry: noop } })).toContain(
        "Try again"
      );
      expect(renderPage({ asset, subjects: { status: "ready", subjects: [] } })).toContain(
        'data-person-context-list="empty"'
      );
    });

    it("has no mappings without the header, for a reader who may not change it, or without the source", () => {
      expect(renderPage({ asset: mapped({}) })).not.toContain('id="person-context"');
      const asset = mapped({ personContextHeader: "X-Person-Ref" });
      expect(renderPage({ asset, mayTest: false })).not.toContain('id="person-context"');
      expect(renderPage({ asset, personContext: false })).not.toContain('id="person-context"');
      // An MCP Connection sends no person context, whatever its settings say.
      const mcp = connectionAsset("records", {
        settings: { url: "https://records.example.test/mcp", personContextHeader: "X-Person-Ref" }
      });
      expect(renderPage({ asset: mcp })).not.toContain('id="person-context"');
    });
  });
});

describe("A Connection in the list", () => {
  const kind = required(buildAssetKinds.find((entry) => entry.kind === "connection"));
  const { t } = createTranslationContext("en");
  const row = (attributes: Record<string, string | boolean>): BuildAssetRow => ({
    id: "asset_workmail",
    kind: "connection",
    name: "workmail",
    title: "Work Mail",
    attributes: { connectorType: "mcp", enabled: true, ...attributes },
    scope: { kind: "instance" },
    revision: 4,
    allowed: ["read", "write", "delete"],
    updatedAt: "2026-10-30T10:00:00.000Z"
  });
  const badges = (attributes: Record<string, string | boolean>) =>
    renderToStaticMarkup(createElement("div", null, kind.badges?.(row(attributes), t)));

  it("maps every health the instance names", () => {
    expect(listedHealth("ok")).toBe("ready");
    expect(listedHealth("failed")).toBe("failed");
    expect(listedHealth("needs_configuration")).toBe("not_configured");
    expect(listedHealth("needs_configuration", true)).toBe("personal");
    expect(listedHealth("secret_unreadable")).toBe("secret_unreadable");
    expect(listedHealth("unknown")).toBe("never_tested");
    expect(listedHealth("constructor")).toBeUndefined();
    expect(listedHealth(undefined)).toBeUndefined();
  });

  it("names only a health somebody has to act on, and Disabled for one that is off", () => {
    expect(badges({ health: "failed" })).toContain('data-connection-list-health="failed"');
    expect(badges({ enabled: false, health: "ok" })).toContain(">Disabled<");
    // One that works, was never tested or names no health says nothing more.
    const quietOnes: Record<string, string>[] = [{ health: "ok" }, { health: "unknown" }, {}];
    for (const quiet of quietOnes) {
      expect(badges(quiet)).not.toContain("data-connection-list-health");
      expect(badges(quiet)).not.toContain(">Enabled<");
    }
  });

  // T35: a failed connect left a Connection behind without tools.
  it("marks one without tools as incomplete and removable in place, and a complete one not", () => {
    if (!isEditableKind(kind)) throw new Error("Connections are edited in Build");
    const incomplete = row({ health: "unknown", withoutTools: true });
    expect(kind.row?.(incomplete, t).description).toBeDefined();
    expect(kind.rowRemovable?.(incomplete)).toBe(true);
    expect(badges({ health: "unknown", withoutTools: true })).toContain(
      "data-connection-incomplete"
    );
    const complete = row({ health: "unknown" });
    expect(kind.row?.(complete, t).description).toBeUndefined();
    expect(kind.rowRemovable?.(complete)).toBe(false);
  });
});

describe("Who may make a Connection in Studio", () => {
  const withConnections = (actions: string[]) => {
    const base = platformContext([], actions);
    return {
      ...base,
      kinds: [
        ...base.kinds,
        {
          kind: "connection",
          plural: "connections",
          lifecycle: "active" as const,
          representation: "config" as const,
          owners: ["instance" as const],
          actions: {
            read: "connection.read",
            write: "connection.write",
            delete: "connection.delete"
          }
        }
      ]
    };
  };

  it("is whoever holds connection.write on the whole instance, not the legacy key, which still makes agents", () => {
    const write = resolveBuildRights({ permissions: [] }, withConnections(["connection.write"]));
    expect(write.mayCreate("connection")).toBe(true);
    expect(write.mayCreate("agent")).toBe(false);
    const legacy = resolveBuildRights(
      { permissions: ["config_assets.write"] },
      withConnections([])
    );
    expect(legacy.mayCreate("connection")).toBe(false);
    expect(legacy.mayCreate("agent")).toBe(true);
  });
});

describe("The operation details (CONN-PAGE 1)", () => {
  // CONN-PAGE 1: every accepted operation says what it calls and what it takes. A REST API's
  // operation is read from the definition the page holds, without a request; an MCP tool from
  // the input schema its server named. Both come from outside the instance: wrong shapes are
  // passed over, sizes are bounded, and every text is shown as text.

  /** A REST API's definition with one declared operation, as the approval writes it. */
  const restConfig = {
    name: "exampledata",
    connectorType: "http_api",
    settings: { baseUrl: "https://api.exampledata.test" },
    operations: [
      {
        name: "listFiscalYears",
        effect: "reading",
        exposure: ["agent"],
        enabled: true,
        method: "get",
        path: "/clients/{clientId}/fiscal-years",
        pathParams: {
          clientId: { schema: { type: "string", format: "uuid" }, description: "The client." }
        },
        query: {
          status: { schema: { type: "string", enum: ["open", "closed"] }, required: false },
          limit: { schema: { type: "integer", minimum: 1, maximum: 100 }, required: true },
          fields: { schema: { type: "array", items: { type: "string", enum: ["id", "year"] } } }
        }
      }
    ]
  };

  const mcpSchema = {
    type: "object",
    required: ["year", "filter"],
    properties: {
      year: { type: "integer", minimum: 2000, description: "The year to sum up." },
      currency: { anyOf: [{ type: "string" }, { type: "null" }], default: "EUR" },
      tags: { type: "array", items: { type: "string" }, maxItems: 5 },
      filter: {
        type: "object",
        required: ["region"],
        properties: { region: { enum: ["north", "south"] }, city: { type: "string" } }
      }
    }
  };

  function operation(
    overrides: Partial<ConnectionOperationDetail> = {}
  ): ConnectionOperationDetail {
    return {
      name: "revenue_by_month",
      toolName: "connection.sample.revenue_by_month",
      effect: "reading",
      exposure: ["agent"],
      enabled: true,
      status: "ready",
      ...overrides
    };
  }

  function render(config: Record<string, unknown>, detail: ConnectionOperationDetail): string {
    return renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { locale: "en", children: null },
        createElement(OperationDetails, { operation: detail, config })
      )
    );
  }

  describe("What a REST API's operation sends", () => {
    it("reads the method, the path and every parameter from the definition", () => {
      const declaration = httpOperationDeclaration(restConfig, "listFiscalYears");
      expect(declaration?.request).toEqual({
        method: "GET",
        path: "/clients/{clientId}/fiscal-years"
      });
      expect(
        declaration?.parameters.map((parameter) => [parameter.name, parameter.location])
      ).toEqual([
        ["clientId", "path"],
        ["status", "query"],
        ["limit", "query"],
        ["fields", "query"]
      ]);
      const [clientId, status, limit, fields] = declaration?.parameters ?? [];
      // A path parameter is always required; a query parameter where it says so.
      expect(clientId?.required).toBe(true);
      expect(clientId?.description).toBe("The client.");
      expect(status?.required).toBe(false);
      expect(status?.values).toEqual(["open", "closed"]);
      expect(limit?.required).toBe(true);
      expect(limit?.constraints).toEqual([
        { key: "minimum", value: "1" },
        { key: "maximum", value: "100" }
      ]);
      // A list's allowed entries are its items' values, apart from the values of the list itself.
      expect(fields?.values).toEqual([]);
      expect(fields?.itemValues).toEqual(["id", "year"]);
      expect(declaration?.raw).toContain('"pathParams"');
      // The approval's own members are not part of what the operation sends.
      expect(declaration?.raw).not.toContain("exposure");
      expect(httpOperationDeclaration(restConfig, "missing")).toBeUndefined();
    });
  });

  describe("What an MCP tool takes", () => {
    it("lists the members of its input schema with types, required, values and constraints", () => {
      const declaration = mcpOperationDeclaration(mcpSchema);
      expect(declaration?.request).toBeUndefined();
      expect(
        declaration?.parameters.map((parameter) => [parameter.name, parameter.required])
      ).toEqual([
        ["year", true],
        ["currency", false],
        ["tags", false],
        ["filter", true],
        ["filter.region", true],
        ["filter.city", false]
      ]);
      const byName = new Map(
        declaration?.parameters.map((parameter) => [parameter.name, parameter])
      );
      expect(byName.get("currency")?.types).toEqual(["string", "null"]);
      expect(byName.get("tags")?.itemTypes).toEqual(["string"]);
      // A type the schema leaves out is read from the values it allows.
      expect(byName.get("filter.region")?.types).toEqual(["string"]);
      expect(byName.get("filter.region")?.values).toEqual(["north", "south"]);
    });

    it("says it takes no input only where the schema is closed and empty, and never for one it cannot list", () => {
      for (const nothing of [
        { type: "object", properties: {}, additionalProperties: false },
        { type: "object", additionalProperties: false }
      ]) {
        expect(render({ connectorType: "mcp" }, operation({ inputSchema: nothing }))).toContain(
          "Takes no input."
        );
      }
      for (const schema of [
        { type: "object" },
        // An empty `properties` is open to any member unless the object is closed.
        { type: "object", properties: {} },
        { type: "object", properties: {}, required: ["query"], additionalProperties: false },
        { allOf: [{ $ref: "#/$defs/query" }] },
        { type: "object", patternProperties: { "^x-": { type: "string" } } }
      ]) {
        expect(mcpOperationDeclaration(schema)?.takesNothing, JSON.stringify(schema)).toBe(false);
        const markup = render({ connectorType: "mcp" }, operation({ inputSchema: schema }));
        expect(markup).not.toContain("Takes no input.");
        expect(markup).toContain("data-connection-inputs-elsewhere");
      }
    });
  });

  describe("A declaration of the wrong shape or size", () => {
    it("passes over members of the wrong shape and never throws", () => {
      for (const schema of [null, "text", 3, [], { properties: "x" }, { properties: [1, 2] }]) {
        const read = mcpOperationDeclaration(schema);
        expect(read?.parameters ?? []).toEqual([]);
      }
      const strange = mcpOperationDeclaration({
        properties: {
          a: null,
          b: { type: 7, enum: "x", minimum: { nested: true }, anyOf: "no" },
          c: { type: ["string", 5, null] }
        },
        required: "a"
      });
      expect(strange?.parameters.map((parameter) => parameter.name)).toEqual(["a", "b", "c"]);
      expect(strange?.parameters.every((parameter) => !parameter.required)).toBe(true);
      expect(strange?.parameters[1]?.types).toEqual([]);
      expect(strange?.parameters[2]?.types).toEqual(["string"]);
      const rest = httpOperationDeclaration(
        {
          operations: [
            "nope",
            { name: "odd", method: 4, path: null, pathParams: [1], query: { q: "text" } }
          ]
        },
        "odd"
      );
      expect(rest?.request).toEqual({ method: "GET", path: "" });
      expect(rest?.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
    });

    it("lists a bounded number of parameters and values, and cuts long texts", () => {
      const properties = Object.fromEntries(
        Array.from({ length: PARAMETERS_MAX + 30 }, (_, index) => [
          `field_${index}`,
          {
            type: "string",
            description: "x".repeat(TEXT_MAX_CHARS * 3),
            enum: Array.from({ length: VALUES_MAX + 50 }, (_, value) => `v${value}`)
          }
        ])
      );
      const read = mcpOperationDeclaration({ type: "object", properties });
      expect(read?.parameters).toHaveLength(PARAMETERS_MAX);
      expect(read?.moreParameters).toBe(true);
      expect(read?.parameters[0]?.values).toHaveLength(VALUES_MAX);
      expect(read?.parameters[0]?.moreValues).toBe(true);
      expect(read?.parameters[0]?.description?.length).toBe(TEXT_MAX_CHARS);
      expect(read?.raw.length).toBeLessThanOrEqual(RAW_MAX_CHARS);
      // Within the bound the declaration under Technical details is whole, valid JSON.
      expect(read?.rawCut).toBe(false);
      expect(JSON.parse(read?.raw ?? "")).toEqual({ type: "object", properties });
      const over = mcpOperationDeclaration({ description: "x".repeat(RAW_MAX_CHARS) });
      expect(over?.rawCut).toBe(true);
      expect(over?.raw.length).toBe(RAW_MAX_CHARS);
    });

    it("shows a text of the server as text, never as markup", () => {
      const markup = render(
        { connectorType: "mcp" },
        operation({
          inputSchema: {
            properties: {
              "<img src=x onerror=alert(1)>": {
                type: "string",
                description: "<script>alert(1)</script>",
                enum: ["<b>bold</b>"]
              }
            }
          }
        })
      );
      expect(markup).not.toContain("<script>");
      expect(markup).not.toContain("<img src=x");
      expect(markup).not.toContain("<b>bold</b>");
      expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });
  });
});

describe("The Connections page (CONN-IA)", () => {
  // "Meine Verbindungen" holds what one person connects with their own account; the manage tab
  // holds the instance's Connections and the services to install. These tests fail where a
  // card would say the reader is connected when only the instance has the service, where a
  // person would be offered a service twice, where a reader who manages nothing would be
  // shown another person's server, or where an entry the operator has not named could start.

  const entry = (id: string, offered = true): CatalogueEntryOffer => ({
    id,
    version: 1,
    service: id,
    title: { en: `Service ${id}`, de: `Dienst ${id}` },
    description: { en: "Reads files.", de: "Liest Dateien." },
    category: "files",
    examplePrompts: [],
    mark: { color: "#2f6f4f" },
    offered,
    parts: [
      {
        part: "tools",
        connectorType: "http_api",
        name: id,
        description: { en: "Agents read.", de: "Agenten lesen." },
        authScheme: "bearer",
        settings: {},
        fields: [],
        prerequisites: [],
        hosts: [],
        sharedAccountNote: { en: "Shared.", de: "Geteilt." },
        documentSource: false,
        operations: []
      }
    ]
  });

  const notes: OwnServerEntry = {
    id: "notes",
    version: 1,
    service: "notes",
    title: { en: "Notes", de: "Notizen" },
    description: { en: "Your meeting notes.", de: "Deine Besprechungsnotizen." },
    mark: { color: "#123456" },
    url: "https://notes.example.com/mcp",
    signIn: "oauth",
    tools: []
  };
  const ownNotes = {
    name: "notes-a1b2c3",
    title: "Notes",
    service: "notes",
    state: "not_connected" as const,
    ownServer: { host: "notes.example.com", enabled: true, tools: 0 }
  };
  const mailbox = { name: "mail", title: "My mailbox", state: "connected" as const };

  it("lists a person's accounts, then their own servers, then the services still to connect", () => {
    const shown = (cards: readonly MyConnectionCard[]) =>
      cards.map((card) => [card.kind, card.kind === "offer" ? card.entry.id : card.row.name]);
    expect(shown(myConnectionCards({ connections: [mailbox], entries: [notes] }))).toEqual([
      ["account", "mail"],
      ["offer", "notes"]
    ]);
    // A service the person already added is their server's card, and is offered no second time.
    expect(
      shown(myConnectionCards({ connections: [ownNotes, mailbox], entries: [notes] }))
    ).toEqual([
      ["account", "mail"],
      ["own", "notes-a1b2c3"]
    ]);
    // A server of the same service moved to another host is no longer that entry.
    const moved = {
      ...ownNotes,
      ownServer: { ...ownNotes.ownServer, host: "elsewhere.example.com" }
    };
    expect(shown(myConnectionCards({ connections: [moved], entries: [notes] }))).toEqual([
      ["own", "notes-a1b2c3"],
      ["offer", "notes"]
    ]);
  });

  it("keeps out of the instance's list what is the reader's own card or not theirs to act on", () => {
    const own = { attributes: { ownServer: "reader", personalSignIn: true } };
    const others = {
      attributes: { ownServer: "other", ownerLabel: "Carol", personalSignIn: true }
    };
    const personal = { attributes: { personalSignIn: true } };
    const shared = { attributes: { connectorType: "mcp" } };
    const unfinished = { attributes: { connectorType: "mcp", withoutTools: true } };
    const off = { attributes: { connectorType: "mcp", enabled: false } };
    const hidden = (mayManage: boolean) =>
      [own, others, personal, unfinished, off, shared].map((row) =>
        hiddenFromConnectionList(row, mayManage)
      );
    // Who manages Connections sees each person's Connection and other people's servers.
    expect(hidden(true)).toEqual([true, false, false, false, false, false]);
    // Everybody else reads only the shared ones they can work with.
    expect(hidden(false)).toEqual([true, true, true, true, true, false]);
  });

  it("says of an entry only whether the instance has it, never that the reader is connected", () => {
    const cards = serviceCards({
      entries: [entry("ask", false), entry("files"), entry("crm"), entry("notes")],
      connections: [
        { name: "files-docs", attributes: { catalogueEntry: "files" } },
        // Another person's own server is never the instance's install of an entry.
        { name: "notes-carol", attributes: { ownServer: "other", catalogueEntry: "notes" } }
      ]
    });
    expect(cards.map((card) => [card.id, card.status, card.action?.kind])).toEqual([
      ["files", "installed", "open"],
      ["crm", "start", "install"],
      ["notes", "start", "install"],
      // An entry the operator has not named comes last and opens nothing.
      ["ask", "not-offered", undefined]
    ]);
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(CatalogueServices, {
          cards,
          hrefOf: (action) =>
            action.kind === "open" ? `/build/connections/${action.name}` : undefined,
          onAct() {}
        })
      })
    );
    const card = (id: string) => {
      const start = markup.indexOf(`data-catalogue-entry="${id}"`);
      return markup.slice(start, markup.indexOf("</li>", start));
    };
    expect(card("files")).toContain('href="/build/connections/files-docs"');
    expect(card("files")).toContain("Bereits eingerichtet");
    expect(card("files")).not.toContain("<button");
    expect(card("crm")).toContain("data-catalogue-start");
    expect(card("ask")).not.toContain("<button");
    expect(card("ask")).not.toContain("<a");
  });

  it("says in a row whose account a Connection uses, and names the service it was installed for", () => {
    const kind = required(buildAssetKinds.find((candidate) => candidate.kind === "connection"));
    const { t } = createTranslationContext("de");
    const row = (attributes: Record<string, string | boolean>): BuildAssetRow => ({
      id: "asset_files",
      kind: "connection",
      name: "files-docs",
      title: "Team files",
      attributes: { connectorType: "files_type", enabled: true, ...attributes },
      scope: { kind: "instance" },
      revision: 1,
      // A reader who may not change it is told no number of people.
      allowed: ["read"],
      updatedAt: "2026-10-30T10:00:00.000Z"
    });
    const badges = (attributes: Record<string, string | boolean>) =>
      renderToStaticMarkup(createElement("div", null, kind.badges?.(row(attributes), t)));
    expect(badges({ health: "ok" })).toContain("Gemeinsamer Zugang");
    // A type id the interface has no words for is not shown.
    expect(badges({ health: "ok" })).not.toContain("files_type");
    const personal = badges({ health: "needs_configuration", personalSignIn: true });
    expect(personal).toContain("Jede Person mit eigenem Konto");
    expect(personal).not.toContain("data-connection-list-health");
    // The number of people stands in the same words, where the instance names it.
    expect(badges({ personalSignIn: true, connectedPeople: "3" }).replaceAll(/<[^>]+>/gu, "")).toBe(
      "Jede Person mit eigenem Konto · 3 verbunden"
    );
    expect(
      serviceFaceOf(row({ serviceTitle: "Files", serviceColor: "#2f6f4f" }).attributes)
    ).toEqual({ title: "Files", mark: { color: "#2f6f4f" } });
    expect(serviceFaceOf(row({}).attributes)).toBeUndefined();
  });
});

describe("What the form of a Connection writes", () => {
  // What the form of a Connection made on the instance writes. The page holds the state; these
  // make the definitions it saves. None of them carries a key.

  const FINGERPRINT = "f".repeat(64);

  describe("the form of a Connection", () => {
    it("makes a new MCP Connection that accepts nothing, with the header only where it is read", () => {
      const form: ConnectionFormState = {
        ...emptyConnectionForm(),
        url: " https://mcp.example.com/mcp ",
        authScheme: "bearer",
        headerName: "X-Key"
      };
      expect(newConnectionConfig({ name: "crm", title: "CRM" }, form)).toEqual({
        name: "crm",
        displayName: "CRM",
        connectorType: "mcp",
        operations: [],
        enabled: true,
        settings: { url: "https://mcp.example.com/mcp" },
        authScheme: "bearer"
      });
      expect(withConnectionForm({ name: "crm" }, { ...form, authScheme: "header" })).toMatchObject({
        settings: { url: "https://mcp.example.com/mcp", headerName: "X-Key" }
      });
    });

    it("starts a copy from the copied Connection's address and operations, and nothing of its key", () => {
      const copied = {
        name: "release-crm",
        description: "The CRM.",
        settings: { url: "https://mcp.example.com/mcp", headerName: "X-Key" },
        authScheme: "header",
        secretHandle: "secret_x",
        origin: "release",
        operations: [{ name: "lookup", effect: "reading", exposure: ["agent"], enabled: true }]
      };
      const form = connectionConfigToForm(copied);
      expect(form).toEqual({
        connectorType: "mcp",
        url: "https://mcp.example.com/mcp",
        authScheme: "header",
        headerName: "X-Key",
        headers: [],
        testPath: "",
        personContextHeader: "",
        oauth: emptyOAuthForm()
      });
      const config = newConnectionConfig({ name: "crm", title: "CRM", copyOf: copied }, form);
      expect(config).toMatchObject({ description: "The CRM.", operations: copied.operations });
      expect(config).not.toHaveProperty("secretHandle");
      expect(config).not.toHaveProperty("origin");
    });

    it("makes a REST API with its base address, fixed headers and test path, and reads it back", () => {
      const form: ConnectionFormState = {
        ...emptyConnectionForm("http_api"),
        url: " https://gateway.example.test/datevconnect ",
        authScheme: "header",
        headerName: "X-Api-Key",
        headers: [
          { name: " x-client-instance-id ", value: " 7c1e " },
          { name: "", value: "an empty row is no header" }
        ],
        testPath: " /health "
      };
      const config = newConnectionConfig({ name: "exampledata", title: "Exampledata" }, form);
      expect(config).toEqual({
        name: "exampledata",
        displayName: "Exampledata",
        connectorType: "http_api",
        operations: [],
        enabled: true,
        settings: {
          baseUrl: "https://gateway.example.test/datevconnect",
          headers: { "x-client-instance-id": "7c1e" },
          testPath: "/health",
          headerName: "X-Api-Key"
        },
        authScheme: "header"
      });
      expect(connectionConfigToForm(config)).toEqual({
        connectorType: "http_api",
        url: "https://gateway.example.test/datevconnect",
        authScheme: "header",
        headerName: "X-Api-Key",
        headers: [{ name: "x-client-instance-id", value: "7c1e" }],
        testPath: "/health",
        personContextHeader: "",
        oauth: emptyOAuthForm()
      });
      // Without a key nothing is sent, and the settings name no header and no test path.
      expect(
        newConnectionConfig(
          { name: "open", title: "Open" },
          {
            ...emptyConnectionForm("http_api"),
            url: "https://open.example.test",
            authScheme: "none"
          }
        )
      ).toMatchObject({ settings: { baseUrl: "https://open.example.test" }, authScheme: "none" });
    });

    it("writes a REST API's OAuth sign-in with its server, client and permissions, and reads it back", () => {
      const form: ConnectionFormState = {
        ...emptyConnectionForm("http_api"),
        url: "https://graph.example.test/v1.0",
        authScheme: "oauth",
        oauth: {
          authorizationUrl: " https://login.example.test/authorize ",
          tokenUrl: "https://login.example.test/token",
          revocationUrl: "",
          clientId: " app-1 ",
          scopes: "  User.Read offline_access User.Read ",
          params: [
            { name: "prompt", value: "consent" },
            { name: "", value: "no parameter" }
          ],
          tokenAuthMethod: "client_secret_basic"
        }
      };
      expect(oauthFormComplete(form)).toBe(true);
      const config = newConnectionConfig({ name: "graph", title: "Graph" }, form);
      expect(config).toMatchObject({
        authScheme: "oauth",
        settings: {
          baseUrl: "https://graph.example.test/v1.0",
          oauth: {
            authorizationUrl: "https://login.example.test/authorize",
            tokenUrl: "https://login.example.test/token",
            clientId: "app-1",
            scopes: ["User.Read", "offline_access"],
            authorizationParams: { prompt: "consent" },
            tokenAuthMethod: "client_secret_basic"
          }
        }
      });
      expect(config.settings).not.toHaveProperty("oauth.revocationUrl");
      expect(connectionConfigToForm(config).oauth).toEqual({
        ...form.oauth,
        authorizationUrl: "https://login.example.test/authorize",
        clientId: "app-1",
        scopes: "User.Read offline_access",
        params: [{ name: "prompt", value: "consent" }]
      });
      // The client credentials grant names no authorization address and no extra parameters.
      const machine = withConnectionForm(config, { ...form, authScheme: "oauth_client" });
      expect(machine).toMatchObject({ authScheme: "oauth_client" });
      expect(machine.settings).not.toHaveProperty("oauth.authorizationUrl");
      expect(machine.settings).not.toHaveProperty("oauth.authorizationParams");
      // Another scheme drops the server; a sign-in without its addresses is not complete.
      expect(
        withConnectionForm(config, { ...form, authScheme: "bearer" }).settings
      ).not.toHaveProperty("oauth");
      expect(oauthFormComplete({ ...form, oauth: { ...form.oauth, authorizationUrl: "" } })).toBe(
        false
      );
      // The client secret is sent again when the token address moves to another host.
      expect(credentialOriginKey(form)).not.toBe(
        credentialOriginKey({
          ...form,
          oauth: { ...form.oauth, tokenUrl: "https://other.example.test/token" }
        })
      );
    });

    it("approves tools at once, pinned to what was read, takes one off, and accepts a new description", () => {
      const base = {
        name: "crm",
        operations: [
          { name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" }
        ]
      };
      const accepted = withApprovedOperations(
        base,
        [
          { name: "lookup", effect: "changing", schemaFingerprint: FINGERPRINT },
          {
            name: "clients",
            effect: "reading",
            declaration: { method: "GET", path: "/clients", description: "Lists the clients." }
          }
        ],
        ["agent", "workflow"]
      );
      expect(accepted.operations).toEqual([
        { name: "list", effect: "reading", exposure: [], enabled: true, policy: "deny" },
        {
          name: "lookup",
          effect: "changing",
          exposure: ["agent", "workflow"],
          enabled: true,
          schemaFingerprint: FINGERPRINT
        },
        {
          method: "GET",
          path: "/clients",
          description: "Lists the clients.",
          name: "clients",
          effect: "reading",
          exposure: ["agent", "workflow"],
          enabled: true
        }
      ]);
      // Approved again, an operation stands once, as approved now.
      expect(
        withApprovedOperations(accepted, [{ name: "lookup", effect: "reading" }], []).operations
      ).toHaveLength(3);
      expect(withReviewedOperation(accepted, "list", FINGERPRINT).operations).toMatchObject([
        { name: "list", schemaFingerprint: FINGERPRINT, policy: "deny" },
        { name: "lookup" },
        { name: "clients" }
      ]);
      expect(withoutOperation(withoutOperation(accepted, "lookup"), "clients").operations).toEqual(
        base.operations
      );
    });

    it("opens one operation to outside clients and closes it again, and leaves its other exposures", () => {
      const base = {
        name: "crm",
        operations: [
          { name: "list", effect: "reading", exposure: ["agent", "workflow"], enabled: true },
          { name: "lookup", effect: "reading", exposure: ["agent"], enabled: true }
        ]
      };
      const opened = withOperationExposure(base, "list", "outside", true);
      expect(opened.operations).toEqual([
        {
          name: "list",
          effect: "reading",
          exposure: ["agent", "workflow", "outside"],
          enabled: true
        },
        base.operations[1]
      ]);
      // Ticked twice it is listed once.
      expect(withOperationExposure(opened, "list", "outside", true)).toEqual(opened);
      expect(withOperationExposure(opened, "list", "outside", false).operations).toEqual(
        base.operations
      );
      // An approved tool is never open to outside clients by itself.
      const accepted = withApprovedOperations(
        base,
        [{ name: "fresh", effect: "reading", schemaFingerprint: FINGERPRINT }],
        ["agent", "bridge", "workflow"]
      );
      expect(accepted.operations).toContainEqual(
        expect.objectContaining({ name: "fresh", exposure: ["agent", "bridge", "workflow"] })
      );
    });

    it("switches one operation off and on and keeps every other member of the definition", () => {
      const operations = [
        { name: "revenue_by_month", effect: "reading", exposure: ["agent"], enabled: true },
        { name: "list_customers", effect: "reading", exposure: ["agent"], enabled: true }
      ];
      const config = { name: "x", connectorType: "mcp", operations, enabled: true };
      const off = withOperationEnabled(config, "revenue_by_month", false);
      expect(off.operations).toEqual([{ ...operations[0], enabled: false }, operations[1]]);
      expect({ ...off, operations: undefined }).toEqual({ ...config, operations: undefined });
      expect(withOperationEnabled(off, "revenue_by_month", true).operations).toEqual(operations);
    });

    it("writes a trimmed name and description, and leaves an empty or cleared description out", () => {
      const config = {
        name: "x",
        displayName: "Old",
        description: "Old text",
        connectorType: "mcp"
      };
      expect(
        withConnectionAbout(config, { title: "  New  ", description: " Reads orders. " })
      ).toEqual({ ...config, displayName: "New", description: "Reads orders." });
      expect(withConnectionAbout(config, { title: "New", description: "  " })).toEqual({
        name: "x",
        displayName: "New",
        connectorType: "mcp"
      });
      // A new Connection keeps a copied description only where the person was not asked.
      const start = {
        name: "ledger",
        title: "Ledger",
        copyOf: { name: "old", description: "Reads the old ledger." }
      };
      expect(newConnectionConfig(start, emptyConnectionForm()).description).toBe(
        "Reads the old ledger."
      );
      expect(
        "description" in newConnectionConfig({ ...start, description: "" }, emptyConnectionForm())
      ).toBe(false);
      expect(
        newConnectionConfig({ ...start, description: " New text " }, emptyConnectionForm())
          .description
      ).toBe("New text");
    });

    it("keeps the person context header through an edit of the settings and counts its change", () => {
      const config = {
        name: "records",
        connectorType: "http_api",
        authScheme: "none",
        settings: {
          baseUrl: "https://records.example.test/api",
          personContextHeader: "X-Person-Ref",
          testPath: "/health"
        }
      };
      expect(personContextHeaderOf(config)).toBe("X-Person-Ref");
      const form = connectionConfigToForm(config);
      expect(
        withConnectionForm(config, { ...form, url: "https://records.example.test/v2" }).settings
      ).toEqual({
        baseUrl: "https://records.example.test/v2",
        testPath: "/health",
        personContextHeader: "X-Person-Ref"
      });
      const cleared = withConnectionForm(config, { ...form, personContextHeader: "  " });
      expect(cleared.settings).toEqual({
        baseUrl: "https://records.example.test/api",
        testPath: "/health"
      });
      expect(personContextHeaderOf(cleared)).toBeUndefined();
      expect(countConnectionFormChanges({ ...form, personContextHeader: "X-Other" }, form)).toBe(1);
    });

    it("waits for a discovery until a new catalog is in, and not longer than its bound", () => {
      const wait = { since: 1_000, discoveredAt: "2026-10-14T08:00:00.000Z" };
      expect(waitsForDiscovery(wait, { discoveredAt: wait.discoveredAt }, 2_000)).toBe(true);
      // A catalog that was dropped is no new one.
      expect(waitsForDiscovery(wait, {}, 2_000)).toBe(true);
      expect(waitsForDiscovery(wait, { discoveredAt: "2026-10-14T08:01:00.000Z" }, 2_000)).toBe(
        false
      );
      expect(waitsForDiscovery(wait, {}, 1_000 + DISCOVERY_WAIT_MS)).toBe(false);
    });

    it("stops waiting once a failure is written after the wait began, and not for an older one", () => {
      const failed = {
        health: "failed",
        lastErrorCode: "upstream_unauthorized",
        recordedAt: "2026-10-14T08:00:00.000Z"
      };
      const wait = discoveryWaitFrom(failed, 1_000);
      // The same failure, written before the page asked, says nothing of this discovery.
      expect(waitsForDiscovery(wait, failed, 2_000)).toBe(true);
      // The discovery failed again: the state was written anew.
      expect(
        waitsForDiscovery(wait, { ...failed, recordedAt: "2026-10-14T08:00:05.000Z" }, 2_000)
      ).toBe(false);
      // A write that reset the state is no failure: the page waits on.
      expect(
        waitsForDiscovery(
          wait,
          { health: "unknown", recordedAt: "2026-10-14T08:00:05.000Z" },
          2_000
        )
      ).toBe(true);
    });

    it("waits on a page that opens only while the Connection was never read and nothing failed", () => {
      const opened = { since: 1_000 };
      expect(waitsForDiscovery(opened, { health: "unknown" }, 2_000)).toBe(true);
      // A personal Connection nobody signed in to: its state says why, so nothing is awaited.
      expect(
        waitsForDiscovery(
          opened,
          {
            health: "needs_configuration",
            lastErrorCode: "oauth_required",
            recordedAt: "2026-10-14T08:00:00.000Z"
          },
          2_000
        )
      ).toBe(false);
    });

    it("waits for no discovery after a write that asked for none", () => {
      expect(waitsForDiscovery(discoveryWaitFrom(undefined, 1_000, false), {}, 2_000)).toBe(false);
    });

    it("names the sign-in the tools wait for: the reader's own, or the Connection's one", () => {
      const personal = { personal: true, signsIn: true };
      expect(discoveryWaitsForSignIn({ ...personal, own: "not_connected" })).toBe("own");
      expect(discoveryWaitsForSignIn({ ...personal, own: "needs_reconnect" })).toBe("own");
      expect(discoveryWaitsForSignIn({ ...personal, own: "connected" })).toBeUndefined();
      // Not read yet: the page claims nothing.
      expect(discoveryWaitsForSignIn(personal)).toBeUndefined();
      const shared = { personal: false, signsIn: true };
      expect(discoveryWaitsForSignIn(shared)).toBe("shared");
      expect(discoveryWaitsForSignIn({ ...shared, binding: "revoked" })).toBe("shared");
      expect(discoveryWaitsForSignIn({ ...shared, binding: "connected" })).toBeUndefined();
      expect(discoveryWaitsForSignIn({ personal: false, signsIn: false })).toBeUndefined();
    });
  });
});
