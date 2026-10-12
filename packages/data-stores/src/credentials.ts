import { randomBytes } from "node:crypto";
import {
  createConnectionCredentialResolver,
  createSecretStore,
  type SecretKeyring
} from "@vivd-catalyst/connections";
import type { ClientInstanceId, ConnectionsStore, SecretBinding } from "@vivd-catalyst/core";

/** The two roles of a store: the one its rows are reached as, and the one that changes its schema. */
export type DataStoreRole = "app" | "migration";

/**
 * What the Secret Store keeps per store: the password of each role, and the key the platform
 * signs its record of applied migrations with, which no role of the store ever holds.
 */
type DataStoreSecret = DataStoreRole | "ledger";

/** The bytes of a secret before encoding. It is random and nobody types it. */
const DATA_STORE_PASSWORD_BYTES = 32;

/**
 * The secrets of a store, kept in the Secret Store and bound to the store's asset. A password
 * leaves this object only towards a connection that is being opened and towards the verifier
 * Postgres is sent, and the ledger key only towards the signature of a migration's record.
 */
export interface DataStoreCredentials {
  /** The secret, or nothing where none is stored or the stored one cannot be opened. */
  read(
    rows: ConnectionsStore,
    storeId: string,
    secret: DataStoreSecret
  ): Promise<string | undefined>;
  /** The secret, made and stored when `read` has none. */
  ensure(rows: ConnectionsStore, storeId: string, secret: DataStoreSecret): Promise<string>;
}

function bindingOf(storeId: string, secret: DataStoreSecret): SecretBinding {
  return { connectionAssetId: storeId, subject: `data_store:${secret}` };
}

export function createDataStoreCredentials(input: {
  clientInstanceId: ClientInstanceId;
  keyring: SecretKeyring;
}): DataStoreCredentials {
  const credentials: DataStoreCredentials = {
    async read(rows, storeId, role) {
      const options = { ...input, store: rows };
      const binding = bindingOf(storeId, role);
      const status = await createSecretStore(options).status(binding);
      return status.state === "set" && status.handle !== undefined
        ? createConnectionCredentialResolver(options).resolve({ handle: status.handle, binding })
        : undefined;
    },
    async ensure(rows, storeId, role) {
      const stored = await credentials.read(rows, storeId, role);
      if (stored !== undefined) return stored;
      const password = randomBytes(DATA_STORE_PASSWORD_BYTES).toString("base64url");
      await createSecretStore({ ...input, store: rows }).put({
        binding: bindingOf(storeId, role),
        value: password,
        source: "runtime"
      });
      return password;
    }
  };
  return credentials;
}
