import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  CONNECTION_REFUSALS,
  EGRESS_DENIED,
  SHARED_CREDENTIAL_SUBJECT,
  createConnectionSecretHandle,
  defineAssetKind,
  findConnectorTypeIssues,
  parseConnectionOperationName,
  type AssetValidationIssue,
  type ConnectionConfig,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type EgressTarget
} from "@vivd-catalyst/core";
import { requestConnectionDiscovery } from "../connection-jobs";
import {
  configValuesEqual,
  readDefinitionField,
  type AssetWriteSurface,
  type WorkflowAssetKind
} from "./shared";

export interface ConnectionAssetKindOptions {
  /** The Connector types of this build. A Connection of another type is refused. */
  connectorTypes: ConnectorTypeRegistry;
  /** Asked on a save whether the operator's egress list names the Connection's target. */
  egress: Pick<EgressChecker, "admits">;
}

/** The auth scheme that sends no credential, so the Connection holds no secret. */
const AUTH_SCHEME_NONE = "none";
/** The kind of the assets that carry a Connection's tools. */
const AGENT_ASSET_KIND = "agent";

/**
 * The refusal of a write to a Connection that release config defines. It is changed in
 * release config and by a restart, and nowhere in the product.
 */
function readOnlyOrigin(): AppError {
  return new AppError(
    "FORBIDDEN",
    `${CONNECTION_REFUSALS.readOnlyOrigin}: this Connection is defined in release config and is read-only here. Change it in release config`,
    { reason: CONNECTION_REFUSALS.readOnlyOrigin }
  );
}

/**
 * A batch carries no Connection yet: a write of one makes its secret handle and asks for its
 * discovery, which `assets.put` does and a batch does not.
 */
function refuseBatch(surface: AssetWriteSurface): void {
  if (surface !== "sync") return;
  throw new AppError(
    "VALIDATION_FAILED",
    `${CONNECTION_REFUSALS.batchUnavailable}: a Connection is written one at a time, with assets.put. A batch cannot hold one yet`,
    { reason: CONNECTION_REFUSALS.batchUnavailable }
  );
}

/** The tool names of an agent definition, or none. */
function toolNamesOf(agent: unknown): string[] {
  const names = readDefinitionField(agent, "toolNames");
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Why a Connection's target is refused on a save, or nothing. Only the operator's list is
 * asked, never DNS: the address is judged again by every test, discovery and call.
 */
function egressIssue(
  options: ConnectionAssetKindOptions,
  connection: ConnectionConfig
): AssetValidationIssue | undefined {
  const type = options.connectorTypes.get(connection.connectorType);
  if (!type) return undefined;
  let target: EgressTarget | undefined;
  try {
    target = type.target(connection.settings);
  } catch {
    target = undefined;
  }
  if (target && options.egress.admits(target)) return undefined;
  const place = target ? ` ${target.host}:${target.port}` : "";
  return {
    message: `${EGRESS_DENIED}: the address${place} is not on this instance's egress list. An operator adds it under 'egress.allow' in release config`,
    path: ["settings"],
    code: EGRESS_DENIED
  };
}

/** The settings and the auth scheme: what decides which system the Connection reaches and how. */
function reachChanged(previous: unknown, next: ConnectionConfig): boolean {
  return (
    !configValuesEqual(readDefinitionField(previous, "settings"), next.settings) ||
    readDefinitionField(previous, "authScheme") !== next.authScheme
  );
}

/**
 * What the server decides of a Connection made here. The owner is who created it and stays
 * so; the handle names the place of its secret and stays with it while it holds one.
 */
function withServerFields(
  current: unknown,
  next: Record<string, unknown>,
  principalId: string | undefined
): Record<string, unknown> {
  // A handle the caller sent names nothing of this Connection's.
  const rest = Object.fromEntries(Object.entries(next).filter(([key]) => key !== "secretHandle"));
  const storedOwner = readDefinitionField(current, "ownerPrincipalId");
  const storedHandle = readDefinitionField(current, "secretHandle");
  const owner = typeof storedOwner === "string" ? storedOwner : principalId;
  const authenticates = typeof next.authScheme === "string" && next.authScheme !== AUTH_SCHEME_NONE;
  return {
    ...rest,
    ...(owner === undefined ? {} : { ownerPrincipalId: owner }),
    credentialMode: "shared",
    origin: "runtime",
    ...(authenticates
      ? {
          secretHandle:
            typeof storedHandle === "string" ? storedHandle : createConnectionSecretHandle()
        }
      : {})
  };
}

/**
 * The Connection kind: the access to one outside system. Its revision holds settings, accepted
 * operations and a handle of the Secret Store, never a secret. A validated write is live: the
 * kind has no draft. It is no part of the release bundle and offered in no workspace list.
 *
 * A Connection that release config defines is read-only. One made on the instance (`origin:
 * runtime`) is created, changed and deleted through the asset operations: the server writes
 * its origin, its owner and its secret handle, whatever the caller sent.
 */
export function createConnectionAssetKind(options: ConnectionAssetKindOptions): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: CONNECTION_ASSET_KIND,
      plural: "connections",
      schema: connectionConfigSchema,
      nameRule: {
        pattern: CONNECTION_NAME_PATTERN,
        maxLength: CONNECTION_NAME_MAX_LENGTH,
        description: CONNECTION_NAME_RULE
      },
      actions: {
        read: CONNECTION_ACTIONS.read,
        use: CONNECTION_ACTIONS.use,
        write: CONNECTION_ACTIONS.write,
        delete: CONNECTION_ACTIONS.delete
      },
      // A Connection refers to no other asset.
      validate: () => [],
      // Asked for the Connections a write adds or changes only: a stored Connection of a type
      // a later release no longer ships never stands in the way of a write to another asset.
      validateWrite(context, connections) {
        return connections
          .filter((connection) => context.changes(CONNECTION_ASSET_KIND, connection.name))
          .flatMap((connection): AssetValidationIssue[] => {
            if (connection.origin !== "runtime") {
              // The release seed writes through the store and never through a validation.
              return [
                {
                  message: `${CONNECTION_REFUSALS.readOnlyOrigin}: only release config defines a Connection of origin 'release'`,
                  path: ["origin"],
                  code: CONNECTION_REFUSALS.readOnlyOrigin
                }
              ];
            }
            const typeIssues = findConnectorTypeIssues(options.connectorTypes, connection);
            if (typeIssues.length > 0) return typeIssues;
            const egress = egressIssue(options, connection);
            return egress ? [egress] : [];
          });
      },
      summarize: (connection) => ({
        name: connection.name,
        title: connection.displayName,
        ...(connection.description === undefined ? {} : { description: connection.description }),
        attributes: {
          connectorType: connection.connectorType,
          origin: connection.origin,
          enabled: connection.enabled,
          // Only picks the icon a list shows.
          ...(connection.service === undefined ? {} : { service: connection.service })
        }
      })
    }),
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: false,
    prepareInteractiveUpsert: ({ current, next, principalId }) =>
      withServerFields(current, next, principalId),
    // An earlier revision may name a handle the Connection no longer has: its secret is stored
    // under the one the Connection holds now, and a call resolves the handle of the revision.
    // A revision of release config stays one, and the write refuses it.
    prepareRevert: ({ current, restored, principalId }) =>
      readDefinitionField(restored, "origin") === "release"
        ? restored
        : withServerFields(
            current ?? { ownerPrincipalId: readDefinitionField(restored, "ownerPrincipalId") },
            restored,
            principalId
          ),
    missingUpsertRight: () => undefined,
    // Asked before the definition is read: a seeded Connection answers `read_only_origin`
    // also where this build ships no Connector type for what the caller sent.
    assertStoredWritable({ current }) {
      if (readDefinitionField(current, "origin") === "release") {
        throw readOnlyOrigin();
      }
    },
    assertInteractiveUpsertAllowed: ({ surface }) => refuseBatch(surface),
    assertInteractiveDeleteAllowed: ({ surface }) => refuseBatch(surface),
    // An App names its Connections in its manifest, which its own check holds against the
    // set. An agent names tools, which no check of the agent holds, so a delete asks here.
    assertRemovable({ name, definitions }) {
      const carrying = definitions(AGENT_ASSET_KIND).filter((agent) =>
        toolNamesOf(agent).some(
          (toolName) => parseConnectionOperationName(toolName)?.connection === name
        )
      ).length;
      if (carrying === 0) return;
      throw new AppError(
        "CONFLICT",
        `${CONNECTION_REFUSALS.inUse}: ${carrying === 1 ? "an agent carries" : `${carrying} agents carry`} tools of this Connection. Take the tools off the agents first`,
        { reason: CONNECTION_REFUSALS.inUse, agentCount: carrying }
      );
    },
    // A change of where or how the Connection reaches its system makes what a test found
    // stale, and every write asks for a discovery, which stores nothing a write did not accept.
    async afterWrite({ clientInstanceId, name, previous, config, stores }) {
      const parsed = connectionConfigSchema.safeParse(config);
      if (!parsed.success) return;
      const connection = parsed.data;
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: CONNECTION_ASSET_KIND,
        name
      });
      if (!asset) return;
      const connectionAssetId = asset.id;
      const authenticates = connection.authScheme !== AUTH_SCHEME_NONE;
      if (!authenticates) {
        await stores.connections.deleteSecrets({
          clientInstanceId,
          connectionAssetId,
          subject: SHARED_CREDENTIAL_SUBJECT
        });
      }
      const secret = authenticates
        ? await stores.connections.findSecret({
            clientInstanceId,
            binding: { connectionAssetId, subject: SHARED_CREDENTIAL_SUBJECT }
          })
        : undefined;
      const configured = !authenticates || secret !== undefined;
      if (previous === undefined || reachChanged(previous, connection)) {
        const settingsChanged = !configValuesEqual(
          readDefinitionField(previous, "settings"),
          connection.settings
        );
        await stores.connections.putConnectionState({
          clientInstanceId,
          connectionAssetId,
          health: configured ? "unknown" : "needs_configuration",
          lastErrorCode: null,
          // What another system listed is not what this one lists.
          ...(settingsChanged ? { catalog: null } : {})
        });
      }
      const discovers = options.connectorTypes.get(connection.connectorType)?.discover;
      if (connection.enabled && discovers && configured) {
        await requestConnectionDiscovery(stores.jobs, { clientInstanceId, connectionName: name });
      }
    },
    // The secret and the runtime state go with the Connection. An asset revert never brings
    // back a secret.
    async onRemove({ clientInstanceId, assetId, stores }) {
      await stores.connections.deleteSecrets({ clientInstanceId, connectionAssetId: assetId });
      await stores.connections.deleteConnectionState({
        clientInstanceId,
        connectionAssetId: assetId
      });
    }
  };
}
