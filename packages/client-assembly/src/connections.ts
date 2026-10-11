import {
  createConnectionCredentialResolver,
  createEgressChecker,
  loadSecretKeyring,
  seedReleaseConnections,
  type ReleaseSeedResult,
  type SecretKeyring
} from "@vivd-catalyst/connections";
import {
  createConnectorTypeRegistry,
  type ClientInstanceId,
  type ConnectionCredentialResolver,
  type ConnectorTypeDefinition,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type Logger,
  type ModuleSnapshot,
  type PlatformStores,
  type SecretResolver
} from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { PLATFORM_SECRET_NAMES } from "./infrastructure";

/** What an instance with the module `connections` on has for its Connections. */
export interface InstanceConnections {
  readonly connectorTypes: ConnectorTypeRegistry;
  /** The one egress checker of this process. */
  readonly egress: EgressChecker;
  /** Missing while release config names no Connection: nothing can be opened then. */
  readonly credentials?: ConnectionCredentialResolver;
  /** Makes the stored release Connections equal to release config. The API process calls it. */
  seed(): Promise<ReleaseSeedResult>;
}

/**
 * Where the Platform Store listens, read from its address. Only host and port leave this
 * function: the egress checker refuses them for every Connection.
 */
function platformStoreTargets(databaseUrl: string): { host: string; port: number }[] {
  try {
    const url = new URL(databaseUrl);
    if (url.hostname === "") return [];
    return [{ host: url.hostname, port: url.port === "" ? 5432 : Number(url.port) }];
  } catch {
    return [];
  }
}

/**
 * Builds the Connection parts of one process: the Connector types, the egress checker and
 * the keys of the Secret Store. A config that names a Connection needs the first key of
 * `secretStore.keys`; without it this throws with the name of its variable and startup stops.
 */
export async function createInstanceConnections(
  input: InstanceConnectionParts,
  /** The Connector types of this build. */
  connectorTypes: readonly ConnectorTypeDefinition[] = []
): Promise<InstanceConnections | undefined> {
  try {
    return await buildInstanceConnections(input, connectorTypes);
  } catch (error) {
    // A missing Secret Store key stops the start here, before anything else is built. The
    // store was opened for this start and nothing else holds it yet.
    await input.stores.close?.();
    throw error;
  }
}

/** Seeds for the API process. A seed that fails closes what the start had opened. */
export async function seedInstanceConnections(execution: {
  connections?: InstanceConnections | undefined;
  close(): Promise<void>;
}): Promise<void> {
  try {
    await execution.connections?.seed();
  } catch (error) {
    await execution.close();
    throw error;
  }
}

interface InstanceConnectionParts {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  clientInstanceId: ClientInstanceId;
  secrets: SecretResolver;
  stores: PlatformStores;
  logger: Logger;
}

async function buildInstanceConnections(
  input: InstanceConnectionParts,
  types: readonly ConnectorTypeDefinition[]
): Promise<InstanceConnections | undefined> {
  const { config, clientInstanceId, secrets, stores, logger } = input;
  const configured = Object.keys(config.connections).length > 0;
  if (!input.modules.isEnabled("connections")) {
    if (configured) {
      logger.warn(
        { module: "connections" },
        "Release config defines Connections and the module 'connections' is off: none is seeded"
      );
    }
    return undefined;
  }
  const connectorTypes = createConnectorTypeRegistry(types);
  let keyring: SecretKeyring | undefined;
  if (configured) {
    keyring = await loadSecretKeyring({
      keys: config.secretStore.keys,
      secrets,
      onMissingKey: (key) =>
        logger.warn(
          { keyId: key.id, secretName: key.ref },
          "A Secret Store key is not set. Secrets it encrypted cannot be read"
        )
    });
  }
  const egress = createEgressChecker({
    allow: config.egress.allow,
    platformStore: platformStoreTargets(await secrets.resolve(PLATFORM_SECRET_NAMES.databaseUrl))
  });
  return {
    connectorTypes,
    egress,
    ...(keyring
      ? {
          credentials: createConnectionCredentialResolver({
            clientInstanceId,
            keyring,
            store: stores.connections
          })
        }
      : {}),
    async seed() {
      const result = await seedReleaseConnections({
        clientInstanceId,
        connections: config.connections,
        connectorTypes,
        stores,
        secrets,
        ...(keyring ? { keyring } : {})
      });
      const changed =
        result.created.length +
        result.updated.length +
        result.removed.length +
        Object.keys(result.secretVersions).length;
      if (changed > 0 || result.needsConfiguration.length > 0) {
        // Names and versions only. No setting and no value of a Connection is logged.
        logger.info({ connections: result }, "Release Connections reconciled");
      }
      return result;
    }
  };
}
