import {
  signInSecretSubject,
  type ConnectionBindingEndReason,
  type ConnectionBindingRecord,
  type ConnectionProviderRevocation
} from "./connection-bindings";
import { SHARED_CREDENTIAL_SUBJECT, type ConnectionsStore } from "./connections";
import type { AuditActor } from "./audit";
import type { ClientInstanceId } from "./ids";

// The end of a sign-in: Disconnect, and what deleting a Connection or changing where or how it
// reaches its system does to the binding it had.

/**
 * Ends the shared sign-in of a Connection: the binding becomes `revoked` with `reason` and its
 * token set is deleted, so going back to the old address or scheme finds no binding to use and
 * needs a new sign-in (a revert never restores a binding or a token). It asks no provider;
 * whoever holds the token set's plaintext does that after the change committed. Answers the
 * binding as it was before, or nothing where there was none or it was revoked already. A
 * binding already revoked, or none, leaves only the token set to delete.
 */
export async function endConnectionSignIn(
  store: Pick<
    ConnectionsStore,
    "getConnectionBinding" | "changeConnectionBindingState" | "deleteSecrets"
  >,
  key: { clientInstanceId: ClientInstanceId; connectionAssetId: string; subject?: string },
  end: { reason: ConnectionBindingEndReason; changedBy?: string }
): Promise<ConnectionBindingRecord | undefined> {
  const bindingKey = { ...key, subject: key.subject ?? SHARED_CREDENTIAL_SUBJECT };
  let ended: ConnectionBindingRecord | undefined;
  // Two tries: a refresh or a sign-in may change the row between the read and the write.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const binding = await store.getConnectionBinding({ ...bindingKey, lock: "update" });
    if (binding === undefined || binding.state === "revoked") break;
    const changed = await store.changeConnectionBindingState({
      ...bindingKey,
      expectedRowVersion: binding.rowVersion,
      state: "revoked",
      reason: end.reason,
      ...(end.changedBy === undefined ? {} : { changedBy: end.changedBy })
    });
    if (changed !== undefined) {
      ended = binding;
      break;
    }
  }
  await store.deleteSecrets({ ...key, subject: signInSecretSubject(bindingKey.subject) });
  return ended;
}

/**
 * What a write of a Connection does to its sign-in inside the write's transaction. The asset
 * kind brings it where the instance has a Secret Store: only there can the token set be read
 * before it is deleted, so that the provider can be asked to revoke the grant.
 */
export interface ConnectionSignInEnding {
  /**
   * Ends the shared sign-in inside the transaction whose stores are given: the token set is
   * read into memory, the binding revoked and the token set deleted. Answers what tells the
   * provider once the transaction committed, or nothing where there was no sign-in.
   */
  end(
    stores: { connections: ConnectionsStore },
    input: {
      /** Explicit only inside owner Disconnect; bulk cleanup never decrypts personal tokens. */
      subject?: string;
      connectionAssetId: string;
      connectionName: string;
      connectionRevision: number;
      /** The Connection's config the sign-in was made under: where the provider is found. */
      config: unknown;
      reason: ConnectionBindingEndReason;
      actor?: AuditActor;
      correlationId?: string;
    }
  ): Promise<ConnectionSignInEnded | undefined>;
}

/** A sign-in that was ended in a transaction that has to commit before the provider is told. */
export interface ConnectionSignInEnded {
  /**
   * Asks the provider to revoke the grant (RFC 7009), best effort, records
   * `connection.binding_revoked` and answers what the provider said. Called once, after the
   * commit; never throws.
   */
  revokeAtProvider(): Promise<ConnectionProviderRevocation>;
  /** Forgets the token set without asking the provider, where the transaction rolled back. */
  discard(): void;
}
