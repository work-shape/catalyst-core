import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConnectionDetail, LocaleCode } from "@work-shape/catalyst-api-client";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  ConnectionEditor,
  connectionConfigToForm,
  countConnectionFormChanges,
  listedHealth,
  personContextHeaderOf,
  resolveBuildRights,
  withConnectionForm,
  type BuildAsset,
  type BuildAssetKind,
  type BuildAssetRead,
  type BuildSource,
  type CatalogueEntryOffer,
  type ConnectionDetailRead,
  type ConnectionHoldersRead,
  type ConnectionSource,
  type ConnectionTestRun
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
    setSecret: async () => undefined,
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
  it("shows whom a release Connection belongs to and that its operator sets it up, with nothing to edit", () => {
    const markup = renderPage();

    expect(markup).toContain(">Sample business</h1>");
    // The head names the Connection only; its id is behind "Copy ID" in the head's menu.
    expect(markup).not.toContain(">Connection<");
    expect(markup).not.toContain(">sample-business<");
    expect(markup).toContain(">Everyone<");
    expect(markup).toContain(
      "This connection comes with the system setup. The technical team changes it there; it cannot be changed here."
    );
    // Where it comes from is a sentence at the top of the page and no chip.
    expect(markup).not.toContain("Defined in release config");
    // The head says how the enabled Connection is, as its last test or call left it.
    expect(markup).toContain('data-connection-head-health="never_tested"');
    expect(markup).toContain('aria-label="Back to Connections"');
    // Nothing on the page writes: no field, no save. Its history is read, its menu offers
    // "Copy ID", and a reader who may create one starts a copy of it.
    for (const control of ["<input", "<textarea", "Save", ">Edit<", ">Accept<"]) {
      expect(markup, control).not.toContain(control);
    }
    expect(markup).toContain(">History<");
    expect(markup).toContain('aria-label="More actions"');
    expect(markup).toContain(">Copy to edit<");
    expect(renderPage({ locale: "de" })).toContain(
      "Diese Verbindung gehört zur Einrichtung des Systems. Das technische Team ändert sie dort; hier lässt sie sich nicht ändern."
    );
    expect(renderPage({ asset: connectionAsset("ledger", { origin: "runtime" }) })).not.toContain(
      "data-build-read-only"
    );
    // A Connection of a workspace says so, and one that is off says that nothing can call it.
    const other = renderPage({
      asset: {
        ...connectionAsset("ledger", { enabled: false }),
        scope: { kind: "workspace", workspaceId: "ws_1" }
      }
    });
    expect(other).toContain(">Another workspace<");
    expect(other).toContain("This connection is disabled. Nothing can call it.");
    expect(markup).not.toContain("data-connection-disabled");
  });

  it("shows the settings and of the credential only whether it is there", () => {
    const markup = renderPage();

    // Type and authentication read in words; their ids wait under Technical details.
    expect(markup).toContain(">MCP server<");
    expect(markup).toContain(">Bearer token<");
    expect(markup).not.toContain(">mcp<");
    expect(markup).not.toContain(">bearer<");
    expect(markup).toContain("data-connection-technical");
    expect(markup).toContain(">Server address<");
    expect(markup).toContain("https://sample-business.example.test/mcp");
    expect(markup).toContain(">timeoutSeconds<");
    expect(markup).toContain(">20<");
    expect(markup).toContain("Revenue, customers and orders of the sample business.");
    expect(markup).toContain('data-connection-credential="set"');
    expect(markup).toContain("Set, version 2");
    // A reader who may not change the Connection is told that it is set, not its version.
    const readOnly = renderPage({ mayTest: false });
    expect(readOnly).toContain(">Set<");
    expect(readOnly).not.toContain("version 2");
    expect(markup).toContain(
      "The credential stays in protected storage. This page shows only whether it is there."
    );
    // The revision names the handle of the credential. The page reads named members only.
    expect(markup).not.toContain(FIXTURE_SECRET_HANDLE);
    expect(markup).not.toContain("secret_");
    expect(markup).not.toContain("secretHandle");

    const notSet = renderPage({ detail: recordedStates.notConfigured });
    expect(notSet).toContain('data-connection-credential="not_set"');
    expect(notSet).toContain(">Not set<");
    const unreadable = renderPage({ detail: recordedStates.secretUnreadable });
    expect(unreadable).toContain('data-connection-credential="unreadable"');
    expect(unreadable).toContain(">Unreadable<");

    // A Connection that sends no credential has none to set, and no account anybody shares.
    const open = renderPage({ asset: connectionAsset("open-data", { authScheme: "none" }) });
    expect(open).toContain('data-connection-credential="none_needed"');
    expect(open).toContain(">None needed<");
    expect(open).toContain("The outside system asks for no credential.");
    expect(open).not.toContain(">Not set<");
    expect(open).not.toContain("The credential stays in the Secret Store.");
    expect(open).not.toContain("data-connection-shared");
    const offen = renderPage({
      asset: connectionAsset("open-data", { authScheme: "none" }),
      locale: "de"
    });
    expect(offen).toContain(">Nicht nötig<");
    expect(offen).toContain("Das externe System verlangt keine Zugangsdaten.");
  });

  it("says each recorded state in one sentence, in English and in German", () => {
    const states: [keyof typeof recordedStates, string, string, string][] = [
      [
        "neverTested",
        "never_tested",
        "This connection has not been tested yet.",
        "Diese Verbindung wurde noch nicht getestet."
      ],
      [
        "ready",
        "ready",
        "The outside system answered the test.",
        "Das externe System hat auf den Test geantwortet."
      ],
      [
        "unauthorized",
        "unauthorized",
        "The outside system refused the credential. It may be wrong, expired or revoked.",
        "Das externe System hat die Zugangsdaten abgelehnt. Sie können falsch, abgelaufen oder widerrufen sein."
      ],
      [
        "networkDenied",
        "network_denied",
        "Access to this address is not allowed. Its host is not among the allowed outside addresses.",
        "Der Zugriff auf diese Adresse ist nicht erlaubt. Ihr Host gehört nicht zu den erlaubten externen Adressen."
      ],
      [
        "unavailable",
        "unavailable",
        "The outside system did not answer the test. It may be down, or its address may be wrong.",
        "Das externe System hat auf den Test nicht geantwortet. Es kann ausgefallen sein, oder seine Adresse stimmt nicht."
      ],
      [
        "notConfigured",
        "not_configured",
        "The credential of this connection is missing. Until the technical team supplies it, no call reaches the outside system.",
        "Die Zugangsdaten dieser Verbindung fehlen. Bis das technische Team sie bereitstellt, erreicht kein Aufruf das externe System."
      ],
      [
        "secretUnreadable",
        "secret_unreadable",
        "A credential is stored, but it cannot be read. Until it is set again, no call reaches the outside system.",
        "Zugangsdaten sind gespeichert, lassen sich aber nicht lesen. Bis sie neu gesetzt sind, erreicht kein Aufruf das externe System."
      ]
    ];
    for (const [state, view, english, german] of states) {
      const en = renderPage({ detail: recordedStates[state] });
      expect(healthOf(en), state).toBe(view);
      expect(en, state).toContain(english);
      expect(renderPage({ detail: recordedStates[state], locale: "de" }), state).toContain(german);
    }
    // Each failure names the next step, and none promises a screen: the operator acts.
    const steps: [keyof typeof recordedStates, string, string][] = [
      [
        "unauthorized",
        "The technical team sets a new credential and restarts the system. Then test again.",
        "Das technische Team setzt neue Zugangsdaten und startet das System neu. Teste danach erneut."
      ],
      [
        "networkDenied",
        "The technical team allows access to this host and restarts the system. Then test again.",
        "Das technische Team erlaubt den Zugriff auf diesen Host und startet das System neu. Teste danach erneut."
      ],
      [
        "unavailable",
        "Check the address under Settings. The technical team can change it.",
        "Prüfe die Adresse unter Einstellungen. Ändern kann sie das technische Team."
      ],
      [
        "notConfigured",
        "The technical team supplies the credential and restarts the system. Then test again.",
        "Das technische Team stellt die Zugangsdaten bereit und startet das System neu. Teste danach erneut."
      ],
      [
        "secretUnreadable",
        "The technical team restores the key the credential was stored with, or supplies the credential again, and restarts the system. Then test again.",
        "Das technische Team stellt den Schlüssel wieder her, mit dem die Zugangsdaten gespeichert wurden, oder stellt die Zugangsdaten erneut bereit, und startet das System neu. Teste danach erneut."
      ],
      [
        "failedUnnamed",
        "Test again. If it fails again, ask the technical team.",
        "Teste erneut. Schlägt der Test wieder fehl, wende dich an das technische Team."
      ]
    ];
    for (const [state, english, german] of steps) {
      // The markup writes an apostrophe as its entity.
      expect(renderPage({ detail: recordedStates[state] }), state).toContain(
        english.replaceAll("'", "&#x27;")
      );
      expect(renderPage({ detail: recordedStates[state], locale: "de" }), state).toContain(german);
    }
    // A reason the page does not know has its own sentence and borrows no other state's.
    const unnamed = renderPage({ detail: recordedStates.failedUnnamed });
    expect(healthOf(unnamed)).toBe("failed");
    expect(unnamed).toContain("The test failed without giving a reason.");
    expect(unnamed).not.toContain("The outside system did not answer the test.");
    expect(renderPage({ detail: recordedStates.failedUnnamed, locale: "de" })).toContain(
      "Der Test ist ohne Angabe eines Grundes fehlgeschlagen."
    );
    expect(healthOf(renderPage({ detail: { health: "failed", lastTestedAt: undefined } }))).toBe(
      "failed"
    );
    // Where the instance has no reason of its own it records the answer of the type's test.
    for (const status of ["unauthorized", "network_denied", "unavailable"] as const) {
      expect(
        healthOf(renderPage({ detail: { health: "failed", lastErrorCode: status } })),
        status
      ).toBe(status);
    }
    // A tested Connection says when; one never tested names no time.
    expect(renderPage({ detail: recordedStates.ready })).toContain("Last tested ");
    expect(renderPage()).not.toContain("Last tested ");
  });

  it("shows a running test and the answer of the test over what was recorded", () => {
    const running = renderPage({ detail: recordedStates.ready, run: { status: "running" } });
    expect(healthOf(running)).toBe("testing");
    expect(running).toContain("Asking the outside system. This can take a moment.");
    expect(running).toContain('aria-busy="true"');
    expect(running).not.toContain("Last tested ");
    expect(renderPage({ run: { status: "running" }, locale: "de" })).toContain(
      "Das externe System wird angefragt. Das kann einen Moment dauern."
    );

    for (const status of ["ready", "unauthorized", "network_denied", "unavailable"] as const) {
      const done = renderPage({ run: { status: "done", result: testResult(status) } });
      expect(healthOf(done), status).toBe(status);
      expect(done, status).toContain("Last tested ");
    }
    // A test that fails after an earlier success says what it found now.
    expect(
      healthOf(
        renderPage({
          detail: recordedStates.ready,
          run: { status: "done", result: testResult("network_denied") }
        })
      )
    ).toBe("network_denied");
    // A failed test does not hide why: the instance answers a missing or unreadable credential
    // as unauthorized and records which of the two it is.
    for (const status of ["unauthorized", "unavailable"] as const) {
      expect(
        healthOf(
          renderPage({
            detail: recordedStates.notConfigured,
            run: { status: "done", result: testResult(status) }
          })
        ),
        status
      ).toBe("not_configured");
    }
    expect(
      healthOf(
        renderPage({
          detail: recordedStates.secretUnreadable,
          run: { status: "done", result: testResult("unauthorized") }
        })
      )
    ).toBe("secret_unreadable");
    // A test that waits for somebody's approval ran nothing, and the page says so.
    expect(renderPage({ run: { status: "held" } })).toContain(
      "The test waits for approval in the Inbox. It has not run yet."
    );
    expect(renderPage({ run: { status: "held" }, locale: "de" })).toContain(
      "Der Test wartet auf eine Freigabe im Eingang. Er ist noch nicht gelaufen."
    );
  });

  it("says in the head what the last test or call found, not only that the Connection is on (ACCEPT-FIX-7 C5)", () => {
    const head = (markup: string) => /data-connection-head-health="([a-z_]+)"/u.exec(markup)?.[1];
    expect(head(renderPage({ detail: recordedStates.unauthorized }))).toBe("unauthorized");
    expect(head(renderPage({ detail: recordedStates.ready }))).toBe("ready");
    const german = renderPage({ detail: recordedStates.unauthorized, locale: "de" });
    expect(german).toMatch(/data-connection-head-health="unauthorized"[^>]*>.*Nicht autorisiert/su);
    // An enabled Connection the server refused is not "Enabled"; a disabled one says it is off.
    expect(renderPage({ detail: recordedStates.unauthorized })).not.toContain(">Enabled<");
    const off = renderPage({ asset: connectionAsset("ledger", { enabled: false }) });
    expect(head(off)).toBeUndefined();
    expect(off).toContain("Disabled");
  });

  it("says nothing in the head of an enabled Connection until its health is read (ACCEPT-FIX-7 C5)", () => {
    // Loading, or a read that failed, is no evidence the Connection works: no green "Enabled".
    const pending: ConnectionDetailRead[] = [
      { status: "loading" },
      { status: "failed", message: undefined, retry: noop }
    ];
    for (const detailRead of pending) {
      for (const locale of ["en", "de"] as const) {
        const markup = renderPage({ detailRead, locale });
        expect(markup).not.toContain(locale === "en" ? ">Enabled<" : ">Aktiv<");
        expect(markup).not.toContain("data-connection-head-health");
        expect(markup).not.toContain("bg-success-soft");
      }
    }
    // A disabled Connection says it is off even before the detail arrives.
    const off = renderPage({
      asset: connectionAsset("ledger", { enabled: false }),
      detailRead: { status: "loading" }
    });
    expect(off).toContain("Disabled");
  });

  it("tells a writer of a Connection that sends no key how to send one when the server asks for it (ACCEPT-FIX-7 C6)", () => {
    const asset = connectionAsset("ledger", { origin: "runtime", authScheme: "none" });
    const markup = renderPage({ asset, detail: recordedStates.unauthorized });
    expect(healthOf(markup)).toBe("unauthorized");
    expect(markup).toContain(
      "The server asks for a key, and this connection sends none. Under Settings, choose Edit, set how the key is sent and save. Then enter the key."
    );
    expect(markup).not.toContain("Enter a new key under Credential.");
    // It sends no credential, so none was refused: the server refuses access without one.
    expect(markup).toContain(
      "The outside system refuses access without a credential, and this connection sends none."
    );
    expect(markup).not.toContain("refused the credential");
    const german = renderPage({ asset, detail: recordedStates.unauthorized, locale: "de" });
    expect(german).toContain(
      "Der Server verlangt einen Schlüssel, und diese Verbindung sendet keinen."
    );
    expect(german).toContain(
      "Das externe System lässt ohne Zugangsdaten keinen Zugriff zu, und diese Verbindung sendet keine."
    );
    expect(german).not.toContain("hat die Zugangsdaten abgelehnt");
    // A Connection that sends a key keeps the way to a new one.
    const withKey = renderPage({
      asset: connectionAsset("ledger", { origin: "runtime" }),
      detail: recordedStates.unauthorized
    });
    expect(withKey).toContain("Enter a new key under Credential.");
    expect(withKey).toContain("The outside system refused the credential.");
  });

  it("offers the test to whoever may run it and tells the others why not", () => {
    const allowed = renderPage();
    expect(allowed).toContain(">Test connection</button>");
    expect(allowed).not.toContain("data-connection-test-not-allowed");

    const readOnly = renderPage({ mayTest: false });
    expect(readOnly).not.toContain("Test connection");
    expect(readOnly).toContain(
      "You can read this connection. Testing it needs the right to change connections across all workspaces."
    );
    expect(renderPage({ mayTest: false, locale: "de" })).toContain(
      "Du kannst diese Verbindung lesen. Zum Testen brauchst du das Recht, Verbindungen in allen Arbeitsbereichen zu ändern."
    );
    // The reader still sees the recorded state.
    expect(healthOf(renderPage({ mayTest: false, detail: recordedStates.ready }))).toBe("ready");

    // The instance decides the call: a refusal is said, and a failure with the instance's words.
    expect(renderPage({ run: { status: "refused" } })).toContain(
      "You may not test this connection. You can read it."
    );
    expect(renderPage({ run: { status: "failed", message: undefined } })).toContain(
      "The test could not be run."
    );
    expect(renderPage({ run: { status: "failed", message: "Too many requests." } })).toContain(
      "Too many requests."
    );
  });

  it("names the shared account where the Connection has one", () => {
    const shared = renderPage();
    expect(shared).toContain("One shared account");
    // The notice is always there for such a Connection: it is no warning.
    const notice = shared.slice(
      shared.lastIndexOf("<div", shared.indexOf("data-connection-shared"))
    );
    expect(notice).toContain('data-tone="info"');
    expect(shared).toContain(
      "Everyone who may use the connection sees what that account sees, whatever their own rights there are."
    );
    expect(renderPage({ locale: "de" })).toContain(
      "Alle, die die Verbindung nutzen dürfen, sehen, was dieses Konto sieht, unabhängig von ihren eigenen Rechten dort."
    );
    expect(renderPage({ detail: { sharedCredential: false } })).not.toContain(
      "data-connection-shared"
    );
  });

  it("shows the shared sign-in of a Connection that signs in with OAuth, and whether anybody is signed in", () => {
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
      detail: { health: "needs_configuration", secret: { state: "not_set" }, oauth },
      locale: "de"
    });
    expect(unsigned).toContain("data-connection-sign-in");
    expect(unsigned).toContain(">Anmeldung<");
    expect(unsigned).toContain('data-sign-in-state="none"');
    expect(unsigned).toContain(">Nicht angemeldet<");
    // The recorded state names the missing sign-in, not a missing key.
    expect(unsigned).toContain(">Anmeldung nötig<");
    expect(unsigned).toContain("auth.files.example.test");
    expect(unsigned).toContain("catalyst-files");
    expect(unsigned).toContain("https://chat.example.com/api/v1/connections/oauth/callback");
    expect(unsigned).toContain('data-sign-in-begin=""');
    expect(unsigned).toContain(">Anmelden<");
    expect(unsigned).not.toContain("data-connection-shared");

    const signedIn = renderPage({
      asset: oauthAsset,
      detail: {
        health: "ok",
        oauth,
        binding: {
          state: "connected",
          account: "team@files.example.test",
          scopes: ["files.read"],
          connectedAt: "2026-10-17T09:00:00.000Z"
        }
      },
      locale: "de"
    });
    expect(signedIn).toContain('data-sign-in-state="connected"');
    expect(signedIn).toContain("team@files.example.test");
    expect(signedIn).toContain("files.read");
    expect(signedIn).toContain(
      "Alle, die diese Verbindung nutzen dürfen, lesen und handeln über dieses Konto."
    );
    expect(signedIn).toContain(">Neu anmelden<");

    // A reader who may not change it sees the state, and that an administrator signs it in.
    const member = renderPage({
      asset: oauthAsset,
      detail: { health: "needs_configuration", oauth },
      canWrite: false,
      mayTest: false
    });
    expect(member).toContain("An administrator signs this connection in.");
    expect(member).not.toContain("data-sign-in-begin");

    expect(renderPage()).not.toContain("data-connection-sign-in");
  });

  it("lists the operations with effect, who may call them and their status", () => {
    const markup = renderPage();
    const row = (name: string) => {
      const start = markup.indexOf(`data-connection-operation="${name}"`);
      expect(start, name).toBeGreaterThan(-1);
      return markup.slice(start, markup.indexOf("</li>", start));
    };

    // A person reads the operation's name, never the id a tool call carries.
    expect(row("revenue_by_month")).toContain(">Revenue by month<");
    expect(row("revenue_by_month")).not.toContain("connection.sample-business.revenue_by_month");
    expect(row("revenue_by_month")).toContain("Returns the revenue of each month of one year.");
    expect(row("revenue_by_month")).toContain("Reading");
    expect(row("revenue_by_month")).toContain("Callable by");
    expect(row("revenue_by_month")).toContain(">Agents<");
    expect(row("revenue_by_month")).toContain("Ready");

    for (const caller of [">Agents<", ">Apps<", ">Workflows<", ">Outside clients<"]) {
      expect(row("list_customers"), caller).toContain(caller);
    }
    expect(row("list_customers")).toContain("Awaiting discovery");
    expect(row("list_customers")).toContain(
      "This operation has not been read from the outside system yet."
    );

    expect(row("update_customer")).toContain("Changing");
    expect(row("update_customer")).toContain("Nobody can call it");
    expect(row("update_customer")).toContain("Needs review");
    expect(row("update_customer")).toContain("New fingerprint:");
    expect(row("update_customer")).toContain(">sha256:9f2c41d07a<");

    expect(row("top_products")).toContain("Unknown");
    expect(row("top_products")).toContain("The outside system does not offer this operation.");
    // An operation that is switched off reads as disabled.
    expect(row("delete_order")).toContain("Disabled");
    expect(row("delete_order")).toContain("Switched off in the system setup.");

    const german = renderPage({ locale: "de" });
    for (const text of ["Lesend", "Ändernd", "Aufrufbar durch", "Prüfung nötig", "Bereit"]) {
      expect(german, text).toContain(text);
    }
    expect(renderPage({ detail: { operations: [] } })).toContain(
      "This connection has no accepted operation."
    );
  });

  it("shows how each paged operation pages, in English and in German", () => {
    const base = connectionDetail().operations;
    if (!base[0]) throw new Error("Missing fixture operation");
    const first = base[0];
    const paged = (locale: LocaleCode) =>
      renderPage({
        locale,
        detail: {
          operations: [
            {
              ...first,
              name: "list_invoices",
              paging: { by: "page", param: "page", sizeParam: "per_page", size: 1000 }
            },
            {
              ...first,
              name: "list_orders",
              paging: { by: "offset", param: "skip", sizeParam: "top", size: 50, start: 10 }
            },
            {
              ...first,
              name: "list_contacts",
              paging: { by: "cursor", param: "after", cursor: "meta.next_cursor" }
            },
            {
              ...first,
              name: "list_files",
              paging: { by: "next_link", param: "url", cursor: "links.next" }
            },
            { ...first, name: "get_report" }
          ]
        }
      });
    const line = (markup: string, name: string) =>
      /<p[^>]*data-connection-paging="([^"]+)"[^>]*>([^<]*)<\/p>/gu
        .exec(markup.slice(markup.indexOf(`data-connection-paging="${name}"`) - 3))?.[2]
        ?.replace(/<!-- -->/gu, "");

    const english = paged("en");
    expect(line(english, "list_invoices")).toBe(
      "Paged by page number in page, 1,000 per page in per_page"
    );
    expect(line(english, "list_orders")).toBe(
      "Paged by row offset in skip, 50 per page in top, starting at 10"
    );
    expect(line(english, "list_contacts")).toBe(
      "Paged by cursor from meta.next_cursor of each answer, sent as after"
    );
    expect(line(english, "list_files")).toBe(
      "Paged by next address from links.next of each answer, sent as url"
    );
    // An operation without paging says nothing of it.
    expect(english).not.toContain('data-connection-paging="get_report"');

    const german = paged("de");
    expect(line(german, "list_invoices")).toBe(
      "Seitenweise nach Seitennummer in page, 1.000 pro Seite in per_page"
    );
    expect(line(german, "list_orders")).toBe(
      "Seitenweise nach Zeilenversatz in skip, 50 pro Seite in top, beginnend bei 10"
    );
  });

  it("lists the agents that carry its tools, each a link to the agent", () => {
    const markup = renderPage();
    expect(markup).toContain('aria-label="Used by"');
    expect(markup).toContain('href="/build/agents/workflow_assistant"');
    expect(markup).toContain(">Workflow Assistant<");
    expect(markup).toContain(">2 tools<");
    expect(markup).toContain('href="/build/agents/tax-steuer_agent"');
    expect(markup).toContain(">1 tool<");
    expect(renderPage({ detail: { usedBy: [] } })).toContain(
      "No agent carries a tool of this connection."
    );
    expect(renderPage({ detail: { usedBy: [] }, locale: "de" })).toContain(
      "Kein Agent führt ein Tool dieser Verbindung."
    );
  });

  it("keeps the definition on the page when the state cannot be read, and says so", () => {
    const failed = renderPage({
      detailRead: { status: "failed", message: undefined, retry: noop }
    });
    expect(failed).toContain("The status of this connection could not be read.");
    expect(failed).toContain(">Try again<");
    expect(failed).toContain("https://sample-business.example.test/mcp");
    // What was not read is not shown as empty: no health, no test, no operations.
    expect(healthOf(failed)).toBeUndefined();
    expect(failed).not.toContain("Test connection");
    expect(failed).not.toContain("This connection has no accepted operation.");
    expect(
      renderPage({
        detailRead: { status: "failed", message: "The instance is busy.", retry: noop }
      })
    ).toContain("The instance is busy.");

    const loading = renderPage({ detailRead: { status: "loading" } });
    expect(loading).toContain(">Sample business</h1>");
    expect(healthOf(loading)).toBeUndefined();

    // The asset itself: missing and refused say so in the frame's words.
    expect(renderPage({ assetRead: { status: "missing" } })).toContain(
      "There is no connection with the id sample-business."
    );
    expect(renderPage({ assetRead: { status: "missing" }, locale: "de" })).toContain(
      "Es gibt keine Verbindung mit der Kennung sample-business."
    );
    expect(renderPage({ assetRead: { status: "refused" } })).toContain(
      "You may not read this asset."
    );
  });

  it("has no section on additional use rights for a reader who is not shown rights", () => {
    const markup = renderPage();
    expect(markup).not.toContain("Additional use rights");
    expect(markup).not.toContain('id="access"');
  });

  it("lists the service principals that may use it beside the people, told apart and linked", () => {
    const markup = renderPage({
      holders: {
        status: "ready",
        holders: [
          {
            grantId: "g1",
            kind: "person",
            id: "user_kai",
            name: "Kai Example",
            detail: "kai@example.test",
            disabled: false
          },
          {
            grantId: "g2",
            kind: "service_principal",
            id: "spn_1",
            name: "Monthly check",
            detail: "monthly-check",
            disabled: true
          }
        ]
      }
    });
    expect(markup).toContain('id="access"');
    expect(markup).toContain(">Additional use rights<");
    const person = /<li[^>]*data-holder-kind="person".*?<\/li>/su.exec(markup)?.[0] ?? "";
    const service =
      /<li[^>]*data-holder-kind="service_principal".*?<\/li>/su.exec(markup)?.[0] ?? "";
    // A person is a round avatar with an address and no link.
    expect(person).toContain('data-kind="person"');
    expect(person).toContain("kai@example.test");
    expect(person).not.toContain("<a ");
    // A service principal is a square one, says what it is in words and opens its page.
    expect(service).toContain('data-kind="service"');
    expect(service).toContain(">Service principal<");
    expect(service).toContain(">Disabled<");
    expect(service).toContain('href="/settings/instance/api-access?principal=spn_1"');
    expect(service).not.toContain("monthly-check");
  });

  // The list holds rights on the Connection itself; workspace members use it through Available
  // in, so an empty list never reads as "nobody may use it".
  it("says the list holds additional rights only, and that members use it through Available in", () => {
    const markup = renderPage({ holders: { status: "ready", holders: [] } });
    expect(markup).toContain("Nobody has an additional right on this Connection.");
    expect(markup).toContain("Workspace members use it through Available in");
    expect(markup).not.toContain("Who may use it");
    expect(markup).not.toContain("Access page");
    const german = renderPage({ holders: { status: "ready", holders: [] }, locale: "de" });
    expect(german).toContain("Zusätzliche Nutzungsrechte");
    expect(german).toContain("über „Verfügbar in“");
    expect(german).not.toContain("Seite Zugriff");
  });
  it("shows the whole new description of an operation whose description is accepted again", () => {
    const runtime = connectionAsset("ledger", { origin: "runtime" });
    const markup = renderPage({
      asset: runtime,
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
    expect(row).toContain("Accept");
    // Whoever accepts the new description reads all of what the model will read.
    expect(row).toMatch(
      /<p class="(?![^"]*line-clamp)[^"]*">Changes one customer\.[^<]*The fourth line\.</u
    );
  });

  it("lets a writer change a Connection made on the instance: settings, key and tools", () => {
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
    expect(markup).not.toContain("data-build-read-only");
    expect(markup).toContain(">Edit<");
    expect(markup).toContain(">Enter the key<");
    // The next step is the editor's, not the operator's.
    expect(markup).toContain("Enter the key under Credential. Then test again.");
    expect(markup).not.toContain("The operator supplies the credential");
    // The discovered tools wait in one list with one confirmation: the reading one is ticked,
    // the changing one is not, and agents may use what is approved.
    const row = (name: string) =>
      new RegExp(`data-approval-tool="${name}"[\\s\\S]*?</li>`, "u").exec(markup)?.[0] ?? "";
    expect(row("list_invoices")).toContain('aria-checked="true"');
    expect(row("void_invoice")).toContain('aria-checked="false"');
    expect(row("void_invoice")).toContain(">changes<");
    const surface = (name: string) =>
      new RegExp(`<button[^>]*data-approval-surface="${name}"[^>]*>`, "u").exec(markup)?.[0] ?? "";
    expect(surface("agent")).toContain('aria-checked="true"');
    expect(surface("workflow")).toContain('aria-checked="false"');
    expect(markup).toContain("1 of 2 selected");
    expect(markup).toMatch(/data-connection-approve=""[^>]*>Approve 1 tool</u);
    expect(markup).toContain("Changing tools ask before every call.");
    expect(markup).not.toContain("data-connection-accept");
    // Whoever approves it reads all of what the model will read, not three lines of it.
    expect(markup).toMatch(
      /<span class="(?![^"]*line-clamp)[^"]*">Lists the invoices[^<]*The fourth line\.</u
    );
    // An accepted operation can be taken off; the menu holds Delete.
    expect(markup).toContain('data-connection-remove="revenue_by_month"');
    expect(markup).toContain('aria-label="More actions"');
    // Nothing of the key stands on the page, and no field is filled from one.
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain(FIXTURE_SECRET_HANDLE);

    // A reader who may not write sees the page without a control that changes it.
    const reader = renderPage({ asset: runtime, detail, canWrite: false });
    for (const control of [
      ">Edit<",
      ">Enter the key<",
      "data-connection-approve",
      "data-connection-remove"
    ]) {
      expect(reader, control).not.toContain(control);
    }
    const german = renderPage({ asset: runtime, detail, locale: "de" });
    expect(german).toContain("Gib den Schlüssel unter Zugangsdaten ein. Teste danach erneut.");
    expect(german).toContain("Nutzen dürfen");
    expect(german).toContain("1 Tool freigeben");
  });

  it("offers a managed Connection set up from an earlier entry version the update, to whoever may change it (MS-APP-RELINK)", () => {
    // The mailbox entry at version 2 on the operator's managed client; the Connection was set up
    // from version 1, before the entry named its revocation address.
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
    const markup = renderPage({ asset: stale, entries: [entry] });
    expect(markup).toContain("data-connection-catalogue-update");
    expect(markup).toContain("Set up from an earlier version of Mailbox");
    expect(markup).toContain(
      "This connection was set up from version 1, and version 2 is available here."
    );
    expect(markup).toMatch(/data-connection-catalogue-update-apply=""[^>]*>Update to version 2</u);
    // Which settings change stands folded under the text.
    expect(markup).toContain("Settings that change");
    const german = renderPage({ asset: stale, entries: [entry], locale: "de" });
    expect(german).toContain("Mit einer früheren Version von Postfach eingerichtet");
    expect(german).toContain("Auf Version 2 aktualisieren");
    // A reader who may not change it, and a Connection at the current version, get no offer.
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
    // What the instance records after a save: nothing shared to use, so waiting for configuration.
    const detail = (registration: "managed" | "preregistered") => ({
      health: "needs_configuration" as const,
      secret: { state: "not_set" as const },
      sharedCredential: false,
      oauth: { registration, providerHost: "login.example.test" }
    });
    const managed = renderPage({ asset: personal, detail: detail("managed"), settings: true });
    expect(managed).toContain('data-connection-health="personal"');
    expect(managed).toContain(">Each person connects<");
    expect(managed).toContain("The app registration is already set up.");
    expect(managed).not.toContain("Not configured");
    expect(managed).not.toContain("Enter the key under Credential");
    // Nor a shared sign-in nobody is meant to make.
    expect(managed).not.toContain('data-sign-in-state="none"');
    const german = renderPage({
      asset: personal,
      detail: detail("managed"),
      locale: "de",
      settings: true
    });
    expect(german).toContain(">Jede Person verbindet sich<");
    expect(german).toContain("Die App-Registrierung ist bereits eingerichtet.");
    expect(german).not.toContain("Nicht konfiguriert");
    const own = renderPage({ asset: personal, detail: detail("preregistered"), settings: true });
    expect(own).toContain(">Each person connects<");
    expect(own).toContain("There is no key to enter here.");
    expect(own).not.toContain("The app registration is already set up.");
    // The list row says the same.
    expect(listedHealth("needs_configuration", true)).toBe("personal");
    expect(listedHealth("needs_configuration")).toBe("not_configured");
  });

  it("names the settings of a REST API in words, in English and in German", () => {
    const rest = connectionAsset("exampledata", {
      connectorType: "http_api",
      settings: { baseUrl: "https://gateway.example.test/api", testPath: "/health" }
    });
    const markup = renderPage({ asset: rest });
    for (const label of [">REST API<", ">Base address<", ">Test path<", ">Bearer token<"]) {
      expect(markup, label).toContain(label);
    }
    for (const raw of [">http_api<", ">baseUrl<", ">testPath<", ">bearer<"]) {
      expect(markup, raw).not.toContain(raw);
    }
    const german = renderPage({ asset: rest, locale: "de" });
    for (const label of [">REST-API<", ">Basisadresse<", ">Testpfad<", ">Bearer-Token<"]) {
      expect(german, label).toContain(label);
    }
    expect(german).toContain("Technische Details");
  });

  it("adds the tools of a REST API by pasting them or drafting them in the chat, never by discovery", () => {
    const rest = connectionAsset("exampledata", {
      origin: "runtime",
      connectorType: "http_api",
      settings: { baseUrl: "https://gateway.example.test/datevconnect" }
    });
    const markup = renderPage({ asset: rest, detail: { operations: [] } });
    expect(markup).toContain("Add tools");
    expect(markup).toContain("data-connection-paste");
    // Without a chat beside the page there is nothing to draft in.
    expect(markup).not.toContain("data-connection-draft");
    expect(markup).not.toContain("Discovered tools");
    expect(renderPage({ asset: rest, detail: { operations: [] }, locale: "de" })).toContain(
      "Du hast die Tools schon als YAML."
    );
    expect(renderPage({ asset: rest, canWrite: false })).not.toContain("data-connection-paste");
  });

  it("offers a writer four check boxes per operation, for agents, Apps, Workflows and outside clients", () => {
    const runtime = connectionAsset("ledger", { origin: "runtime" });
    const markup = renderPage({ asset: runtime });
    const box = (name: string) => {
      const match = new RegExp(`<button[^>]*data-connection-outside="${name}"[^>]*>`, "u").exec(
        markup
      );
      expect(match, name).not.toBeNull();
      return match?.[0] ?? "";
    };
    expect(markup).toContain("Outside clients (CLI, MCP)");
    // The note on leaving the instance stands only under the one box that is ticked.
    expect(
      markup.split("What a call returns is copied to the computer that holds the key.")
    ).toHaveLength(2);
    // Ticked only where the operation names `outside`, which no operation does by itself.
    expect(box("list_customers")).toContain('aria-checked="true"');
    for (const name of ["revenue_by_month", "update_customer", "top_products", "delete_order"]) {
      expect(box(name), name).toContain('aria-checked="false"');
    }
    // Agents, Apps and Workflows are ticked as the operation names them.
    const exposure = (surface: string, name: string) =>
      new RegExp(`<button[^>]*data-connection-exposure="${surface}:${name}"[^>]*>`, "u").exec(
        markup
      )?.[0] ?? "";
    expect(exposure("bridge", "list_customers")).toContain('aria-checked="true"');
    expect(exposure("workflow", "delete_order")).toContain('aria-checked="true"');
    expect(exposure("bridge", "revenue_by_month")).toContain('aria-checked="false"');
    expect(exposure("agent", "revenue_by_month")).toContain('aria-checked="true"');
    const german = renderPage({ asset: runtime, locale: "de" });
    expect(german).toContain("Externe Clients (CLI, MCP)");
    expect(german).toContain(">Apps<");
    // A reader who may not write, and a Connection of the release config, get no box.
    expect(renderPage({ asset: runtime, canWrite: false })).not.toContain(
      "data-connection-outside"
    );
    expect(renderPage()).not.toContain("data-connection-outside");
    expect(renderPage()).not.toContain("data-connection-exposure");
  });

  describe("person context", () => {
    const mapped = (settings: Record<string, unknown>, origin = "runtime") =>
      connectionAsset("records", {
        origin,
        connectorType: "http_api",
        authScheme: "none",
        settings: { baseUrl: "https://records.example.test/api", ...settings }
      });

    it("offers a writer the mappings of a REST API that sends a person context header", () => {
      const markup = renderPage({ asset: mapped({ personContextHeader: "X-Person-Ref" }) });
      expect(markup).toContain('id="person-context"');
      expect(markup).toContain("data-connection-person-context");
      expect(markup).toContain("X-Person-Ref");
      // The setting reads by its human label, not the raw key that overflows the label column.
      expect(markup).toContain("Person context header");
      expect(markup).not.toContain('<code class="font-mono">personContextHeader</code>');
      expect(markup).toContain("A call for someone without a mapping is refused.");
      expect(markup).toContain('data-connection-field="personContextSubject"');
      expect(markup).toContain("Choose a person");
      // A person is chosen by name: no technical ID field is offered beside the list.
      expect(markup).not.toContain('data-connection-field="personContextSubjectId"');
      expect(markup).toContain("Service principal");
      // Nothing is read before an admin names a subject.
      expect(markup).not.toContain("data-person-context-mapping");
      const german = renderPage({
        asset: mapped({ personContextHeader: "X-Person-Ref" }),
        locale: "de"
      });
      expect(german).toContain("Personenkontext");
      expect(german).toContain("Niemand wird automatisch zugeordnet.");
    });

    it("says why a reader who may not list people gets no list, and keeps the ID behind a disclosure", () => {
      const asset = mapped({ personContextHeader: "X-Person-Ref" });
      const hidden = renderPage({ asset, subjects: { status: "hidden" } });
      expect(hidden).toContain('data-person-context-list="hidden"');
      expect(hidden).toContain("Choosing a person by name needs the right to manage users.");
      expect(hidden).toContain("Enter a technical ID instead");
      // The disclosure starts closed: nobody is asked to copy an ID by default.
      expect(hidden).not.toContain('data-connection-field="personContextSubjectId"');
      expect(hidden).not.toContain('data-connection-field="personContextSubject"');
      expect(renderPage({ asset, subjects: { status: "hidden" }, locale: "de" })).toContain(
        "Stattdessen eine technische ID eingeben"
      );
    });

    it("shows the list loading, failing with a retry, and empty", () => {
      const asset = mapped({ personContextHeader: "X-Person-Ref" });
      const loading = renderPage({ asset, subjects: { status: "loading" } });
      expect(loading).not.toContain('data-connection-field="personContextSubject"');
      expect(loading).toContain('id="person-context"');
      const failed = renderPage({ asset, subjects: { status: "failed", retry: noop } });
      expect(failed).toContain("The list could not be loaded.");
      expect(failed).toContain("Try again");
      const empty = renderPage({ asset, subjects: { status: "ready", subjects: [] } });
      expect(empty).toContain('data-person-context-list="empty"');
      expect(empty).toContain("There are no people yet.");
    });

    it("offers the mappings on a release Connection too, since they are instance data", () => {
      expect(
        renderPage({ asset: mapped({ personContextHeader: "X-Person-Ref" }, "release") })
      ).toContain('id="person-context"');
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

    it("keeps the header through an edit of the settings and counts its change", () => {
      const config = mapped({ personContextHeader: "X-Person-Ref", testPath: "/health" }).config;
      expect(personContextHeaderOf(config)).toBe("X-Person-Ref");
      const form = connectionConfigToForm(config);
      expect(form.personContextHeader).toBe("X-Person-Ref");
      const kept = withConnectionForm(config, { ...form, url: "https://records.example.test/v2" });
      expect(kept.settings).toEqual({
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
  });
});
