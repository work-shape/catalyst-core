import {
  AppError,
  asUserId,
  endConnectionOwnSecrets,
  endConnectionSignIn,
  isOwnServerOwner,
  ownServersOn,
  ownerOnlyOwnerOf,
  type AuditActor,
  type ConnectionBindingRecord,
  type OperationResource
} from "@work-shape/catalyst-core";
import {
  connectionResourceOf,
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { connectionOriginOf, connectionTargetOriginOf, takesOwnSecret } from "./connector-context";
import type { OwnServerEntryView } from "./catalogue/catalogue";

/** A sign-in's binding, or a person's own token's (PMCP-6), as the lists below show it. */
type ShownBinding = Pick<ConnectionBindingRecord, "state" | "connectedAt" | "origin"> &
  Partial<Pick<ConnectionBindingRecord, "accountLabel" | "lastUsedOn" | "stateReason">>;

/** The intentional display projection. No scope, secret handle, or token-set metadata. */
function displayBinding(binding: ShownBinding | undefined) {
  return {
    state: binding?.state ?? ("not_connected" as const),
    ...(binding?.accountLabel === undefined ? {} : { account: binding.accountLabel }),
    ...(binding === undefined ? {} : { connectedAt: binding.connectedAt }),
    ...(binding?.lastUsedOn === undefined ? {} : { lastUsedOn: binding.lastUsedOn }),
    ...(binding?.stateReason === undefined ? {} : { reason: binding.stateReason })
  };
}

function atCurrentOrigin<Binding extends ShownBinding>(
  connection: StoredConnection,
  binding: Binding | undefined
): Binding | undefined {
  const origin = connection.type
    ? connectionOriginOf(connection.type, connection.config)
    : undefined;
  return origin !== undefined && binding?.origin === origin ? binding : undefined;
}

/**
 * What the owner's list shows of their own server: the host it is at, whether it is on, which
 * the operator's switch off also ends, and how many tools they accepted. Nothing for any other.
 */
function ownServerOf(connection: StoredConnection, switchOn: boolean) {
  if (ownerOnlyOwnerOf(connection.config) === undefined) return undefined;
  const origin = connection.type
    ? connectionTargetOriginOf(connection.type, connection.config)
    : undefined;
  let host = "";
  try {
    host = origin === undefined ? "" : new URL(origin).host;
  } catch {
    host = "";
  }
  return {
    host,
    enabled: switchOn && connection.config.enabled,
    tools: connection.config.operations.length
  };
}

/**
 * `ownServerEntries`: the offered catalogue entries a person adds as their own server
 * (PMCP-CAT), shown to whoever may add one.
 */
export function createPersonalConnectionManagement(
  deps: ConnectionOperationSourceDeps,
  ownServerEntries: readonly OwnServerEntryView[] = []
) {
  return {
    async credentialMode(name: string) {
      const connection = await readConnection(deps, name);
      if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
      return connection.config.credentialMode;
    },
    /** What the owner's discovery of a personal Connection is decided on (CS-9b exception). */
    async ownership(name: string) {
      const connection = await readConnection(deps, name);
      if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
      const { credentialMode, connectorType, ownerPrincipalId } = connection.config;
      return { credentialMode, connectorType, ownerPrincipalId };
    },
    /**
     * The personal Connections the person may use, each with only their own sign-in, and the
     * MCP servers they added for themselves, which nobody else is listed, also while switched
     * off. `mayAddOwn` is whether they hold the right to add one in a first-party session; the
     * operator's switch is read here.
     */
    async myConnections(
      userId: string,
      usable: (resource: OperationResource) => boolean,
      mayAddOwn = false
    ) {
      const [connections, bindings, ownSecrets] = await Promise.all([
        readConnections(deps),
        deps.stores.connections.listConnectionBindings({
          clientInstanceId: deps.clientInstanceId,
          userId
        }),
        deps.stores.connections.listConnectionOwnSecrets({
          clientInstanceId: deps.clientInstanceId,
          userId
        })
      ]);
      const byConnection = new Map(
        bindings
          .filter((binding) => binding.subject === `user:${userId}`)
          .map((binding) => [binding.connectionAssetId, binding])
      );
      const tokenByConnection = new Map(
        ownSecrets
          .filter((binding) => binding.subject === `user:${userId}`)
          .map((binding) => [binding.connectionAssetId, binding])
      );
      const switchOn = ownServersOn(deps.ownServers);
      return {
        connections: connections
          .filter((connection) => {
            if (connection.config.credentialMode !== "user") return false;
            // A self-added server is its owner's alone, and listed to them also while off.
            if (ownerOnlyOwnerOf(connection.config) !== undefined) {
              return isOwnServerOwner({ id: userId }, connection.config);
            }
            return connection.config.enabled && usable(connectionResourceOf(connection));
          })
          .map((connection) => {
            const ownServer = ownServerOf(connection, switchOn);
            // Where each person pastes their own token, the token's binding is the state.
            const token = takesOwnSecret(connection.config)
              ? atCurrentOrigin(connection, tokenByConnection.get(connection.assetId))
              : undefined;
            return {
              name: connection.config.name,
              title: connection.config.displayName,
              ...(connection.config.service === undefined
                ? {}
                : { service: connection.config.service }),
              ...(connection.config.catalogue === undefined
                ? {}
                : { catalogue: connection.config.catalogue }),
              ...displayBinding(
                takesOwnSecret(connection.config)
                  ? token
                  : atCurrentOrigin(connection, byConnection.get(connection.assetId))
              ),
              ...(ownServer === undefined ? {} : { ownServer }),
              ...(takesOwnSecret(connection.config)
                ? {
                    token: token?.state === "connected" ? { version: token.secretVersion } : {}
                  }
                : {})
            };
          }),
        ownServers:
          mayAddOwn && switchOn
            ? { mayAdd: true, entries: ownServerEntries.map((entry) => structuredClone(entry)) }
            : { mayAdd: false }
      };
    },
    async connectionPeople(name: string) {
      const connection = await personal(name);
      const bindings = await deps.stores.connections.listConnectionBindings({
        clientInstanceId: deps.clientInstanceId,
        connectionAssetId: connection.assetId
      });
      const tokens = await deps.stores.connections.listConnectionOwnSecrets({
        clientInstanceId: deps.clientInstanceId,
        connectionAssetId: connection.assetId
      });
      // A person's sign-in, or the token they set themselves (PMCP-6): never its value.
      const own: (ShownBinding & { subject: string })[] = [
        ...bindings.filter(
          (binding) => binding.userId !== undefined && binding.subject === `user:${binding.userId}`
        ),
        ...tokens.filter((binding) => binding.subject === `user:${binding.userId}`)
      ];
      // Only the name, as the list of users shows it: no email and nothing else of the person.
      const labels = await Promise.all(
        own.map(async (binding) => {
          const user = await deps.stores.users.getUser({
            clientInstanceId: deps.clientInstanceId,
            userId: asUserId(binding.subject.slice(5))
          });
          return user?.displayLabel;
        })
      );
      return {
        people: own.map((binding, index) => {
          const displayLabel = labels[index];
          return {
            userId: binding.subject.slice(5),
            ...(displayLabel === undefined ? {} : { displayLabel }),
            ...displayBinding(atCurrentOrigin(connection, binding))
          };
        })
      };
    },
    async revokePerson(
      name: string,
      userId: string,
      audit: { actor: AuditActor; correlationId: string }
    ) {
      await deps.stores.transaction(async (stores) => {
        const connection = await personal(name, stores);
        const ended = await endConnectionSignIn(
          stores.connections,
          {
            clientInstanceId: deps.clientInstanceId,
            connectionAssetId: connection.assetId,
            subject: `user:${userId}`
          },
          {
            reason: "admin_revoked",
            ...(audit.actor.userId === undefined ? {} : { changedBy: audit.actor.userId })
          }
        );
        // A token the person set themselves goes too, binding and secret (PMCP-6).
        const tokens = await endConnectionOwnSecrets(stores.connections, {
          clientInstanceId: deps.clientInstanceId,
          connectionAssetId: connection.assetId,
          userId
        });
        if (ended === undefined && tokens.length === 0) return;
        await stores.audit.appendAuditEvent({
          clientInstanceId: deps.clientInstanceId,
          type: "connection.binding_revoked",
          status: "success",
          actor: audit.actor,
          subject: name,
          reason: "admin_revoked",
          correlationId: audit.correlationId,
          metadata: {
            connectionName: name,
            connectionRevision: connection.revision,
            ...(tokens.length > 0 ? { personal: true, scheme: "static" } : {}),
            subjectKind: "user",
            userId
          }
        });
      });
      return { state: "revoked" as const };
    }
  };

  async function personal(name: string, stores = deps.stores) {
    const connection = await readConnection({ ...deps, stores }, name, { held: true });
    if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
    if (connection.config.credentialMode !== "user")
      throw new AppError("CONFLICT", "personal_connection_required", {
        reason: "personal_connection_required"
      });
    return connection;
  }
}
