import { randomUUID } from "node:crypto";
import {
  StoreBackedAuditRecorder,
  signInSecretSubject,
  type AuditActor,
  type ClientInstanceId,
  type ConnectorTypeRegistry,
  type Logger,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { managedClientOfSettings } from "../catalogue/catalogue";
import { readConnections } from "../connection-reads";
import { connectionOriginOf } from "../connector-context";
import { bindingAuditSubject } from "../personal-bindings";
import type { ManagedOAuthClients } from "./managed-clients";

// What a change of the operator's managed OAuth clients (MS-APP-1) does to the sign-ins made
// with them. A sign-in is bound to the client id and the endpoints it was made with (the
// Connection's origin). Where release config no longer has the client, or its client id or
// tenant changed, the sign-ins made before cannot be used: each connected binding of such a
// Connection is set to `needs_reconnect` and its token set is deleted, so the card asks the
// person to connect again. Run once at start; nothing is sent to a provider, since its client
// is the one that changed. A client release config still declares but whose secret the host
// does not hold now keeps its sign-ins: a refresh token outlives a rotated or missing secret,
// and they work again once the secret is back.

const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** The reason a binding records: the client it was made with is not the instance's now. */
export const MANAGED_CLIENT_CHANGED_REASON = "invalid_client";

export async function endStaleManagedSignIns(deps: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  connectorTypes: ConnectorTypeRegistry;
  /** The instance's managed clients. Left out, every client the type lacks ends its sign-ins. */
  managedClients?: Pick<ManagedOAuthClients, "awaitingSecret">;
  logger: Pick<Logger, "info" | "warn">;
}): Promise<{ ended: number }> {
  const { clientInstanceId, stores } = deps;
  const audit = new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit });
  let ended = 0;
  for (const connection of await readConnections(deps)) {
    const managed = managedClientOfSettings(connection.config.settings);
    if (managed === undefined || connection.config.authScheme !== "oauth") continue;
    if (deps.managedClients?.awaitingSecret(managed) === true) continue;
    // Nothing where the instance no longer has the client: the settings are not its type's.
    const origin = connection.type
      ? connectionOriginOf(connection.type, connection.config)
      : undefined;
    const bindings = await stores.connections.listConnectionBindings({
      clientInstanceId,
      connectionAssetId: connection.assetId
    });
    for (const binding of bindings) {
      if (binding.state !== "connected" || binding.origin === origin) continue;
      const changed = await stores.transaction(async (tx) => {
        const moved = await tx.connections.changeConnectionBindingState({
          clientInstanceId,
          connectionAssetId: binding.connectionAssetId,
          subject: binding.subject,
          expectedRowVersion: binding.rowVersion,
          state: "needs_reconnect",
          reason: MANAGED_CLIENT_CHANGED_REASON
        });
        if (moved === undefined) return false;
        await tx.connections.deleteSecrets({
          clientInstanceId,
          connectionAssetId: binding.connectionAssetId,
          subject: signInSecretSubject(binding.subject)
        });
        return true;
      });
      if (!changed) continue;
      ended += 1;
      await audit.record({
        type: "connection.binding_needs_reconnect",
        status: "failed",
        actor: SYSTEM_ACTOR,
        subject: connection.config.name,
        reason: MANAGED_CLIENT_CHANGED_REASON,
        correlationId: `managed_client_${randomUUID()}`,
        metadata: {
          connectionName: connection.config.name,
          connectionRevision: connection.revision,
          ...bindingAuditSubject(binding.subject)
        }
      });
    }
  }
  if (ended > 0) {
    // A count only: no person, account or client value is logged.
    deps.logger.info(
      { module: "connections", ended },
      "Sign-ins made with a managed OAuth client the instance no longer has, or with an earlier client id, need a new connect"
    );
  }
  return { ended };
}
