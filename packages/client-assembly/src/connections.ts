import {
  createConnectionCredentialResolver,
  createDocumentSourceOpener,
  ConnectionCallSlots,
  createConnectionManagement,
  createConnectionOperationSource,
  createConnectionToolSource,
  createEgressChecker,
  createHttpApiConnectorType,
  createMcpConnectorType,
  discoverConnection,
  loadSecretKeyring,
  platformStoreTargetsOf,
  readConnections,
  seedReleaseConnections,
  type ReleaseSeedResult,
  type SecretKeyring
} from "@work-shape/catalyst-connections";
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
} from "@work-shape/catalyst-core";
import {
  combineDataToolSources,
  createAppActionToolSource,
  requestConnectionDiscovery,
  type ChatServerOptions
} from "@work-shape/catalyst-server";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { readClientInstanceEnv } from "./env";
import { PLATFORM_SECRET_NAMES } from "./infrastructure";

/** What an instance with the module `connections` on has for its Connections. */
export interface InstanceConnections {
  readonly connectorTypes: ConnectorTypeRegistry;
  readonly openDocumentSource: ReturnType<typeof createDocumentSourceOpener>;
  /** The one egress checker of this process. */
  readonly egress: EgressChecker;
  /** Missing while release config names no Connection: nothing can be opened then. */
  readonly credentials?: ConnectionCredentialResolver;
  /**
   * Makes the stored release Connections equal to release config, then queues one discovery
   * for every Connection that reads its operations from its outside system. The API process
   * calls it. It contacts no outside system itself.
   */
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
 * agent tools of the instance are built with: the Connections' tool source among it, and with
 * it the named actions of published Apps, which stand for operations of Connections. Whoever
 * builds the agent tools bounds its reads. Without Connections an agent has the tools of the
 * release only.
 */
export function withConnections(
  connections: InstanceConnections | undefined,
  operationCalls: { registry: Pick<OperationRegistry, "addSource"> },
  parts: Pick<
    InstanceConnectionParts,
    "clientInstanceId" | "logger" | "config" | "stores" | "modules"
  >,
  /** The tool sources of the modules: operations of their Assets an agent may carry. */
  moduleToolSources: readonly DataToolSource[] = []
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
  if (!connections) {
    return moduleToolSources.length === 0
      ? options
      : { ...options, dataTools: combineDataToolSources(...moduleToolSources) };
  }
  operationCalls.registry.addSource(connections.operationSource);
  return {
    ...options,
    dataTools: combineDataToolSources(
      connections.toolSource,
      createAppActionToolSource({
        clientInstanceId: parts.clientInstanceId,
        store: parts.stores.configAssets,
        modules: parts.modules,
        logger: parts.logger,
        // What an action may stand for: an operation of a Connection, or one of a module's Asset.
        targetTools: combineDataToolSources(connections.toolSource, ...moduleToolSources)
      }),
      ...moduleToolSources
    )
  };
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
  const connectorTypes = createConnectorTypeRegistry([
    createMcpConnectorType({ logger }),
    createHttpApiConnectorType(),
    ...types
  ]);
  // Named keys are needed: a release Connection's secret or one entered on the instance is
  // stored under them.
  let keyring: SecretKeyring | undefined;
  if (configured || config.secretStore.keys.length > 0) {
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
  if (config.egress.allowPublicHttps === true) {
    // Said once, at start: the list is no longer the whole of where a Connection may go.
    logger.warn(
      { module: "connections" },
      "egress.allowPublicHttps is on: a Connection may reach any https host on port 443 whose addresses are all public"
    );
  }
  const egress = createEgressChecker({
    allow: config.egress.allow,
    allowPublicHttps: config.egress.allowPublicHttps === true,
    platformStore: platformStore ?? [],
    platformStoreUnknown: platformStore === undefined
  });
  const credentials = keyring
    ? createConnectionCredentialResolver({ clientInstanceId, keyring, store: stores.connections })
    : undefined;
  const operations = { clientInstanceId, stores, connectorTypes, egress, credentials, logger };
  const slots = new ConnectionCallSlots();
  return {
    connectorTypes,
    openDocumentSource: createDocumentSourceOpener(operations, slots),
    egress,
    ...(credentials ? { credentials } : {}),
    operationSource: createConnectionOperationSource(operations, slots),
    toolSource: createConnectionToolSource(operations),
    management: {
      ...createConnectionManagement({
        ...operations,
        ...(keyring ? { keyring } : {}),
        // Where the provider of an OAuth sign-in sends the browser back to.
        ...(config.instance.publicUrl === undefined ? {} : { publicUrl: config.instance.publicUrl })
      }),
      discover: (connectionName, attempt) =>
        discoverConnection({ ...operations, connectionName, ...attempt })
    },
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
      await enqueueDiscoveries(operations);
      return result;
    }
  };
}

/**
 * Queues the discovery of every enabled Connection whose type reads its operations from the
 * outside system. An operation accepted since the last discovery is pinned by the next one,
 * so one follows every seed and not only the first. A Connection that has one queued gets
 * no second, and one whose discovery runs gets one queued behind it. One read of the Connections and one insert each, and no call to the outside. A
 * discovery that cannot be queued is logged and does not stop the start.
 */
async function enqueueDiscoveries(
  deps: Pick<InstanceConnectionParts, "clientInstanceId" | "stores" | "logger"> & {
    connectorTypes: ConnectorTypeRegistry;
  }
): Promise<void> {
  const { clientInstanceId, stores, logger } = deps;
  try {
    for (const connection of await readConnections(deps)) {
      if (!connection.config.enabled || !connection.type?.discover) continue;
      // A discovery that runs now may have read the Connection before this seed changed it,
      // so one always starts after a seed.
      await requestConnectionDiscovery(stores.jobs, {
        clientInstanceId,
        connectionName: connection.config.name
      });
    }
  } catch (error) {
    logger.warn(
      { module: "connections", err: error },
      "The discovery of the Connections could not be queued. Their discovered operations stay as they were until the next start"
    );
  }
}
