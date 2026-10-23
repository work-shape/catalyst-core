import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createCatalogue,
  createHttpApiConnectorType,
  expandCataloguePart,
  expandReleaseConnections,
  loadCatalogueEntries,
  parseCatalogueEntry
} from "@work-shape/catalyst-connections";
import { createConnectorTypeRegistry, type JsonValue } from "@work-shape/catalyst-core";
import { releaseConnectionsConfigSchema } from "@work-shape/catalyst-config-schema";
import { createConnectionAssetKind } from "@work-shape/catalyst-server";
import { sampleResultShapers } from "../clients/demo/src/result-shapers";
import { required } from "./support/assertions";

const directory = new URL("../clients/demo/catalogue", import.meta.url);
const file = new URL("sample-oauth/entry.yaml", directory.href + "/");
const source = readFileSync(file, "utf8");
const parse = (value: unknown) =>
  parseCatalogueEntry(JSON.stringify(value), "sample-oauth/entry.yaml");
const sample = () =>
  required(loadCatalogueEntries(directory).find((entry) => entry.id === "sample-oauth"));
const registry = () =>
  createConnectorTypeRegistry([createHttpApiConnectorType(sampleResultShapers)]);
const catalogue = () =>
  createCatalogue({
    entries: [sample()],
    named: ["sample-oauth"],
    connectorTypes: registry(),
    resultShapers: sampleResultShapers
  });
const part = () => required(catalogue().entries[0]?.parts[0]);

type MutableTools = {
  oauth: Record<string, JsonValue>;
  settings: Record<string, JsonValue>;
  fields: unknown[];
  groups: Record<string, JsonValue>[];
  operations: Record<string, JsonValue>[];
  authScheme: string;
  credentialModes: string[];
  defaultCredentialMode: string;
};
type MutableEntry = { tools: MutableTools; source?: MutableTools };

// YAML mutations keep the loader, including its strict no-secret boundary, in these checks.
function changed(change: (value: MutableEntry) => void) {
  const value: MutableEntry = parseYaml(source);
  change(value);
  return () => parse(value);
}

describe("OAuth catalogue parts", () => {
  it("loads the demo entry with personal and shared modes and resolves its client fields", () => {
    expect(sample().tools).toMatchObject({
      authScheme: "oauth",
      credentialModes: ["user", "shared"],
      defaultCredentialMode: "user"
    });
    expect(part().fields.map((field) => field.setting ?? "secret")).toEqual([
      "oauth.clientId",
      "secret"
    ]);
    expect(part().operations[0]?.declaration).toMatchObject({
      shaper: "sample.customers",
      query: { top: { sendAs: "$top" } }
    });
    expect(part().operations[0]?.declaration).not.toHaveProperty("group");
  });

  it("refuses OAuth hosts outside the part's egress, including revocation and issuer", () => {
    for (const field of ["authorizationUrl", "tokenUrl", "revocationUrl", "issuer"]) {
      expect(
        changed((value) => {
          value.tools.oauth[field] = "https://elsewhere.example.test/oauth";
        })
      ).toThrow("Every OAuth host");
    }
  });

  it("shares the live OAuth settings validation and permits no client secret in the entry", () => {
    expect(
      changed((value) => {
        value.tools.oauth.authorizationParams = { redirect_uri: "https://elsewhere.example.test" };
      })
    ).toThrow("set by the sign-in itself");
    expect(
      changed((value) => {
        value.tools.oauth.tokenUrl = "http://public.example.test/token";
      })
    ).toThrow("https address");
    expect(
      changed((value) => {
        value.tools.oauth.clientSecret = "not-a-secret";
      })
    ).toThrow();
    expect(
      changed((value) => {
        value.tools.fields = [];
      })
    ).toThrow("oauth.clientId and one client secret");
    expect(
      changed((value) => {
        value.tools.settings.oauth = { scopes: ["extra"] };
      })
    ).toThrow("not settings.oauth");
  });

  it("refuses personal sources, personal non-OAuth parts, missing identity and undeclared operation groups", () => {
    expect(
      changed((value) => {
        value.source = { ...value.tools, operations: [] };
        delete (value as Partial<MutableEntry>).tools;
      })
    ).toThrow("shared mode only");
    expect(
      changed((value) => {
        value.tools.authScheme = "bearer";
        Reflect.deleteProperty(value.tools, "oauth");
      })
    ).toThrow("Personal mode requires OAuth");
    expect(
      changed((value) => {
        value.tools.groups.shift();
      })
    ).toThrow("include identity");
    expect(
      changed((value) => {
        delete required(value.tools.operations[0]).group;
      })
    ).toThrow("declared group");
    expect(
      changed((value) => {
        required(value.tools.operations[0]).group = "absent";
      })
    ).toThrow("declared group");
    expect(
      changed((value) => {
        value.tools.defaultCredentialMode = "user";
        value.tools.credentialModes = ["shared"];
      })
    ).toThrow("default credential mode");
  });

  it("withholds a part whose shaper is unregistered, just as an unregistered type", () => {
    const options = { entries: [sample()], connectorTypes: registry() };
    expect(createCatalogue({ ...options, named: [] }).entries[0]?.parts).toEqual([]);
    expect(() => createCatalogue({ ...options, named: ["sample-oauth"] })).toThrow(
      "none of its parts"
    );
    expect(catalogue().entries[0]?.offered).toBe(true);
  });

  it("expands identity plus only enabled groups in runtime and shared release config", () => {
    const selected = [{ name: "listCustomers" }];
    expect(expandCataloguePart(part(), { operations: [] })).toMatchObject({
      credentialMode: "user",
      settings: { oauth: { scopes: ["sample.identity"] } },
      operations: []
    });
    expect(
      expandCataloguePart(part(), {
        operations: selected,
        settings: { oauth: { clientId: "sample-client" } }
      })
    ).toMatchObject({
      credentialMode: "user",
      settings: { oauth: { clientId: "sample-client", scopes: ["sample.identity", "sample.read"] } }
    });
    expect(
      expandCataloguePart(part(), { operations: [{ name: "listCustomers", enabled: false }] })
        .settings
    ).toMatchObject({ oauth: { scopes: ["sample.identity"] } });
    const expanded = expandReleaseConnections(
      releaseConnectionsConfigSchema.parse({
        sample: {
          fromEntry: "sample-oauth",
          settings: { oauth: { clientId: "sample-client", scopes: ["not-approved"] } },
          secret: "SAMPLE_CLIENT_SECRET",
          operations: []
        }
      }),
      catalogue()
    );
    expect(expanded.sample).toMatchObject({
      authScheme: "oauth",
      settings: { oauth: { scopes: ["sample.identity"] } },
      operations: []
    });
    expect(
      expandReleaseConnections(
        releaseConnectionsConfigSchema.parse({
          sample: {
            fromEntry: "sample-oauth",
            settings: { oauth: { clientId: "sample-client" } },
            secret: "SAMPLE_CLIENT_SECRET"
          }
        }),
        catalogue()
      ).sample
    ).toMatchObject({ settings: { oauth: { scopes: ["sample.identity", "sample.read"] } } });
  });

  it("widens scopes on an asset edit that enables a further group, without changing the client or mode", () => {
    const offered = catalogue();
    const kind = createConnectionAssetKind({
      catalogue: offered,
      connectorTypes: registry(),
      egress: { admits: () => true }
    });
    const initial = {
      ...expandCataloguePart(part(), {
        credentialMode: "user",
        operations: [],
        settings: { oauth: { clientId: "sample-client" } }
      }),
      name: "sample-oauth",
      displayName: "Sample OAuth",
      catalogue: { entry: "sample-oauth", version: 1, part: "tools" }
    };
    const saved = kind.prepareInteractiveUpsert({
      current: undefined,
      next: initial,
      principalId: "user-1"
    });
    const enabled = expandCataloguePart(part(), {
      operations: [{ name: "listCustomers" }]
    }).operations;
    const widened = kind.prepareInteractiveUpsert({
      current: saved,
      next: { ...saved, operations: enabled },
      principalId: "user-1"
    });
    expect(widened).toMatchObject({
      credentialMode: "user",
      settings: { oauth: { clientId: "sample-client", scopes: ["sample.identity", "sample.read"] } }
    });
    expect(widened.secretHandle).toBe(saved.secretHandle);
  });
});
