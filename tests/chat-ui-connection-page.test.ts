import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ConnectionDetail, LocaleCode } from "@vivd-catalyst/api-client";
import {
  buildAssetKinds,
  BuildAssetKindsProvider,
  BuildFrame,
  BuildNavigationProvider,
  ConnectionPage,
  resolveBuildRights,
  type BuildAsset,
  type BuildAssetRead,
  type BuildListedKind,
  type BuildSource,
  type ConnectionDetailRead,
  type ConnectionSource,
  type ConnectionTestRun
} from "@vivd-catalyst/chat-ui/build-area";
import { platformContext } from "./chat-ui-build-fixtures";
import {
  connectionAsset,
  connectionDetail,
  FIXTURE_SECRET_HANDLE,
  recordedStates,
  testResult
} from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Connection page against the answers of the contract, handed in where the instance's
// answers will stand. Every test here fails without the page: before it, the address of a
// Connection showed the list.

const connectionKind = buildAssetKinds.find((kind) => kind.kind === "connection");
if (!connectionKind || connectionKind.Editor !== undefined) {
  throw new Error("The platform registry has no connection entry that only lists.");
}
const listedConnections: BuildListedKind = connectionKind;

const noop = () => undefined;

interface PageInput {
  asset?: BuildAsset;
  /** What reading the asset answers, where it is not the asset. */
  assetRead?: BuildAssetRead;
  detail?: Partial<ConnectionDetail>;
  detailRead?: ConnectionDetailRead;
  run?: ConnectionTestRun;
  mayTest?: boolean;
  locale?: LocaleCode;
}

/** The page at the Connection's address, inside the frame, with fixed answers. */
function renderPage(input: PageInput = {}): string {
  const asset = input.asset ?? connectionAsset();
  const connections: ConnectionSource = {
    mayTest: () => input.mayTest ?? true,
    useDetail: (name) =>
      input.detailRead ?? { status: "ready", detail: connectionDetail(name, input.detail) },
    useTest: () => ({ run: input.run ?? { status: "idle" }, start: noop })
  };
  const context = platformContext();
  const source: BuildSource = {
    kinds: [
      { kind: "agent", canCreate: false, canDelete: false },
      { kind: "connection", canCreate: true, canDelete: true }
    ],
    rights: resolveBuildRights({ permissions: ["config_assets.write"] }, context),
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
    writes: {
      put: async () => ({ revision: 1 }),
      delete: async () => undefined,
      revert: async () => ({ revision: 1 }),
      revisions: async () => ({ items: [] })
    }
  };
  const viewed: BuildListedKind = {
    ...listedConnections,
    view: {
      missingText: "connections.missing",
      Page: (frame) => createElement(ConnectionPage, { ...frame, source: connections })
    }
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
          createElement(BuildFrame, { source })
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
  it("shows whom the Connection belongs to and that release config defines it, with nothing to edit", () => {
    const markup = renderPage();

    expect(markup).toContain(">Sample business</h1>");
    expect(markup).toContain(">Connection<");
    expect(markup).toContain('title="sample-business"');
    expect(markup).toContain(">Instance<");
    expect(markup).toContain(
      "Connections come from the release config and cannot be changed here."
    );
    // Where it comes from is a sentence at the top of the page and no chip.
    expect(markup).not.toContain("Defined in release config");
    expect(markup).toContain("Enabled");
    expect(markup).toContain('aria-label="Back to Connections"');
    // Nothing on the page writes: no field, no History, no menu, no save. The one select is the
    // index of the sections on a narrow page.
    for (const control of ["<input", "<textarea", ">History<", "More actions", "Save"]) {
      expect(markup, control).not.toContain(control);
    }
    expect(renderPage({ locale: "de" })).toContain(
      "Verbindungen kommen aus der Release-Konfiguration und lassen sich hier nicht ändern."
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
    expect(other).toContain(">Workspace<");
    expect(other).toContain("This connection is disabled. Nothing can call it.");
    expect(markup).not.toContain("data-connection-disabled");
  });

  it("shows the settings and of the credential only whether it is there", () => {
    const markup = renderPage();

    expect(markup).toContain(">mcp<");
    expect(markup).toContain(">bearer<");
    expect(markup).toContain("https://sample-business.example.test/mcp");
    expect(markup).toContain(">timeoutSeconds<");
    expect(markup).toContain(">20<");
    expect(markup).toContain("Revenue, customers and orders of the sample business.");
    expect(markup).toContain('data-connection-credential="set"');
    expect(markup).toContain("Set, version 2");
    expect(markup).toContain(
      "The credential stays in the Secret Store. This page shows only whether it is there."
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
        "The instance may not reach this address. Its host is not in the list of allowed outside addresses in release config (egress.allow).",
        "Die Instanz darf diese Adresse nicht erreichen. Ihr Host steht nicht in der Liste der erlaubten externen Adressen der Release-Konfiguration (egress.allow)."
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
        "The credential of this connection is missing. Release config names where it comes from. Until it is there, no call reaches the outside system.",
        "Die Zugangsdaten dieser Verbindung fehlen. Die Release-Konfiguration nennt, woher sie kommen. Solange sie fehlen, erreicht kein Aufruf das externe System."
      ],
      [
        "secretUnreadable",
        "secret_unreadable",
        "A credential is stored, but the instance cannot read it. Until it is set again, no call reaches the outside system.",
        "Zugangsdaten sind gespeichert, aber die Instanz kann sie nicht lesen. Bis sie neu gesetzt sind, erreicht kein Aufruf das externe System."
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
        "The operator sets a new credential in the instance's environment and restarts the instance. Then test again.",
        "Der Betreiber setzt neue Zugangsdaten in der Umgebung der Instanz und startet die Instanz neu. Testen Sie danach erneut."
      ],
      [
        "networkDenied",
        "The operator adds the host to egress.allow in the release config and restarts the instance. Then test again.",
        "Der Betreiber trägt den Host in der Release-Konfiguration unter egress.allow ein und startet die Instanz neu. Testen Sie danach erneut."
      ],
      [
        "unavailable",
        "Check the address under Settings. It is changed in the release config.",
        "Prüfen Sie die Adresse unter Einstellungen. Sie wird in der Release-Konfiguration geändert."
      ],
      [
        "notConfigured",
        "The operator supplies the credential in the instance's environment and restarts the instance. Then test again.",
        "Der Betreiber stellt die Zugangsdaten in der Umgebung der Instanz bereit und startet die Instanz neu. Testen Sie danach erneut."
      ],
      [
        "secretUnreadable",
        "The operator restores the Secret Store key the credential was stored with, or supplies the credential again in the instance's environment, and restarts the instance. Then test again.",
        "Der Betreiber stellt den Secret-Store-Schlüssel wieder her, mit dem die Zugangsdaten gespeichert wurden, oder stellt die Zugangsdaten in der Umgebung der Instanz erneut bereit, und startet die Instanz neu. Testen Sie danach erneut."
      ],
      [
        "failedUnnamed",
        "Test again. If it fails again, ask the operator.",
        "Testen Sie erneut. Schlägt der Test wieder fehl, wenden Sie sich an den Betreiber."
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
    expect(unnamed).toContain("The test failed for a reason the instance does not name.");
    expect(unnamed).not.toContain("The outside system did not answer the test.");
    expect(renderPage({ detail: recordedStates.failedUnnamed, locale: "de" })).toContain(
      "Der Test ist aus einem Grund fehlgeschlagen, den die Instanz nicht nennt."
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
    expect(running).toContain("The instance is asking the outside system. This can take a moment.");
    expect(running).toContain('aria-busy="true"');
    expect(running).not.toContain("Last tested ");
    expect(renderPage({ run: { status: "running" }, locale: "de" })).toContain(
      "Die Instanz fragt das externe System an. Das kann einen Moment dauern."
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

  it("offers the test to whoever may run it and tells the others why not", () => {
    const allowed = renderPage();
    expect(allowed).toContain(">Test connection</button>");
    expect(allowed).not.toContain("data-connection-test-not-allowed");

    const readOnly = renderPage({ mayTest: false });
    expect(readOnly).not.toContain("Test connection");
    expect(readOnly).toContain(
      "You can read this connection. Testing it needs the right to change connections on the instance."
    );
    expect(renderPage({ mayTest: false, locale: "de" })).toContain(
      "Sie können diese Verbindung lesen. Zum Testen brauchen Sie das Recht, Verbindungen der Instanz zu ändern."
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

  it("lists the operations with effect, who may call them and their status", () => {
    const markup = renderPage();
    const row = (name: string) => {
      const start = markup.indexOf(`data-connection-operation="${name}"`);
      expect(start, name).toBeGreaterThan(-1);
      return markup.slice(start, markup.indexOf("</li>", start));
    };

    expect(row("revenue_by_month")).toContain("connection.sample-business.revenue_by_month");
    expect(row("revenue_by_month")).toContain("Returns the revenue of each month of one year.");
    expect(row("revenue_by_month")).toContain("Reading");
    expect(row("revenue_by_month")).toContain("Callable by");
    expect(row("revenue_by_month")).toContain(">Agents<");
    expect(row("revenue_by_month")).toContain("Ready");

    for (const caller of [">Agents<", ">Apps<", ">Workflows<"]) {
      expect(row("list_customers"), caller).toContain(caller);
    }
    expect(row("list_customers")).toContain("Awaiting discovery");
    expect(row("list_customers")).toContain(
      "The instance has not read this operation from the outside system yet."
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
    expect(row("delete_order")).toContain("Switched off in release config.");

    const german = renderPage({ locale: "de" });
    for (const text of ["Lesend", "Ändernd", "Aufrufbar durch", "Prüfung nötig", "Bereit"]) {
      expect(german, text).toContain(text);
    }
    expect(renderPage({ detail: { operations: [] } })).toContain(
      "This connection has no accepted operation."
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
});
