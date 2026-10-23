import { storedConnectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_ASSET_KIND,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConnectionCatalog,
  type ConnectionConfig,
  type ConnectionCredentialResolver,
  type ConnectionStateRecord,
  type ConnectorTypeDefinition,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type Logger,
  type OperationResolutionStores,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { readConnectionCatalog } from "./catalog";
import type { OutsideSchemaChecker } from "./schema-check";

// How the operation source, a call and the Connection's page read a Connection: the active
// revision of the asset, its runtime state and its Connector type. One Connection is two point
// reads. All of them are two list reads, never one per Connection.

/** What everything that serves a Connection's operations is built from. */
export interface ConnectionOperationSourceDeps {
  clientInstanceId: ClientInstanceId;
  /** The config assets and `connection_state`. */
  stores: PlatformStores;
  connectorTypes: ConnectorTypeRegistry;
  egress: EgressChecker;
  /** Missing while release config names no Connection: no credential can be resolved then. */
  credentials: ConnectionCredentialResolver | undefined;
  logger: Logger;
  /**
   * What checks by a schema an outside system wrote. Left out, the checker of the process
   * (`outsideSchemaChecker`).
   */
  schemaChecker?: OutsideSchemaChecker;
}

/** One stored Connection as a reader of this package sees it. */
export interface StoredConnection {
  assetId: string;
  revision: number;
  config: ConnectionConfig;
  /** Nothing where this build ships no Connector type of the Connection's. */
  type: ConnectorTypeDefinition | undefined;
  state: ConnectionStateRecord | undefined;
  catalog: ConnectionCatalog | undefined;
}

type ReadDeps = Pick<
  ConnectionOperationSourceDeps,
  "clientInstanceId" | "stores" | "connectorTypes"
>;
type PointReadDeps = Omit<ReadDeps, "stores"> & {
  stores: Pick<OperationResolutionStores, "configAssets" | "connections">;
};

/**
 * A Connection belongs to the instance. An asset of the kind that a workspace owns, or one
 * whose stored definition this build does not read, is no Connection here.
 */
function storedConnection(
  deps: PointReadDeps,
  asset: ConfigAssetRecord,
  state: ConnectionStateRecord | undefined
): StoredConnection | undefined {
  if (asset.status !== "active" || asset.scope.kind !== "instance") return undefined;
  const parsed = storedConnectionConfigSchema.safeParse(asset.config);
  if (!parsed.success || parsed.data.name !== asset.name) return undefined;
  return {
    assetId: asset.id,
    revision: asset.revision,
    config: parsed.data,
    type: deps.connectorTypes.get(parsed.data.connectorType),
    state,
    catalog: readConnectionCatalog(state?.catalog)
  };
}

/**
 * One Connection by its name, with its state. Two point reads. With `held`, inside a
 * transaction, the Connection keeps the revision that is read until the transaction ends.
 */
export async function readConnection(
  deps: PointReadDeps,
  name: string,
  options: { held?: true } = {}
): Promise<StoredConnection | undefined> {
  const { clientInstanceId, stores } = deps;
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: CONNECTION_ASSET_KIND,
    name,
    ...(options.held ? { lock: "share" as const } : {})
  });
  if (!asset || asset.status !== "active") return undefined;
  const state = await stores.connections.getConnectionState({
    clientInstanceId,
    connectionAssetId: asset.id
  });
  return storedConnection(deps, asset, state);
}

/** Every Connection of the instance, with its state. Two reads, whatever their number. */
export async function readConnections(deps: ReadDeps): Promise<StoredConnection[]> {
  const { clientInstanceId, stores } = deps;
  const [assets, states] = await Promise.all([
    stores.configAssets.listActiveConfigAssets({ clientInstanceId, kind: CONNECTION_ASSET_KIND }),
    stores.connections.listConnectionStates({ clientInstanceId })
  ]);
  const stateOf = new Map(states.map((state) => [state.connectionAssetId, state]));
  const connections: StoredConnection[] = [];
  for (const asset of assets) {
    const connection = storedConnection(deps, asset, stateOf.get(asset.id));
    if (connection) connections.push(connection);
  }
  return connections;
}
