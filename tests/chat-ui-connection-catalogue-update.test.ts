import { describe, expect, it } from "vitest";
import {
  catalogueUpdateOf,
  changedSettings,
  managedSettings,
  type CatalogueEntryOffer
} from "@work-shape/catalyst-chat-ui/build-area";
import {
  connectorTypeOffers,
  createCatalogue,
  createHttpApiConnectorType,
  loadCatalogueEntries,
  type ManagedOAuthClients
} from "@work-shape/catalyst-connections";
import { AppError, createConnectorTypeRegistry, type JsonValue } from "@work-shape/catalyst-core";
import { z } from "zod";
import { required } from "./support/assertions";

// MS-APP-RELINK: a Connection on the operator's managed OAuth client keeps its catalogue part's
// settings exactly (MS-APP-1), and the instance knows only the version of the entry it ships.
// One installed from an earlier version is offered the update on its page, which writes the
// current version's settings; every other change waits for it. These tests fail where the page
// would offer settings the instance refuses, where a stale or altered link would pass the
// guard, or where an update would be offered to a Connection that needs none.

const sampleResultShapers = { "sample.customers": (result: JsonValue) => result };
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
  it("is refused every change but the update, whose settings the instance takes as they are", () => {
    const { catalogue, entries, part } = instance();
    const stale = installedAtVersion1(part);
    expect(catalogue.managedClientIssue(stale)).toMatch(/^catalogue_update_required: /u);
    // A change of anything else, such as turning its tool off, waits for the update.
    const toolOff = {
      ...stale,
      operations: stale.operations.map((operation) => ({ ...operation, enabled: false }))
    };
    expect(refusalReason(() => catalogue.prepareConnection(toolOff))).toBe(
      "catalogue_update_required"
    );

    const update = required(catalogueUpdateOf(stale, entries));
    expect(update.from).toBe(1);
    expect(update.entry.version).toBe(2);
    expect(update.config.catalogue).toEqual({ entry: "sample-oauth", part: "tools", version: 2 });
    // Only what version 2 changed; the scopes follow from the operations as before.
    expect(update.changed).toEqual(["oauth.adminConsent"]);
    expect(update.config.operations).toEqual(stale.operations);
    expect(catalogue.managedClientIssue(update.config)).toBeUndefined();
    const prepared = catalogue.prepareConnection(update.config);
    expect(settingsSchema.parse(prepared.settings).oauth.scopes).toEqual(
      settingsSchema.parse(update.config.settings).oauth.scopes
    );
    expect(settingsSchema.parse(prepared.settings).oauth.scopes).toEqual([
      "sample.identity",
      "sample.read"
    ]);
  });

  it("keeps the guard: no relinked write may name settings that are not the entry's", () => {
    const { catalogue, entries, part } = instance();
    const update = required(catalogueUpdateOf(installedAtVersion1(part), entries));
    const settings = settingsSchema.parse(update.config.settings);
    // The current version's link with a token endpoint of the admin's choosing: refused.
    const moved = {
      ...update.config,
      settings: {
        ...settings,
        oauth: { ...settings.oauth, tokenUrl: `${settings.oauth.tokenUrl}/elsewhere` }
      }
    };
    expect(catalogue.managedClientIssue(moved)).toMatch(/^managed_client_unavailable: /u);
    expect(refusalReason(() => catalogue.prepareConnection(moved))).toBe(
      "managed_client_unavailable"
    );
    // The earlier version's link with the current settings, or with any other: still the update.
    for (const version of [1, 3]) {
      const linked = {
        ...update.config,
        catalogue: { entry: "sample-oauth", part: "tools", version }
      };
      expect(catalogue.managedClientIssue(linked)).toMatch(/^catalogue_update_required: /u);
    }
    // A link whose version is not a number is no link to the entry at all.
    const malformed = {
      ...update.config,
      catalogue: { entry: "sample-oauth", part: "tools", version: "2" }
    };
    expect(catalogue.managedClientIssue(malformed)).toMatch(/^managed_client_unavailable: /u);
    // At another name than the part's, the update does not pass either.
    expect(catalogue.managedClientIssue({ ...update.config, name: "second" })).toMatch(
      /^managed_client_unavailable: /u
    );
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
