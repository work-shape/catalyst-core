import { connectionConfigSchema, type ReleaseConnectionConfig } from "@vivd-catalyst/config-schema";
import {
  AppError,
  CONNECTION_ASSET_KIND,
  SHARED_CREDENTIAL_SUBJECT,
  createConnectionSecretHandle,
  findConnectorTypeIssues,
  resolveOptionalSecret,
  type AssetValidationIssue,
  type AuditActor,
  type ClientInstanceId,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type ConnectionConfig,
  type ConnectionHealth,
  type ConnectorTypeRegistry,
  sameJson,
  type JsonObject,
  type PlatformStores,
  type SecretResolver
} from "@vivd-catalyst/core";
import { AUTH_SCHEME_NONE, connectionOriginOf } from "./connector-context";
import { createSecretStore, type SecretKeyring } from "./secret-store";

// The release seed. When the API process starts it makes the stored Connections of origin
// `release` equal to `connections` of release config: in one transaction, under one lock, so
// two processes that start together write once. It writes through the store ports, validates
// every entry with the Connector type's strict schema first, and touches no runtime row.

/** Who a seeded revision is written by. */
const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };
/** The accountable principal of a Connection the release defines. */
const RELEASE_OWNER_PRINCIPAL_ID = "system";

export interface SeedReleaseConnectionsInput {
  clientInstanceId: ClientInstanceId;
  /** `connections` of release config. */
  connections: Readonly<Record<string, ReleaseConnectionConfig>>;
  connectorTypes: ConnectorTypeRegistry;
  stores: PlatformStores;
  /** The keys of the Secret Store. Needed as soon as an entry names a secret. */
  keyring?: SecretKeyring;
  /** Where the secret an entry names is read from, once, at start. */
  secrets: SecretResolver;
}

/** What one start changed, by Connection name. It holds names and versions, never a value. */
export interface ReleaseSeedResult {
  created: string[];
  updated: string[];
  removed: string[];
  /** Entries whose secret is named and not present in the environment. */
  needsConfiguration: string[];
  /** Entries whose stored secret the configured keys do not open. */
  secretUnreadable: string[];
  /** The version of each secret this start wrote. */
  secretVersions: Record<string, number>;
}

function invalidConfig(name: string, issues: readonly AssetValidationIssue[]): AppError {
  const described = issues.map(({ message, path }) => {
    const place = ["connections", name, ...(path ?? []).map(String)].join(".");
    return `${place}: ${message}`;
  });
  return new AppError(
    "VALIDATION_FAILED",
    `Release config defines a Connection the instance cannot run. ${described.join("; ")}`,
    {
      issues: issues.map(({ message, path }) => ({
        message,
        path: ["connections", name, ...(path ?? []).map(String)]
      }))
    }
  );
}

function storedConnection(asset: ConfigAssetRecord): ConnectionConfig | undefined {
  const parsed = connectionConfigSchema.safeParse(asset.config);
  return parsed.success ? parsed.data : undefined;
}

/** What is stored says where it came from, also where this build no longer reads the rest. */
function storedOrigin(asset: ConfigAssetRecord): unknown {
  return asset.config?.origin;
}

function toJsonObject(config: ConnectionConfig): JsonObject {
  const json: JsonObject = {
    name: config.name,
    displayName: config.displayName,
    connectorType: config.connectorType,
    ownerPrincipalId: config.ownerPrincipalId,
    settings: config.settings,
    authScheme: config.authScheme,
    credentialMode: config.credentialMode,
    operations: config.operations.map((operation) => ({
      name: operation.name,
      effect: operation.effect,
      exposure: [...operation.exposure],
      enabled: operation.enabled,
      ...(operation.policy === undefined ? {} : { policy: operation.policy }),
      ...(operation.schemaFingerprint === undefined
        ? {}
        : { schemaFingerprint: operation.schemaFingerprint }),
      ...(operation.idempotencyKeyHeader === undefined
        ? {}
        : { idempotencyKeyHeader: operation.idempotencyKeyHeader })
    })),
    enabled: config.enabled,
    origin: config.origin
  };
  if (config.description !== undefined) json.description = config.description;
  if (config.service !== undefined) json.service = config.service;
  if (config.secretHandle !== undefined) json.secretHandle = config.secretHandle;
  return json;
}

/**
 * The definition an entry becomes, validated by the Connection schema and by the Connector
 * type's own settings schema. Throws with the place of every issue and no value of it.
 */
function definitionOf(
  name: string,
  entry: ReleaseConnectionConfig,
  connectorTypes: ConnectorTypeRegistry,
  secretHandle: string | undefined
): ConnectionConfig {
  const authenticates = entry.authScheme !== AUTH_SCHEME_NONE;
  if (authenticates !== (entry.secret !== undefined)) {
    throw invalidConfig(name, [
      {
        message: authenticates
          ? `the auth scheme '${entry.authScheme}' needs 'secret', the name of the secret`
          : "the auth scheme 'none' takes no 'secret'",
        path: ["secret"]
      }
    ]);
  }
  const parsed = connectionConfigSchema.safeParse({
    name,
    displayName: entry.displayName ?? name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.service === undefined ? {} : { service: entry.service }),
    connectorType: entry.connectorType,
    ownerPrincipalId: RELEASE_OWNER_PRINCIPAL_ID,
    settings: entry.settings,
    authScheme: entry.authScheme,
    credentialMode: "shared",
    ...(secretHandle === undefined ? {} : { secretHandle }),
    // The operator's list is the accepted list: what stands in it is enabled.
    operations: entry.operations.map((operation) => ({ ...operation, enabled: true })),
    enabled: true,
    origin: "release"
  });
  if (!parsed.success) {
    throw invalidConfig(name, parsed.error.issues);
  }
  const typeIssues = findConnectorTypeIssues(connectorTypes, parsed.data);
  if (typeIssues.length > 0) {
    throw invalidConfig(name, typeIssues);
  }
  return parsed.data;
}

/**
 * Reconciles the Connections of origin `release` with release config. Safe to run in several
 * processes at once and on every start: a start that finds everything as config says writes
 * no revision and no secret version.
 */
export async function seedReleaseConnections(
  input: SeedReleaseConnectionsInput
): Promise<ReleaseSeedResult> {
  const { clientInstanceId, connectorTypes } = input;
  const names = Object.keys(input.connections).sort();
  const namesSecret = names.some((name) => input.connections[name]?.secret !== undefined);
  if (namesSecret && !input.keyring) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Connections need a Secret Store key: name one under 'secretStore.keys'"
    );
  }
  // Checked before anything is read or written: a config the instance cannot run stops the
  // start and leaves what is stored as it was.
  for (const name of names) {
    const entry = input.connections[name];
    if (entry) definitionOf(name, entry, connectorTypes, undefined);
  }
  // Read once, outside the transaction. A secret nothing configures leaves its Connection in
  // `needs_configuration`; one that is configured and broken stops the start by its name.
  const values = new Map<string, string | undefined>();
  for (const name of names) {
    const ref = input.connections[name]?.secret;
    if (ref !== undefined) {
      values.set(name, await resolveOptionalSecret(input.secrets, ref));
    }
  }

  return input.stores.transaction(async (stores) => {
    await stores.connections.lockReleaseSeed({ clientInstanceId });
    const result: ReleaseSeedResult = {
      created: [],
      updated: [],
      removed: [],
      needsConfiguration: [],
      secretUnreadable: [],
      secretVersions: {}
    };
    const list = () =>
      stores.configAssets.listActiveConfigAssets({
        clientInstanceId,
        kind: CONNECTION_ASSET_KIND
      });
    const before = new Map((await list()).map((asset) => [asset.name, asset]));

    const mutations: ConfigAssetMutation[] = [];
    /** The revision each written Connection was read at, under the lock of the seed. */
    const baseRevisions: Record<string, number | null> = {};
    const handles = new Map<string, string>();
    for (const name of names) {
      const entry = input.connections[name];
      if (!entry) continue;
      const asset = before.get(name);
      if (asset && storedOrigin(asset) !== "release") {
        // A runtime row is never touched. The name is its own until it is removed.
        throw new AppError(
          "VALIDATION_FAILED",
          `Release config defines the Connection '${name}', and a Connection of that name was created on the instance. Rename one of the two`
        );
      }
      const stored = asset && storedConnection(asset);
      // The handle is a name for the secret's place and stays with the Connection, whether
      // or not a secret is stored yet: a secret that arrives later makes no new revision.
      const handle =
        entry.secret === undefined
          ? undefined
          : (stored?.secretHandle ?? createConnectionSecretHandle());
      if (handle !== undefined) handles.set(name, handle);
      const config = toJsonObject(definitionOf(name, entry, connectorTypes, handle));
      if (asset && sameJson(asset.config, config)) continue;
      mutations.push({ type: "upsert", kind: CONNECTION_ASSET_KIND, name, config });
      // A name release config had once and dropped left a deleted row: the seed that brings
      // the entry back continues its revisions.
      const row =
        asset ??
        (await stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: CONNECTION_ASSET_KIND,
          name
        }));
      baseRevisions[`${CONNECTION_ASSET_KIND}:${name}`] = row?.revision ?? null;
      (asset ? result.updated : result.created).push(name);
    }
    for (const asset of before.values()) {
      if (storedOrigin(asset) !== "release" || names.includes(asset.name)) continue;
      // The entry is gone from release config: the Connection goes, with its secret and state.
      await stores.connections.deleteSecrets({ clientInstanceId, connectionAssetId: asset.id });
      await stores.connections.deleteConnectionState({
        clientInstanceId,
        connectionAssetId: asset.id
      });
      mutations.push({ type: "delete", kind: CONNECTION_ASSET_KIND, name: asset.name });
      baseRevisions[`${CONNECTION_ASSET_KIND}:${asset.name}`] = asset.revision;
      result.removed.push(asset.name);
    }
    if (mutations.length > 0) {
      await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        actor: SYSTEM_ACTOR,
        baseRevisions,
        mutations
      });
    }

    const after = new Map((await list()).map((asset) => [asset.name, asset]));
    const states = new Map(
      (await stores.connections.listConnectionStates({ clientInstanceId })).map((state) => [
        state.connectionAssetId,
        state
      ])
    );
    const secretStore = input.keyring
      ? createSecretStore({ clientInstanceId, keyring: input.keyring, store: stores.connections })
      : undefined;
    for (const name of names) {
      const asset = after.get(name);
      if (!asset) {
        throw new AppError("INTERNAL", `The seeded Connection '${name}' was not stored`);
      }
      const binding = { connectionAssetId: asset.id, subject: SHARED_CREDENTIAL_SUBJECT };
      const seeded = storedConnection(asset);
      const type = seeded && connectorTypes.get(seeded.connectorType);
      const health = await bootstrapSecret({
        name,
        // The environment's secret is for the address release config names now.
        origin: seeded && type ? connectionOriginOf(type, seeded) : undefined,
        named: input.connections[name]?.secret !== undefined,
        value: values.get(name),
        handle: handles.get(name),
        binding,
        secretStore,
        deleteSecret: () =>
          stores.connections.deleteSecrets({
            clientInstanceId,
            connectionAssetId: asset.id,
            subject: SHARED_CREDENTIAL_SUBJECT
          }),
        result
      });
      const current = states.get(asset.id)?.health;
      // What a test found stays, unless the secret's own state says otherwise. A Connection
      // whose secret arrived or became readable again is unknown until it is tested.
      const settled =
        health ??
        (current === undefined ||
        current === "needs_configuration" ||
        current === "secret_unreadable"
          ? "unknown"
          : current);
      if (settled !== current) {
        await stores.connections.putConnectionState({
          clientInstanceId,
          connectionAssetId: asset.id,
          health: settled
        });
      }
    }
    return result;
  });
}

/**
 * Brings the stored secret of one seeded Connection in line with the environment, and
 * answers the health the secret alone decides, or nothing where it is in order.
 *
 * - A secret set through a later runtime flow is never overwritten.
 * - A secret that came from here follows its environment value: a new value is a new version,
 *   the same value writes nothing, and a variable that is gone removes the stored secret.
 */
async function bootstrapSecret(input: {
  name: string;
  named: boolean;
  value: string | undefined;
  handle: string | undefined;
  origin: string | undefined;
  binding: { connectionAssetId: string; subject: string };
  secretStore: ReturnType<typeof createSecretStore> | undefined;
  deleteSecret(): Promise<void>;
  result: ReleaseSeedResult;
}): Promise<ConnectionHealth | undefined> {
  const { secretStore, binding, result, name } = input;
  if (!secretStore) {
    // No key is configured, so no entry names a secret: nothing of an earlier config stays.
    await input.deleteSecret();
    return undefined;
  }
  const status = await secretStore.status(binding);
  if (status.source === "runtime") {
    if (status.state === "unreadable") {
      result.secretUnreadable.push(name);
      return "secret_unreadable";
    }
    return undefined;
  }
  if (!input.named) {
    if (status.state !== "not_set") await input.deleteSecret();
    return undefined;
  }
  if (input.value === undefined) {
    if (status.state !== "not_set") await input.deleteSecret();
    result.needsConfiguration.push(name);
    return "needs_configuration";
  }
  const written = await secretStore.put({
    binding,
    value: input.value,
    source: "bootstrap",
    ...(input.handle === undefined ? {} : { handle: input.handle }),
    ...(input.origin === undefined ? {} : { origin: input.origin })
  });
  if (written.changed) {
    result.secretVersions[name] = written.version;
  }
  return undefined;
}
