import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  connectorTypeOffers,
  createCatalogue,
  createHttpApiConnectorType,
  createManagedOAuthClients,
  expandReleaseConnections,
  managedPartSettings,
  parseCatalogueEntry,
  type ManagedOAuthClients
} from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry, type SecretResolver } from "@work-shape/catalyst-core";
import {
  infrastructureConfigSchema,
  releaseConnectionsConfigSchema
} from "@work-shape/catalyst-config-schema";
import { sampleResultShapers } from "@work-shape/catalyst-demo/result-shapers";
import { required } from "./support/assertions";

// MS-APP-1: the operator's managed OAuth clients. Release config names the client id and the
// host variable of its secret; the instance hands the client to the catalogue parts that ask
// for it, and to no other Connection.

const SECRET = "managed-client-secret-value-0123456789";
const SECRET_NAME = "SAMPLE_OAUTH_MANAGED_CLIENT_SECRET";
const source = readFileSync(
  new URL("../clients/demo/catalogue/sample-oauth/entry.yaml", import.meta.url),
  "utf8"
);
const sampleEntry = () => parseCatalogueEntry(source, "sample-oauth/entry.yaml");

function resolver(values: Record<string, string>): SecretResolver {
  return {
    resolve: async (name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`${name} is not set`);
      return value;
    }
  };
}

async function managed(values: Record<string, string> = { [SECRET_NAME]: SECRET }) {
  const logger = { warn: vi.fn() };
  const clients = await createManagedOAuthClients({
    clients: { sample: { clientId: "managed-client-id", credentialSecret: SECRET_NAME } },
    secrets: resolver(values),
    logger
  });
  return { clients, logger };
}

function catalogueWith(clients?: ManagedOAuthClients) {
  const connectorTypes = createConnectorTypeRegistry([
    createHttpApiConnectorType(sampleResultShapers, clients)
  ]);
  return createCatalogue({
    entries: [sampleEntry()],
    named: ["sample-oauth"],
    connectorTypes,
    resultShapers: sampleResultShapers,
    ...(clients === undefined ? {} : { managedClients: clients })
  });
}

/** The Connection the install of the sample part writes on the managed client. */
function installed(clients: ManagedOAuthClients, overrides: Record<string, unknown> = {}) {
  const part = required(catalogueWith(clients).entries[0]?.parts[0]);
  return {
    name: part.name,
    connectorType: "http_api",
    authScheme: "oauth",
    credentialMode: "user",
    catalogue: { entry: "sample-oauth", part: part.part, version: 1 },
    settings: managedPartSettings(part, "sample"),
    operations: [],
    ...overrides
  };
}

describe("release config of managed OAuth clients", () => {
  const parse = (oauthClients: unknown) =>
    infrastructureConfigSchema.safeParse({
      models: { local: { provider: "deterministic", region: "eu" } },
      oauthClients
    });

  it("takes a client id, the name of the host secret and a tenant", () => {
    const parsed = parse({
      microsoft: {
        clientId: "00000000-0000-0000-0000-000000000000",
        credentialSecret: "MICROSOFT_OAUTH_CLIENT_SECRET",
        tenant: "organizations"
      }
    });
    expect(parsed.success).toBe(true);
    expect(parse(undefined).data?.oauthClients).toEqual({});
  });

  it("refuses a secret value in place of its name, a bad id and fields it does not know", () => {
    for (const oauthClients of [
      { microsoft: { clientId: "id", credentialSecret: "v3ry~s3cret.value" } },
      { Microsoft: { clientId: "id", credentialSecret: SECRET_NAME } },
      { microsoft: { clientId: "id", credentialSecret: SECRET_NAME, clientSecret: "x" } },
      { microsoft: { clientId: "has spaces", credentialSecret: SECRET_NAME } },
      { microsoft: { clientId: "id", credentialSecret: SECRET_NAME, tenant: "a/b" } }
    ]) {
      expect(parse(oauthClients).success, JSON.stringify(oauthClients)).toBe(false);
    }
  });
});

describe("the managed clients of an instance", () => {
  it("hands out the client id, never the secret, and reads the secret anew on each use", async () => {
    const { clients, logger } = await managed();
    expect(clients.get("sample")).toEqual({ id: "sample", clientId: "managed-client-id" });
    expect(JSON.stringify(clients.get("sample"))).not.toContain(SECRET);
    expect(await clients.secret("sample")).toBe(SECRET);
    expect(clients.get("other")).toBeUndefined();
    await expect(clients.secret("other")).rejects.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("leaves out a client whose secret the host lacks, naming the variable and no value", async () => {
    const { clients, logger } = await managed({});
    expect(clients.get("sample")).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain(SECRET_NAME);
  });
});

describe("a catalogue part that asks for a managed client", () => {
  it("is offered on the managed client only where the instance has it", async () => {
    const { clients } = await managed();
    const withClient = required(catalogueWith(clients).entries[0]?.parts[0]);
    expect(withClient.managedClient).toBe("sample");
    // The own-app fields stay for an admin who chooses their own registration.
    expect(withClient.fields.map((field) => field.setting ?? "secret")).toEqual([
      "oauth.clientId",
      "secret"
    ]);
    const offers = JSON.stringify(
      connectorTypeOffers(
        createConnectorTypeRegistry([createHttpApiConnectorType(sampleResultShapers, clients)]),
        catalogueWith(clients),
        (name) => `http://localhost:5173/callback/${name}`
      )
    );
    expect(offers).not.toContain(SECRET);
    expect(offers).not.toContain(SECRET_NAME);
    expect(offers).not.toContain("managed-client-id");

    const { clients: missing } = await managed({});
    expect(required(catalogueWith(missing).entries[0]?.parts[0])).not.toHaveProperty(
      "managedClient"
    );
    expect(required(catalogueWith().entries[0]?.parts[0])).not.toHaveProperty("managedClient");
  });

  it("refuses a managed client on a part that does not sign in with OAuth", () => {
    const value = z
      .looseObject({ tools: z.record(z.string(), z.unknown()) })
      .parse(parseYaml(source));
    value.tools.authScheme = "bearer";
    value.tools.credentialModes = ["shared"];
    value.tools.defaultCredentialMode = "shared";
    delete value.tools.oauth;
    expect(() => parseCatalogueEntry(JSON.stringify(value), "entry.yaml")).toThrow(
      "managed OAuth client"
    );
  });

  it("signs in only the Connection installed from the part, at the part's name", async () => {
    const { clients } = await managed();
    const catalogue = catalogueWith(clients);
    expect(catalogue.managedClientIssue(installed(clients))).toBeUndefined();
    expect(() => catalogue.prepareConnection(installed(clients))).not.toThrow();
    for (const refused of [
      installed(clients, { name: "second-mailbox" }),
      installed(clients, { catalogue: undefined }),
      installed(clients, { catalogue: { entry: "sample-oauth", part: "tools", version: 2 } }),
      installed(clients, { catalogue: { entry: "other", part: "tools", version: 1 } })
    ]) {
      expect(catalogue.managedClientIssue(refused), JSON.stringify(refused)).toContain(
        "managed_client_unavailable"
      );
      expect(() => catalogue.prepareConnection(refused)).toThrow("managed_client_unavailable");
    }
    // A Connection with its own client id is none of this rule's business.
    const own = installed(clients, {
      name: "second-mailbox",
      settings: { ...installed(clients).settings, oauth: { clientId: "own" } }
    });
    expect(catalogue.managedClientIssue(own)).toBeUndefined();
  });

  it("refuses a release Connection that names the client outside its part", async () => {
    const { clients } = await managed();
    const catalogue = catalogueWith(clients);
    const { settings } = installed(clients);
    for (const connections of [
      // From the part, but under another name than the one redirect URI the operator registered.
      {
        elsewhere: { fromEntry: "sample-oauth", settings: { oauth: { managedClient: "sample" } } }
      },
      // Written out, with no part at all.
      {
        written: {
          connectorType: "http_api",
          authScheme: "oauth",
          settings,
          operations: []
        }
      }
    ]) {
      expect(
        () =>
          expandReleaseConnections(releaseConnectionsConfigSchema.parse(connections), catalogue),
        JSON.stringify(connections)
      ).toThrow("managed_client_unavailable");
    }
  });
});

describe("the http_api settings of a managed client", () => {
  const settings = (oauth: Record<string, unknown>) => ({
    baseUrl: "https://api.example.test",
    oauth: {
      authorizationUrl: "https://login.example.test/{tenant}/authorize",
      tokenUrl: "https://login.example.test/{tenant}/token",
      pathParams: { tenant: "common" },
      ...oauth
    }
  });

  it("signs in with the client's id and its tenant", async () => {
    const logger = { warn: vi.fn() };
    const clients = await createManagedOAuthClients({
      clients: {
        sample: { clientId: "managed-client-id", credentialSecret: SECRET_NAME, tenant: "tenant-a" }
      },
      secrets: resolver({ [SECRET_NAME]: SECRET }),
      logger
    });
    const type = createHttpApiConnectorType({}, clients);
    const value = settings({ managedClient: "sample" });
    expect(type.settingsSchema.safeParse(value).success).toBe(true);
    const endpoints = required(type.oauthEndpoints?.(value));
    expect(endpoints).toMatchObject({
      clientId: "managed-client-id",
      managedClient: "sample",
      authorizationUrl: "https://login.example.test/tenant-a/authorize",
      tokenUrl: "https://login.example.test/tenant-a/token"
    });
    expect(JSON.stringify(endpoints)).not.toContain(SECRET);
  });

  it("refuses a client the instance lacks, both clients at once, and neither", async () => {
    const { clients } = await managed();
    const type = createHttpApiConnectorType({}, clients);
    for (const oauth of [
      { managedClient: "other" },
      { managedClient: "sample", clientId: "own" },
      {}
    ]) {
      expect(type.settingsSchema.safeParse(settings(oauth)).success, JSON.stringify(oauth)).toBe(
        false
      );
    }
    const unmanaged = createHttpApiConnectorType({});
    const refused = unmanaged.settingsSchema.safeParse(settings({ managedClient: "sample" }));
    expect(JSON.stringify(refused.success ? [] : refused.error.issues)).toContain(
      "managed_client_unavailable"
    );
  });
});
