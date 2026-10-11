import { z } from "zod";
import { createConnectionAssetKind } from "@vivd-catalyst/chat-server";
import {
  createConnectorTypeRegistry,
  type ConnectorTypeDefinition,
  type JsonObject,
  type JsonValue
} from "@vivd-catalyst/core";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance,
  type AccessInstanceOptions
} from "./access-instance";

// What the tests of the Connection kind share: a Connector type that reaches nothing, a
// definition, and an instance with the module on and the kind registered.

/** A Connector type of the tests. Its settings name one address and nothing else. */
export const fixtureConnectorType: ConnectorTypeDefinition = {
  type: "fixture",
  description: "Reaches nothing. For tests.",
  settingsSchema: z.object({ url: z.string().url() }).strict(),
  authSchemes: ["none", "bearer"],
  secretFields: ["token"],
  target: () => ({ protocol: "https", host: "outside.example.test", port: 443 }),
  catalog: [
    {
      name: "echo",
      description: "Returns its input.",
      inputSchema: { type: "object" },
      proposedEffect: "reading"
    }
  ],
  test: () => Promise.resolve({ status: "ready" }),
  execute: (_operation, input) => Promise.resolve(input),
  limits: { callTimeoutMs: 1000, resultMaxBytes: 1024, maxParallelCalls: 1 }
};

export const fixtureConnectorTypes = createConnectorTypeRegistry([fixtureConnectorType]);

/** A handle as the Secret Store hands one out. It is a reference and holds no secret. */
export const FIXTURE_SECRET_HANDLE = "secret_3f0c6a52-9d1b-4c7e-8a21-5b9e0d4c7f10";

/** A definition of the tests. An override of `undefined` leaves the member out. */
export function connection(
  name: string,
  overrides: Record<string, JsonValue | undefined> = {}
): JsonObject {
  const definition: Record<string, JsonValue | undefined> = {
    name,
    displayName: `Connection ${name}`,
    connectorType: "fixture",
    ownerPrincipalId: "system",
    settings: { url: "https://outside.example.test/mcp" },
    authScheme: "bearer",
    credentialMode: "shared",
    secretHandle: FIXTURE_SECRET_HANDLE,
    operations: [{ name: "echo", effect: "reading", exposure: ["agent"], enabled: true }],
    enabled: true,
    origin: "release",
    ...overrides
  };
  const config: JsonObject = {};
  for (const [key, value] of Object.entries(definition)) {
    if (value !== undefined) config[key] = value;
  }
  return config;
}

export interface ConnectionInstance extends AccessInstance {
  /**
   * Stores a Connection the way the release seed does: through the store and through no
   * operation. Returns the asset id.
   */
  seed(name: string, overrides?: Record<string, JsonValue | undefined>): Promise<string>;
}

/** The access instance with the module `connections` on and the kind registered. */
export async function setupConnectionInstance(
  options: AccessInstanceOptions = {}
): Promise<ConnectionInstance> {
  const t = await setupAccessInstance({
    ...options,
    modules: { connections: { enabled: true }, ...options.modules },
    furtherKinds: [
      createConnectionAssetKind({ connectorTypes: fixtureConnectorTypes }),
      ...(options.furtherKinds ?? [])
    ]
  });
  const seed = async (name: string, overrides: Record<string, JsonValue | undefined> = {}) => {
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      mutations: [{ type: "upsert", kind: "connection", name, config: connection(name, overrides) }]
    });
    return t.assetId("connection", name);
  };
  return { ...t, seed };
}
