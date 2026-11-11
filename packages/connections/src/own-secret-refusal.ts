import { timingSafeEqual } from "node:crypto";
import {
  AppError,
  CREDENTIAL_REFUSALS,
  ownSecretSubject,
  type ClientInstanceId,
  type ConnectionCredentialResolver,
  type PlatformStores
} from "@work-shape/catalyst-core";

// A person's own token that the server refused (PMCP-6): a 401 to a call or to the owner's
// discovery that carried it. The binding goes to `needs_reconnect` and the token is deleted in
// one transaction; the person pastes a new one. Nothing of the token is written anywhere.

/** Why a person's own token was refused, as the binding's reason and the audit's. */
const OWN_TOKEN_REFUSED_REASON = "unauthorized";

/**
 * Refuses the person's stored token where it is still the one the server refused: read again,
 * compared in constant time, and refused at the version it was read at under the binding's
 * lock, so a token the person replaced meanwhile is left alone. Answers whether it refused.
 */
export async function refuseOwnToken(
  deps: {
    clientInstanceId: ClientInstanceId;
    stores: PlatformStores;
    credentials: ConnectionCredentialResolver | undefined;
  },
  input: {
    connectionAssetId: string;
    connectionName: string;
    connectionRevision: number;
    /** `user:<id>`, derived from the acting person. */
    subject: string;
    /** The token the server answered 401 to. */
    refused: string;
    correlationId: string;
  }
): Promise<boolean> {
  const { clientInstanceId, stores, credentials } = deps;
  const key = {
    clientInstanceId,
    connectionAssetId: input.connectionAssetId,
    subject: input.subject
  };
  const binding = await stores.connections.getConnectionOwnSecret(key);
  if (binding?.state !== "connected" || credentials?.resolveOwnSecret === undefined) return false;
  const current = await credentials
    .resolveOwnSecret({ ...key, origin: binding.origin })
    .catch(() => undefined);
  if (current === undefined || !sameToken(current.value, input.refused)) return false;
  return stores.transaction(async (tx) => {
    const held = await tx.connections.getConnectionOwnSecret({ ...key, lock: "update" });
    if (held?.state !== "connected" || held.secretVersion !== current.secretVersion) return false;
    const refused = await tx.connections.refuseConnectionOwnSecret({
      ...key,
      secretVersion: held.secretVersion,
      reason: OWN_TOKEN_REFUSED_REASON
    });
    if (refused === undefined) return false;
    await tx.connections.deleteSecrets({
      clientInstanceId,
      connectionAssetId: input.connectionAssetId,
      subject: ownSecretSubject(input.subject)
    });
    await tx.audit.appendAuditEvent({
      clientInstanceId,
      type: "connection.binding_needs_reconnect",
      status: "failed",
      // As a refused sign-in's refresh records it: the server refused, nobody acted.
      actor: { displayLabel: "System", roles: [] },
      subject: input.connectionName,
      reason: OWN_TOKEN_REFUSED_REASON,
      correlationId: input.correlationId,
      metadata: {
        connectionName: input.connectionName,
        connectionRevision: input.connectionRevision,
        personal: true,
        scheme: "static",
        subjectKind: "user",
        userId: held.userId
      }
    });
    return true;
  });
}

/** What a call or a discovery answers once the server refused the person's own token. */
export function ownTokenRefusedError(): AppError {
  return new AppError(
    "CONFLICT",
    `${CREDENTIAL_REFUSALS.needsReconnect}: the server refused your token. Paste a new one under Settings > You > Connections`,
    {
      reason: CREDENTIAL_REFUSALS.needsReconnect,
      state: "needs_reconnect",
      cause: OWN_TOKEN_REFUSED_REASON
    }
  );
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } finally {
    a.fill(0);
    b.fill(0);
  }
}
