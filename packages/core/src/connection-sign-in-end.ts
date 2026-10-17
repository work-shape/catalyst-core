import { signInSecretSubject } from "./connection-bindings";
import { SHARED_CREDENTIAL_SUBJECT, type ConnectionsStore } from "./connections";
import type { ClientInstanceId } from "./ids";

// The platform's own end of a sign-in, apart from Disconnect: what a change of where or how a
// Connection reaches its system does to the binding it had.

/**
 * Ends the shared sign-in of a Connection that left its server or stopped signing in: the
 * binding becomes `revoked` and its token set is deleted, so going back to the old address
 * or scheme finds no binding to use and needs a new sign-in (a revert never restores a
 * binding or a token). The provider is not asked to revoke; Disconnect does that (CS-4b3).
 * A binding already revoked, or none, leaves only the token set to delete.
 */
export async function endConnectionSignIn(
  store: Pick<
    ConnectionsStore,
    "getConnectionBinding" | "changeConnectionBindingState" | "deleteSecrets"
  >,
  key: { clientInstanceId: ClientInstanceId; connectionAssetId: string }
): Promise<void> {
  const bindingKey = { ...key, subject: SHARED_CREDENTIAL_SUBJECT };
  // Two tries: a refresh or a sign-in may change the row between the read and the write.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const binding = await store.getConnectionBinding(bindingKey);
    if (binding === undefined || binding.state === "revoked") break;
    const changed = await store.changeConnectionBindingState({
      ...bindingKey,
      expectedRowVersion: binding.rowVersion,
      state: "revoked",
      reason: "oauth_connection_changed"
    });
    if (changed !== undefined) break;
  }
  await store.deleteSecrets({ ...key, subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT) });
}
