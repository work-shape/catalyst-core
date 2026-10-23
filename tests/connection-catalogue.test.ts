import { sampleResultShapers } from "../clients/demo/src/result-shapers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  parseClientInstanceConfig,
  loadClientInstanceConfigFromFile,
  connectionConfigSchema,
  releaseConnectionsConfigSchema
} from "@work-shape/catalyst-config-schema";
import {
  createCatalogue,
  createEgressChecker,
  createFixtureDocumentSource,
  createHttpApiConnectorType,
  expandReleaseConnections,
  expandCataloguePart,
  loadCatalogueEntries,
  parseCatalogueEntry,
  type CatalogueEntry
} from "@work-shape/catalyst-connections";
import {
  CONNECTION_REFUSALS,
  asClientInstanceId,
  connectionCredentialOrigin,
  createConnectorTypeRegistry,
  type ConnectorTypeDefinition
} from "@work-shape/catalyst-core";
import { createConnectionAssetKind } from "@work-shape/catalyst-server";
import { errorSchema } from "./support/access-instance";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { generateSecretStoreKey } from "./support/test-connector";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { withTestSql } from "./support/test-sql";

// The Connection Catalogue (CAT-1): what an entry may hold, what an instance checks at its
// start, and what a Connection installed from an entry may say of its origin. An entry only
// recommends: these tests fail where an entry could enable an operation, expose it, grant a
// right, tick a changing operation, open a host without the operator naming it, or where a
// Connection could claim an entry the instance does not offer.

const DEMO = new URL("../clients/demo/catalogue", import.meta.url);
const SUITE = new URL("../clients/demo/e2e-catalogue", import.meta.url);

/** The browser suite's folder source, as the e2e catalogue's entry names it: a form, no calls. */
const folderSourceConnector: ConnectorTypeDefinition = {
  type: "test_folders",
  description: "Fixed folders. For tests.",
  settingsSchema: z
    .object({ accountId: z.string().min(1), region: z.literal("eu"), testFolderId: z.string() })
    .partial({ testFolderId: true })
    .strict(),
  authSchemes: ["client_credentials"],
  secretFields: ["clientSecret"],
  catalog: [],
  target: () => ({ protocol: "https", host: "127.0.0.1", port: 8443 }),
  test: () => Promise.resolve({ status: "ready" }),
  execute: () => Promise.reject(new Error("A folder source is not called.")),
  limits: { callTimeoutMs: 1000, resultMaxBytes: 1024, maxParallelCalls: 1 },
  form: {
    title: { en: "Test folders", de: "Testordner" },
    description: { en: "Fixed folders.", de: "Feste Ordner." },
    service: "test-folders",
    authScheme: "client_credentials",
    settings: { region: "eu" },
    fields: [
      { label: { en: "Account ID", de: "Konto-ID" }, setting: "accountId" },
      { label: { en: "Folder", de: "Ordner" }, setting: "testFolderId", optional: true },
      { label: { en: "Client secret", de: "Client-Secret" }, secret: true }
    ]
  },
  documentSource: createFixtureDocumentSource({ secret: "test", pageSize: 10 }).capability
};

const registry = () =>
  createConnectorTypeRegistry([createHttpApiConnectorType(), folderSourceConnector]);

const shipped = () => [...loadCatalogueEntries(DEMO), ...loadCatalogueEntries(SUITE)];

/** The smallest entry with a tools part over `http_api`, as YAML would give it. */
function entry(overrides: Record<string, unknown> = {}, tools: Record<string, unknown> = {}) {
  return {
    id: "ledger",
    version: 1,
    service: "ledger",
    title: { en: "Ledger", de: "Hauptbuch" },
    description: { en: "The books.", de: "Die Bücher." },
    category: "accounting",
    examplePrompts: [{ en: "Which clients?", de: "Welche Mandanten?" }],
    mark: { color: "#2f6f4f" },
    tools: {
      connectorType: "http_api",
      name: "ledger",
      description: { en: "Reads the books.", de: "Liest die Bücher." },
      authScheme: "bearer",
      settings: { baseUrl: "https://ledger.example.test/api" },
      fields: [{ secret: true, label: { en: "Key", de: "Schlüssel" } }],
      egress: [{ protocol: "https", host: "ledger.example.test", port: 443 }],
      sharedAccountNote: { en: "One shared key.", de: "Ein gemeinsamer Schlüssel." },
      operations: [
        {
          name: "listClients",
          description: "Lists the clients with their number.",
          effect: "reading",
          recommended: true,
          method: "GET",
          path: "/clients"
        },
        {
          name: "listPostings",
          description: "Lists the postings of all clients.",
          effect: "reading",
          method: "GET",
          path: "/postings"
        }
      ],
      ...tools
    },
    ...overrides
  };
}

/** The messages the release would stop with when it loads this entry. */
function refusalOf(value: unknown): string {
  try {
    parseCatalogueEntry(JSON.stringify(value), "ledger/entry.yaml");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const parsed = (value: unknown) => parseCatalogueEntry(JSON.stringify(value), "ledger/entry.yaml");

const catalogueOf = (entries: CatalogueEntry[], named: string[] = ["ledger"]) =>
  createCatalogue({ entries, named, connectorTypes: registry() });

describe("a catalogue entry", () => {
  it("holds no exposure, enabling, grant or agent: it only recommends", () => {
    const operations = (extra: Record<string, unknown>) => ({
      operations: [
        { name: "listClients", effect: "reading", method: "GET", path: "/clients", ...extra }
      ]
    });
    for (const [overrides, tools, field] of [
      [{}, operations({ exposure: ["agent"] }), "exposure"],
      [{}, operations({ enabled: true }), "enabled"],
      [{}, { grants: [{ action: "connection.use", holder: "everyone" }] }, "grants"],
      [{}, { exposure: ["agent"] }, "exposure"],
      [{ agents: ["assistant"] }, {}, "agents"],
      [{ enabled: true }, {}, "enabled"]
    ] as const) {
      expect(refusalOf(entry(overrides, tools))).toContain(field);
    }
    expect(refusalOf(entry())).toBe("");
  });

  it("ticks only a reading operation and tightens only a changing one", () => {
    expect(
      refusalOf(
        entry(
          {},
          {
            operations: [
              { name: "bookPosting", effect: "changing", recommended: true, method: "POST" }
            ]
          }
        )
      )
    ).toContain("Only a reading operation is recommended");
    expect(
      refusalOf(
        entry(
          {},
          {
            operations: [
              { name: "listClients", effect: "reading", policy: "approval", method: "GET" }
            ]
          }
        )
      )
    ).toContain("Only a changing operation can carry the policy 'approval'");
    // An operation an entry does not recommend is not ticked.
    const loaded = parsed(entry());
    expect(required(loaded.tools).operations.map((operation) => operation.recommended)).toEqual([
      true,
      false
    ]);
  });

  it("is never drawn like a vendor's logo: a readable colour, or a logo with its rights", () => {
    expect(refusalOf(entry({ mark: { color: "#ffd400" } }))).toContain("contrast");
    expect(refusalOf(entry({ mark: { logo: "logo.svg" } }))).toContain("rights");
    expect(refusalOf(entry({ mark: { color: "#2f6f4f", logo: "logo.svg" } }))).not.toBe("");
  });

  it("brings a tools part with operations, a source part without, and at least one part", () => {
    const source = required(entry().tools);
    expect(refusalOf(entry({ tools: undefined, source }))).toContain(
      "A source part has no operations"
    );
    expect(refusalOf(entry({}, { operations: [] }))).toContain("at least one operation");
    expect(refusalOf(entry({ tools: undefined }))).toContain("An entry brings tools, a source");
  });
});

describe("the catalogue of an instance", () => {
  it("offers what the operator names and opens only the hosts of named entries", () => {
    const named = createCatalogue({
      entries: shipped(),
      named: ["sample-accounting"],
      connectorTypes: registry()
    });
    expect(named.entries.map((view) => [view.id, view.offered])).toEqual([
      ["sample-accounting", true],
      ["sample-files", false],
      ["sample-oauth", false]
    ]);
    expect(named.egress.map((host) => `${host.host}:${host.port}`)).toEqual(["sample-mcp:8787"]);
    const none = createCatalogue({ entries: shipped(), named: [], connectorTypes: registry() });
    expect(none.egress).toEqual([]);
    expect(none.entries.every((view) => !view.offered)).toBe(true);
  });

  it("ticks only reading operations the entry recommends, and enables nothing", () => {
    const tools = required(
      required(catalogueOf(shipped(), ["sample-accounting"]).entries[0]).parts[0]
    );
    expect(tools.operations.map((operation) => [operation.name, operation.recommended])).toEqual([
      ["listClients", true],
      ["listFiscalYears", true],
      ["listAccountPostings", false]
    ]);
    for (const operation of tools.operations) {
      expect(operation).not.toHaveProperty("enabled");
      expect(operation).not.toHaveProperty("exposure");
      expect(operation.declaration ?? {}).not.toHaveProperty("enabled");
      expect(operation.declaration ?? {}).not.toHaveProperty("exposure");
    }
  });

  it("takes a source part's fields from its Connector type's form", () => {
    const files = required(
      catalogueOf(shipped(), []).entries.find((view) => view.id === "sample-files")
    );
    const source = required(files.parts[0]);
    expect(source).toMatchObject({
      part: "source",
      connectorType: "test_folders",
      authScheme: "client_credentials",
      settings: { region: "eu" },
      documentSource: true,
      operations: []
    });
    expect(source.fields.map((field) => field.setting ?? "secret")).toEqual([
      "accountId",
      "testFolderId",
      "secret"
    ]);
  });

  it("stops the start for an entry it cannot offer or a part that reaches past its hosts", () => {
    const ledger = parsed(entry());
    expect(() => catalogueOf([ledger], ["unknown"])).toThrow(
      "names 'unknown', an entry this release does not ship"
    );
    expect(() => catalogueOf([ledger, ledger])).toThrow("ships it more than once");
    const elsewhere = parsed(
      entry({}, { egress: [{ protocol: "https", host: "other.example.test", port: 443 }] })
    );
    expect(() => catalogueOf([elsewhere])).toThrow(
      "reaches ledger.example.test:443, which is not on its own egress list"
    );
    const unregistered = parsed(entry({}, { connectorType: "not_built" }));
    expect(() => catalogueOf([unregistered])).toThrow(
      "this build registers the Connector type of none of its parts"
    );
    // Not named, it is shown without parts and stops nothing.
    expect(catalogueOf([unregistered], []).entries[0]?.parts).toEqual([]);
    const keyless = parsed(entry({}, { fields: [] }));
    expect(() => catalogueOf([keyless])).toThrow(
      "asks for a secret exactly where its auth scheme sends one"
    );
  });

  it("refuses a Connector type whose form names its service in words", () => {
    const named: ConnectorTypeDefinition = {
      ...folderSourceConnector,
      type: "named_folders",
      form: { ...required(folderSourceConnector.form), service: "Box" }
    };
    expect(() => createConnectorTypeRegistry([named])).toThrow(
      "a service is a lowercase slug, such as 'box'"
    );
  });

  it("lets a Connection name only an offered entry, its part and the part's type", () => {
    const catalogue = createCatalogue({
      entries: shipped(),
      named: ["sample-accounting"],
      connectorTypes: registry()
    });
    const link = { entry: "sample-accounting", part: "tools", version: 1 } as const;
    expect(catalogue.linkIssue(link, "http_api")).toBeUndefined();
    for (const [other, type] of [
      [{ ...link, entry: "sample-files", part: "source" }, "test_folders"],
      [{ ...link, entry: "unknown" }, "http_api"],
      [{ ...link, part: "source" }, "http_api"],
      [link, "test_folders"],
      [{ ...link, version: 2 }, "http_api"]
    ] as const) {
      expect(catalogue.linkIssue(other, type)).toMatch(
        new RegExp(`^${CONNECTION_REFUSALS.catalogueEntryNotOffered}:`, "u")
      );
    }
  });
});

describe("release config from a catalogue entry (CAT-2)", () => {
  const release = (value: Record<string, unknown>) =>
    releaseConnectionsConfigSchema.parse({ books: value });

  it("loads a release file with fromEntry without requiring a connector type or auth scheme", async () => {
    const directory = await mkdtemp(join(tmpdir(), "catalogue-release-"));
    try {
      const path = join(directory, "release.yaml");
      await writeFile(
        path,
        JSON.stringify({
          ...createTestConfig(),
          catalogue: { entries: ["ledger"] },
          connections: { books: { fromEntry: "ledger", secret: "LEDGER_KEY" } }
        })
      );
      const config = await loadClientInstanceConfigFromFile(path);
      expect(
        expandReleaseConnections(config.connections, catalogueOf([parsed(entry())])).books
      ).toMatchObject({
        connectorType: "http_api",
        authScheme: "bearer",
        catalogue: { entry: "ledger", part: "tools", version: 1 },
        operations: [{ name: "listClients" }, { name: "listPostings" }]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("expands a valid fromEntry, defaults and overrides, with provenance and no exposure", () => {
    const catalogue = catalogueOf([
      parsed(
        entry(
          {},
          {
            settings: { baseUrl: "https://ledger.example.test/api", headers: { fixed: "kept" } },
            fields: [
              { secret: true, label: { en: "Key", de: "Schlüssel" } },
              {
                setting: "headers.account",
                label: { en: "Account", de: "Konto" },
                default: "default-account"
              }
            ]
          }
        )
      )
    ]);
    const expanded = expandReleaseConnections(
      release({
        fromEntry: "ledger",
        secret: "LEDGER_KEY",
        displayName: "Books",
        settings: { headers: { account: "my-account" } }
      }),
      catalogue
    );
    expect(expanded.books).toMatchObject({
      connectorType: "http_api",
      authScheme: "bearer",
      secret: "LEDGER_KEY",
      displayName: "Books",
      service: "ledger",
      catalogue: { entry: "ledger", part: "tools", version: 1 },
      settings: {
        baseUrl: "https://ledger.example.test/api",
        headers: { fixed: "kept", account: "my-account" }
      },
      operations: [
        { name: "listClients", method: "GET", path: "/clients", effect: "reading", exposure: [] },
        { name: "listPostings", path: "/postings", exposure: [] }
      ]
    });
    expect(
      expandReleaseConnections(release({ fromEntry: "ledger", operations: [] }), catalogue).books
        ?.operations
    ).toEqual([]);
  });

  it("refuses an unknown entry and an entry the operator has not offered", () => {
    expect(() =>
      expandReleaseConnections(release({ fromEntry: "unknown" }), catalogueOf([parsed(entry())]))
    ).toThrow("catalogue entry 'unknown': unknown entry");
    expect(() =>
      expandReleaseConnections(release({ fromEntry: "ledger" }), catalogueOf([parsed(entry())], []))
    ).toThrow("catalogue entry 'ledger': not offered");
  });

  it("refuses a part whose Connector type this build does not register", () => {
    const source = required(loadCatalogueEntries(SUITE)[0]).source;
    const catalogue = createCatalogue({
      entries: [parsed(entry({ source }))],
      named: ["ledger"],
      connectorTypes: createConnectorTypeRegistry([createHttpApiConnectorType()])
    });
    expect(catalogue.entries[0]?.parts.map((part) => part.part)).toEqual(["tools"]);
    expect(() =>
      expandReleaseConnections(release({ fromEntry: "ledger", part: "source" }), catalogue)
    ).toThrow("catalogue entry 'ledger': the 'source' part is not offered");
  });

  it("requires a choice for two offered parts and expands a source from its type's form", () => {
    const source = required(loadCatalogueEntries(SUITE)[0]).source;
    // This registry includes the form of the test folder source.
    const withSource = createCatalogue({
      entries: [parsed(entry({ source }))],
      named: ["ledger"],
      connectorTypes: registry()
    });
    expect(() => expandReleaseConnections(release({ fromEntry: "ledger" }), withSource)).toThrow(
      "choose a part explicitly"
    );
    expect(
      expandReleaseConnections(
        release({
          fromEntry: "ledger",
          part: "source",
          settings: { accountId: "account", region: "eu" },
          secret: "SOURCE_SECRET"
        }),
        withSource
      ).books
    ).toMatchObject({
      connectorType: "test_folders",
      authScheme: "client_credentials",
      operations: [],
      catalogue: { entry: "ledger", part: "source", version: 1 }
    });
  });
});

describe("a write of a Connection's catalogue link", () => {
  const catalogue = createCatalogue({
    entries: shipped(),
    named: ["sample-accounting"],
    connectorTypes: registry()
  });
  const kind = (offered = true) =>
    createConnectionAssetKind({
      connectorTypes: registry(),
      egress: createEgressChecker({ allow: [], resolve: () => Promise.resolve([]) }),
      ...(offered ? { catalogue } : {})
    });
  const link = { entry: "sample-accounting", part: "tools", version: 1 };
  const definition = (overrides: Record<string, unknown> = {}) => ({
    name: "sample-accounting",
    displayName: "Sample accounting",
    connectorType: "http_api",
    settings: { baseUrl: "http://sample-mcp:8787/rest" },
    authScheme: "bearer",
    operations: [],
    enabled: true,
    catalogue: link,
    ...overrides
  });
  const write = (
    next: Record<string, unknown>,
    current: Record<string, unknown> | undefined,
    offered = true
  ) => kind(offered).prepareInteractiveUpsert({ current, next, principalId: "user-1" });

  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it("is refused for an entry the instance does not offer, or a part of another type", () => {
    expect(() => write(definition(), undefined)).not.toThrow();
    for (const next of [
      definition({ catalogue: { entry: "sample-files", part: "source", version: 1 } }),
      definition({ catalogue: { ...link, entry: "unknown" } }),
      definition({ connectorType: "test_folders" })
    ]) {
      expect(refusal(() => write(next, undefined))).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: CONNECTION_REFUSALS.catalogueEntryNotOffered }
      });
    }
    // Without a catalogue an instance offers nothing.
    expect(refusal(() => write(definition(), undefined, false))).toMatchObject({
      details: { reason: CONNECTION_REFUSALS.catalogueEntryNotOffered }
    });
  });

  it("keeps a link that stays as it was, and lets it go", () => {
    const stored = definition({
      connectorType: "test_folders",
      catalogue: { entry: "sample-files", part: "source", version: 1 }
    });
    const unchanged = { ...stored, displayName: "Renamed" };
    expect(() => write(unchanged, stored)).not.toThrow();
    expect(() => write(definition({ catalogue: undefined }), stored)).not.toThrow();
    // Changing the type under the link is a new claim, and refused.
    expect(refusal(() => write({ ...stored, connectorType: "http_api" }, stored))).toMatchObject({
      details: { reason: CONNECTION_REFUSALS.catalogueEntryNotOffered }
    });
  });
});

describe("an install on an assembled instance", () => {
  // Provision and migrate the file fixture during setup, outside any individual scenario.
  beforeAll(async () => {
    await fileTestDatabaseUrl();
  });
  const started: TestInstance[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((instance) => instance.close()));
  });

  async function start(connections: Record<string, unknown> = {}, oauth = false) {
    const key = generateSecretStoreKey();
    const config = parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: { assetManagement: { enabled: true }, connections: { enabled: true } },
      secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
      catalogue: { entries: ["sample-accounting", ...(oauth ? ["sample-oauth"] : [])] },
      connections
    });
    const instance = await createTestInstance({
      config,
      env: { CATALYST_SECRET_STORE_KEY: key },
      tools: [],
      connectorTypes: [folderSourceConnector],
      catalogue: shipped(),
      resultShapers: sampleResultShapers
    });
    started.push(instance);
    return instance;
  }

  const offersSchema = z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        offered: z.boolean(),
        parts: z.array(
          z.object({
            part: z.string(),
            operations: z.array(z.object({ name: z.string(), recommended: z.boolean() }))
          })
        )
      })
    )
  });

  it("stores a personal OAuth install and recalculates consent when another group is enabled", async () => {
    const instance = await start({}, true);
    const catalogue = createCatalogue({
      entries: shipped(),
      named: ["sample-oauth"],
      connectorTypes: createConnectorTypeRegistry([
        createHttpApiConnectorType(sampleResultShapers),
        folderSourceConnector
      ]),
      resultShapers: sampleResultShapers
    });
    const part = required(catalogue.entries.find((entry) => entry.id === "sample-oauth")?.parts[0]);
    const initial = {
      ...expandCataloguePart(part, {
        credentialMode: "user",
        operations: [],
        settings: { oauth: { clientId: "sample-client" } }
      }),
      name: "sample-oauth",
      displayName: "Sample OAuth",
      catalogue: { entry: "sample-oauth", part: "tools", version: 1 }
    };
    const put = (config: Record<string, unknown>, expectedRevision: number | null) =>
      instance.call("assets.put", {
        params: { kind: "connection", name: "sample-oauth" },
        payload: { config, expectedRevision }
      });
    const installed = await put(initial, null);
    expect(installed.statusCode, installed.body).toBe(200);
    const read = () =>
      instance.call("assets.get", { params: { kind: "connection", name: "sample-oauth" } });
    const stored = z
      .object({ revision: z.number(), config: z.record(z.string(), z.unknown()) })
      .parse((await read()).json());
    expect(stored.config).toMatchObject({
      credentialMode: "user",
      settings: { oauth: { scopes: ["sample.identity"] } }
    });
    const storedConfig = connectionConfigSchema.parse(stored.config);
    const type = required(registry().get("http_api"));
    const asset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId: asClientInstanceId("demo-local"),
        kind: "connection",
        name: "sample-oauth"
      })
    );
    const owner = await instance.stores.users.createUser({
      clientInstanceId: asClientInstanceId("demo-local"),
      displayLabel: "Sample OAuth owner",
      roles: ["user"],
      permissions: []
    });
    const key = {
      clientInstanceId: asClientInstanceId("demo-local"),
      connectionAssetId: asset.id,
      subject: `user:${owner.id}`
    };
    const binding = required(
      await instance.stores.connections.connectConnectionBinding({
        ...key,
        scheme: "oauth",
        userId: owner.id,
        grantedScopes: ["sample.identity"],
        secretHandle: "sec_sample_token_set",
        secretVersion: 1,
        origin: connectionCredentialOrigin(
          type.target(storedConfig.settings),
          type.oauthEndpoints?.(storedConfig.settings)
        ),
        expectedRowVersion: null
      })
    );
    const enabled = expandCataloguePart(part, {
      operations: [{ name: "listCustomers" }]
    }).operations;
    const edited = await put({ ...stored.config, operations: enabled }, stored.revision);
    expect(edited.statusCode, edited.body).toBe(200);
    expect(await instance.stores.connections.getConnectionBinding(key)).toMatchObject({
      state: "connected",
      rowVersion: binding.rowVersion,
      grantedScopes: ["sample.identity"],
      secretHandle: "sec_sample_token_set"
    });
    expect((await read()).json()).toMatchObject({
      config: {
        credentialMode: "user",
        secretHandle: stored.config.secretHandle,
        settings: {
          oauth: { clientId: "sample-client", scopes: ["sample.identity", "sample.read"] }
        }
      }
    });
  });

  it("seeds an OAuth fromEntry as shared with consent scopes and its registered shaper", async () => {
    const instance = await start(
      { sample: { fromEntry: "sample-oauth", settings: { oauth: { clientId: "sample-client" } } } },
      true
    );
    const stored = await instance.call("assets.get", {
      params: { kind: "connection", name: "sample" }
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json()).toMatchObject({
      config: {
        credentialMode: "shared",
        authScheme: "oauth",
        settings: { oauth: { scopes: ["sample.identity", "sample.read"] } },
        operations: [
          { name: "listCustomers", shaper: "sample.customers", query: { top: { sendAs: "$top" } } }
        ]
      }
    });
  });

  it("seeds an expanded release entry and keeps its catalogue link on a repeated seed", async () => {
    const instance = await start({
      books: { fromEntry: "sample-accounting", secret: "SAMPLE_KEY" }
    });
    const read = () =>
      instance.call("assets.get", { params: { kind: "connection", name: "books" } });
    const first = await read();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      config: {
        name: "books",
        origin: "release",
        service: "sample-accounting",
        catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
        settings: {
          baseUrl: "http://sample-mcp:8787/rest",
          headers: { "x-client-instance-id": "demo-local" }
        },
        operations: [
          { name: "listClients", exposure: [] },
          { name: "listFiscalYears", exposure: [] },
          { name: "listAccountPostings", exposure: [] }
        ]
      }
    });
    const revision = z.object({ revision: z.number() }).parse(first.json()).revision;
    await start({ books: { fromEntry: "sample-accounting", secret: "SAMPLE_KEY" } });
    expect((await read()).json()).toMatchObject({ revision });
  });

  it("installs an entry anew at the address of a deleted Connection, with none of its access", async () => {
    const instance = await start();
    const clientInstanceId = asClientInstanceId("demo-local");
    const name = "sample-accounting";
    const definition = {
      name,
      displayName: "Beispielbuchhaltung",
      service: "sample-accounting",
      catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
      connectorType: "http_api",
      settings: { baseUrl: "http://sample-mcp:8787/rest" },
      authScheme: "bearer",
      operations: [],
      enabled: true
    };
    const put = (expectedRevision: number | null) =>
      instance.call("assets.put", {
        params: { kind: "connection", name },
        payload: { config: definition, expectedRevision }
      });
    const revisionSchema = z.object({ revision: z.number() });
    const first = await put(null);
    expect(first.statusCode, first.body).toBe(200);
    const asset = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name
      })
    );
    const person = await instance.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Someone",
      roles: ["user"],
      permissions: []
    });
    const rowsOn = () =>
      instance.stores.access.listGrants({
        clientInstanceId,
        scopeKind: "asset",
        scopeId: asset.id
      });
    for (const [action, effect] of [
      ["connection.use", "allow"],
      ["connection.read", "deny"]
    ] as const) {
      await instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: person.id,
        action,
        effect,
        scopeKind: "asset",
        scopeId: asset.id,
        grantedBy: person.id
      });
    }
    const deleted = await instance.call("assets.delete", {
      params: { kind: "connection", name },
      payload: { expectedRevision: revisionSchema.parse(first.json()).revision }
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    // The delete takes the allow and keeps the deny on the retained revisions.
    expect((await rowsOn()).map((row) => row.effect)).toEqual(["deny"]);

    // A fresh create is refused; the install names the delete's revision.
    expect((await put(null)).statusCode).toBe(412);
    const history = await instance.call("assets.revisions.list", {
      params: { kind: "connection", name },
      query: { limit: "1" }
    });
    const [latest] = z
      .object({ items: z.array(z.object({ revision: z.number(), operation: z.string() })) })
      .parse(history.json()).items;
    expect(latest?.operation).toBe("delete");
    const again = await put(required(latest).revision);
    expect(again.statusCode, again.body).toBe(200);
    const recreated = required(
      await instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name
      })
    );
    // The same row, with no access row of the earlier Connection left on it.
    expect(recreated.id).toBe(asset.id);
    expect(await rowsOn()).toEqual([]);
    // The lifted rows are a governance event: which Connection, who, how many; nothing more.
    const events = await instance.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "connection.access_reset"
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "success",
      subject: name,
      metadata: { connectionName: name, connectionId: asset.id, removedRows: 1 }
    });
    // The admin who installed, by their product id.
    expect(events[0]?.actor?.userId).toMatch(/^usr_/u);
    expect(Object.keys(events[0]?.metadata ?? {}).sort()).toEqual([
      "connectionId",
      "connectionName",
      "removedRows"
    ]);
  });

  it("offers the named entry, stores the link, enables nothing and grants nothing", async () => {
    const instance = await start();
    const offers = await instance.call("connections.connector_types");
    expect(offers.statusCode).toBe(200);
    const entries = offersSchema.parse(offers.json()).entries;
    expect(entries.map((view) => [view.id, view.offered])).toEqual([
      ["sample-accounting", true],
      ["sample-files", false],
      ["sample-oauth", false]
    ]);

    const grantsBefore = await withTestSql(
      (sql) => sql<{ count: string }[]>`select count(*)::text as count from permission_grants`
    );
    const put = (name: string, config: Record<string, unknown>) =>
      instance.call("assets.put", {
        params: { kind: "connection", name },
        payload: { config, expectedRevision: null }
      });
    const installed = await put("sample-accounting", {
      name: "sample-accounting",
      displayName: "Beispielbuchhaltung",
      service: "sample-accounting",
      catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
      connectorType: "http_api",
      settings: { baseUrl: "http://sample-mcp:8787/rest" },
      authScheme: "bearer",
      operations: [],
      enabled: true
    });
    expect(installed.statusCode, installed.body).toBe(200);
    const stored = await instance.call("assets.get", {
      params: { kind: "connection", name: "sample-accounting" }
    });
    expect(stored.json()).toMatchObject({
      config: {
        catalogue: { entry: "sample-accounting", part: "tools", version: 1 },
        operations: []
      }
    });
    const grantsAfter = await withTestSql(
      (sql) => sql<{ count: string }[]>`select count(*)::text as count from permission_grants`
    );
    expect(grantsAfter).toEqual(grantsBefore);

    // The entry the operator did not name is not installed.
    const refused = await put("sample-files", {
      name: "sample-files",
      displayName: "Beispieldateien",
      catalogue: { entry: "sample-files", part: "source", version: 1 },
      connectorType: "test_folders",
      settings: { accountId: "a", region: "eu" },
      authScheme: "client_credentials",
      operations: [],
      enabled: true
    });
    expect(refused.statusCode).toBe(422);
    expect(errorSchema.parse(refused.json()).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: CONNECTION_REFUSALS.catalogueEntryNotOffered }
    });
  });
});
