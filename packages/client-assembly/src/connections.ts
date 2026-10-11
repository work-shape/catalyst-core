import {
  createConnectionCredentialResolver,
  createConnectionManagement,
  createConnectionOperationSource,
  createConnectionToolSource,
  createEgressChecker,
  loadSecretKeyring,
  platformStoreTargetsOf,
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
  type DataToolSource,
  type EgressChecker,
  type Logger,
  type ModuleSnapshot,
  type OperationRegistry,
  type OperationSource,
  type PlatformStores,
  type SecretResolver
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { readClientInstanceEnv } from "./env";
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
  /** Every accepted operation of every Connection, as an operation of the call path. */
  readonly operationSource: OperationSource;
  /** The same operations as the tools an agent may carry. */
  readonly toolSource: DataToolSource;
  /** What the Connection routes of the API read and test through. */
  readonly management: NonNullable<ChatServerOptions["connections"]>;
}

/**
 * Adds the Connections' operations to the call path of this process and answers what the
 * agent tools of the instance are built with: the Connections' tool source among it, as it
 * is. Whoever builds the agent tools bounds its reads. Without Connections an agent has the
 * tools of the release only.
 */
export function withConnections(
  connections: InstanceConnections | undefined,
  operationCalls: { registry: Pick<OperationRegistry, "addSource"> },
  parts: Pick<InstanceConnectionParts, "clientInstanceId" | "logger" | "config">
): {
  clientInstanceId: ClientInstanceId;
  logger: Logger;
  runtime: ClientInstanceConfig["runtime"];
  dataTools?: DataToolSource;
} {
  const options = {
    clientInstanceId: parts.clientInstanceId,
    logger: parts.logger,
    runtime: parts.config.runtime
  };
  if (!connections) return options;
  operationCalls.registry.addSource(connections.operationSource);
  return { ...options, dataTools: connections.toolSource };
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
  // The driver reads `PGPORT` from the process itself, so the guard reads it there too.
  const { PGPORT } = readClientInstanceEnv();
  const platformStore = platformStoreTargetsOf(
    await secrets.resolve(PLATFORM_SECRET_NAMES.databaseUrl),
    { PGPORT }
  );
  if (!platformStore) {
    // Said once, at start. The address itself is never logged.
    logger.warn(
      { module: "connections" },
      "The address of the Platform Store could not be read as host and port, so no Connection can be told apart from it. Every 'postgres' egress target is refused on this instance. Give the database address as postgres://host:port/database"
    );
  }
  const egress = createEgressChecker({
    allow: config.egress.allow,
    platformStore: platformStore ?? [],
    platformStoreUnknown: platformStore === undefined
  });
  const credentials = keyring
    ? createConnectionCredentialResolver({ clientInstanceId, keyring, store: stores.connections })
    : undefined;
  const operations = { clientInstanceId, stores, connectorTypes, egress, credentials, logger };
  return {
    connectorTypes,
    egress,
    ...(credentials ? { credentials } : {}),
    operationSource: createConnectionOperationSource(operations),
    toolSource: createConnectionToolSource(operations),
    management: createConnectionManagement(operations),
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
