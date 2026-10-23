import {
  AppError,
  asUserId,
  CONNECTION_ASSET_KIND,
  endConnectionSignIn,
  type AuditActor,
  type ConnectionBindingRecord,
  type OperationResource
} from "@work-shape/catalyst-core";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { connectionOriginOf } from "./connector-context";

/** The intentional display projection. No scope, secret handle, or token-set metadata. */
function displayBinding(binding: ConnectionBindingRecord | undefined) {
  return {
    state: binding?.state ?? ("not_connected" as const),
    ...(binding?.accountLabel === undefined ? {} : { account: binding.accountLabel }),
    ...(binding === undefined ? {} : { connectedAt: binding.connectedAt }),
    ...(binding?.lastUsedOn === undefined ? {} : { lastUsedOn: binding.lastUsedOn }),
    ...(binding?.stateReason === undefined ? {} : { reason: binding.stateReason })
  };
}

function atCurrentOrigin(
  connection: StoredConnection,
  binding: ConnectionBindingRecord | undefined
) {
  const origin = connection.type
    ? connectionOriginOf(connection.type, connection.config)
    : undefined;
  return origin !== undefined && binding?.origin === origin ? binding : undefined;
}

export function createPersonalConnectionManagement(deps: ConnectionOperationSourceDeps) {
  return {
    async credentialMode(name: string) {
      const connection = await readConnection(deps, name);
      if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
      return connection.config.credentialMode;
    },
    async myConnections(userId: string, usable: (resource: OperationResource) => boolean) {
      const [connections, bindings] = await Promise.all([
        readConnections(deps),
        deps.stores.connections.listConnectionBindings({
          clientInstanceId: deps.clientInstanceId,
          userId
        })
      ]);
      const byConnection = new Map(
        bindings
          .filter((binding) => binding.subject === `user:${userId}`)
          .map((binding) => [binding.connectionAssetId, binding])
      );
      return {
        connections: connections
          .filter(
            (connection) =>
              connection.config.credentialMode === "user" &&
              connection.config.enabled &&
              usable({
                kind: CONNECTION_ASSET_KIND,
                assetId: connection.assetId,
                id: connection.assetId,
                name: connection.config.name
              })
          )
          .map((connection) => ({
            name: connection.config.name,
            title: connection.config.displayName,
            ...(connection.config.service === undefined
              ? {}
              : { service: connection.config.service }),
            ...(connection.config.catalogue === undefined
              ? {}
              : { catalogue: connection.config.catalogue }),
            ...displayBinding(atCurrentOrigin(connection, byConnection.get(connection.assetId)))
          }))
      };
    },
    async connectionPeople(name: string) {
      const connection = await personal(name);
      const bindings = await deps.stores.connections.listConnectionBindings({
        clientInstanceId: deps.clientInstanceId,
        connectionAssetId: connection.assetId
      });
      const own = bindings.filter(
        (binding) => binding.userId !== undefined && binding.subject === `user:${binding.userId}`
      );
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
        if (ended === undefined) return;
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
