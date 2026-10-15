import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject
} from "node:crypto";
import {
  AppError,
  CREDENTIAL_REFUSALS,
  SECRET_WRITE_CONFLICT,
  SecretNotResolvedError,
  createConnectionSecretHandle,
  type ClientInstanceId,
  type ConnectionCredentialResolver,
  type ConnectionsStore,
  type SecretBinding,
  type SecretResolver,
  type SecretStore,
  type StoredSecretRecord
} from "@work-shape/catalyst-core";

// The Secret Store: AES-256-GCM over one secret per Connection and subject. A fresh random
// nonce for every encryption, and associated data that binds a row to its instance, its
// Connection, its subject, its version and the origin it was set for, so a row copied under
// another Connection, or given another origin, does not open. Nothing in this file logs, and no error it throws carries a value or key material.

const CIPHER = "aes-256-gcm";
/** The length of an AES-256 key. `secretStore.keys` names keys of exactly this length. */
export const SECRET_STORE_KEY_BYTES = 32;
/** The nonce of one encryption. It is random and never reused on purpose. */
export const SECRET_STORE_NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/**
 * The longest secret the store takes. A bearer key or a password is far shorter; the bound
 * keeps a mistaken file from becoming a row.
 */
export const SECRET_VALUE_MAX_BYTES = 16 * 1024;

/** One entry of release config `secretStore.keys`: an id and the name of the secret. */
export interface SecretStoreKeyConfig {
  id: string;
  ref: string;
}

/**
 * The keys of the Secret Store in this process. The first one encrypts, every one decrypts.
 * It hands out no key: it only encrypts and decrypts.
 */
export interface SecretKeyring {
  /** The id of the key new rows are encrypted with. */
  readonly encryptingKeyId: string;
  /** The ids of the configured keys that resolved. */
  readonly keyIds: readonly string[];
  seal(input: { plaintext: Buffer; associatedData: string }): {
    keyId: string;
    nonce: Buffer;
    ciphertext: Buffer;
  };
  /** The plaintext, or `undefined` where no configured key opens the row. */
  open(input: {
    keyId: string;
    nonce: Uint8Array;
    ciphertext: Uint8Array;
    associatedData: string;
  }): Buffer | undefined;
}

/** Why the keys of the Secret Store stop startup. It names the variable and never a value. */
export class SecretStoreKeyError extends AppError {
  readonly secretName: string;

  constructor(secretName: string, reason: string) {
    super("VALIDATION_FAILED", `The Secret Store key '${secretName}' ${reason}`);
    this.name = "SecretStoreKeyError";
    this.secretName = secretName;
  }
}

function decodeKey(name: string, encoded: string): KeyObject {
  const text = encoded.trim();
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/u.test(text) ? Buffer.from(text, "base64") : undefined;
  try {
    if (bytes?.length !== SECRET_STORE_KEY_BYTES) {
      throw new SecretStoreKeyError(
        name,
        `must be ${SECRET_STORE_KEY_BYTES} random bytes in base64`
      );
    }
    return createSecretKey(bytes);
  } finally {
    // The key object holds its own copy.
    bytes?.fill(0);
  }
}

/**
 * Resolves the keys of `secretStore.keys` through the instance's secret resolver. The first
 * key is required: without it nothing can be encrypted, and the error names its variable. A
 * later key that is absent is left out and reported by name, and the rows it encrypted read
 * as unreadable.
 */
export async function loadSecretKeyring(input: {
  keys: readonly SecretStoreKeyConfig[];
  secrets: SecretResolver;
  /** Told the name of each later key that did not resolve. */
  onMissingKey?: (key: SecretStoreKeyConfig) => void;
}): Promise<SecretKeyring> {
  const [first] = input.keys;
  if (!first) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Connections need a Secret Store key: name one under 'secretStore.keys'"
    );
  }
  const loaded = new Map<string, KeyObject>();
  for (const key of input.keys) {
    let encoded: string;
    try {
      encoded = await input.secrets.resolve(key.ref);
    } catch (error) {
      if (!(error instanceof SecretNotResolvedError)) throw error;
      if (key === first || error.kind === "unusable") {
        throw new SecretStoreKeyError(key.ref, error.reason);
      }
      input.onMissingKey?.(key);
      continue;
    }
    loaded.set(key.id, decodeKey(key.ref, encoded));
  }
  return createSecretKeyring(first.id, loaded);
}

function createSecretKeyring(
  encryptingKeyId: string,
  keys: ReadonlyMap<string, KeyObject>
): SecretKeyring {
  const encryptingKey = keys.get(encryptingKeyId);
  if (!encryptingKey) {
    throw new AppError("INTERNAL", "The Secret Store has no encrypting key");
  }
  const keyring: SecretKeyring = {
    encryptingKeyId,
    keyIds: Object.freeze([...keys.keys()]),
    seal({ plaintext, associatedData }) {
      const nonce = randomBytes(SECRET_STORE_NONCE_BYTES);
      const cipher = createCipheriv(CIPHER, encryptingKey, nonce, {
        authTagLength: AUTH_TAG_BYTES
      });
      cipher.setAAD(Buffer.from(associatedData, "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag()
      ]);
      return { keyId: encryptingKeyId, nonce, ciphertext };
    },
    open({ keyId, nonce, ciphertext, associatedData }) {
      const key = keys.get(keyId);
      if (!key || nonce.length !== SECRET_STORE_NONCE_BYTES || ciphertext.length < AUTH_TAG_BYTES) {
        return undefined;
      }
      const body = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_BYTES);
      const tag = ciphertext.subarray(ciphertext.length - AUTH_TAG_BYTES);
      try {
        const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: AUTH_TAG_BYTES });
        decipher.setAAD(Buffer.from(associatedData, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // A wrong key, a changed row or associated data of another Connection: one answer.
        return undefined;
      }
    }
  };
  return Object.freeze(keyring);
}

/**
 * The associated data of one row: `instance|connection asset id|subject|secret version`, and
 * `|origin` where the secret is bound to one. A part that held the separator could read as
 * another binding, so such a part is refused.
 */
export function secretAssociatedData(input: {
  clientInstanceId: string;
  binding: SecretBinding;
  version: number;
  origin?: string;
}): string {
  const parts = [
    input.clientInstanceId,
    input.binding.connectionAssetId,
    input.binding.subject,
    String(input.version),
    ...(input.origin === undefined ? [] : [input.origin])
  ];
  if (parts.some((part) => part === "" || part.includes("|"))) {
    throw new AppError("INTERNAL", "A secret binding holds a part that cannot be bound");
  }
  return parts.join("|");
}

interface SecretStoreOptions {
  clientInstanceId: ClientInstanceId;
  keyring: SecretKeyring;
  /** The rows. Inside a transaction, the store bound to it. */
  store: ConnectionsStore;
}

/** Opens a row for the binding the caller names, never for the one the row claims. */
function openRecord(
  options: Pick<SecretStoreOptions, "clientInstanceId" | "keyring">,
  record: StoredSecretRecord,
  binding: SecretBinding
): Buffer | undefined {
  return options.keyring.open({
    keyId: record.keyId,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    associatedData: secretAssociatedData({
      clientInstanceId: options.clientInstanceId,
      binding,
      version: record.version,
      ...(record.origin === undefined ? {} : { origin: record.origin })
    })
  });
}

/** The Secret Store over the rows of one instance. See `SecretStore`: it has no read. */
export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const { clientInstanceId, keyring, store } = options;
  return {
    async put({ binding, value, source, handle: firstHandle, expectedVersion, origin }) {
      const plaintext = Buffer.from(value, "utf8");
      try {
        if (plaintext.length === 0 || plaintext.length > SECRET_VALUE_MAX_BYTES) {
          throw new AppError(
            "VALIDATION_FAILED",
            `A secret is between 1 and ${SECRET_VALUE_MAX_BYTES} bytes (SECRET_VALUE_MAX_BYTES)`
          );
        }
        const stored = await store.findSecret({ clientInstanceId, binding });
        // A secret set for another origin is none for this one: nobody who enters one for
        // this origin saw it, and no call of this origin is handed it.
        const current = stored?.origin === origin ? stored : undefined;
        if (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion) {
          throw new AppError(
            "CONFLICT",
            `${SECRET_WRITE_CONFLICT}: the secret was changed by somebody else since it was read. Nothing was stored; read the Connection again`,
            { reason: SECRET_WRITE_CONFLICT }
          );
        }
        if (current) {
          const opened = openRecord(options, current, binding);
          try {
            if (
              opened?.length === plaintext.length &&
              timingSafeEqual(opened, plaintext) &&
              current.keyId === keyring.encryptingKeyId &&
              // Who set a secret decides who may replace it. The same value from another
              // source is a write: it makes the secret the new source's.
              current.source === source
            ) {
              return { handle: current.handle, version: current.version, changed: false };
            }
          } finally {
            opened?.fill(0);
          }
        }
        // The handle stays with the Connection across versions: its revision names it. The
        // row of another origin is replaced by the version that follows it.
        const handle = stored?.handle ?? firstHandle ?? createConnectionSecretHandle();
        const version = (stored?.version ?? 0) + 1;
        const sealed = keyring.seal({
          plaintext,
          associatedData: secretAssociatedData({ clientInstanceId, binding, version, origin })
        });
        const written = await store.putSecret({
          handle,
          clientInstanceId,
          connectionAssetId: binding.connectionAssetId,
          subject: binding.subject,
          version,
          keyId: sealed.keyId,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          source,
          ...(origin === undefined ? {} : { origin })
        });
        if (!written) {
          // Another write of this secret landed between the read and the write. Which value
          // stays is that writer's; this one is told, and stores nothing.
          throw new AppError(
            "CONFLICT",
            `${SECRET_WRITE_CONFLICT}: the secret was written by somebody else at the same time. Nothing was stored; try again`,
            { reason: SECRET_WRITE_CONFLICT }
          );
        }
        return { handle, version, changed: true };
      } finally {
        plaintext.fill(0);
      }
    },
    async status(binding) {
      const record = await store.findSecret({ clientInstanceId, binding });
      if (!record) {
        return { state: "not_set" };
      }
      const opened = openRecord(options, record, binding);
      opened?.fill(0);
      return {
        state: opened ? "set" : "unreadable",
        handle: record.handle,
        version: record.version,
        source: record.source
      };
    },
    async delete(binding) {
      await store.deleteSecrets({
        clientInstanceId,
        connectionAssetId: binding.connectionAssetId,
        subject: binding.subject
      });
    }
  };
}

/**
 * The connector auth component's way to a value. It reads one row by its handle and opens it
 * for the binding of the call. A secret set for another origin than the call's is not opened
 * and answers `connection_not_configured`: it is entered again for the origin the Connection
 * has now. A handle of another Connection, a copied row and a key that is gone all answer
 * `secret_unreadable`; none of them says more.
 */
export function createConnectionCredentialResolver(
  options: SecretStoreOptions
): ConnectionCredentialResolver {
  const { clientInstanceId, store } = options;
  return {
    async resolve({ handle, binding, origin }) {
      const record = await store.getSecret({ clientInstanceId, handle });
      if (!record) {
        throw new AppError(
          "CONFLICT",
          `${CREDENTIAL_REFUSALS.notConfigured}: the Connection has no stored secret`,
          { reason: CREDENTIAL_REFUSALS.notConfigured }
        );
      }
      // Fails closed: whatever moved the Connection and left its secret, the secret is not
      // sent to an origin it was not set for.
      if (origin !== undefined && record.origin !== origin) {
        throw new AppError(
          "CONFLICT",
          `${CREDENTIAL_REFUSALS.notConfigured}: the stored secret was set for another address of the Connection. Enter it again for this one`,
          { reason: CREDENTIAL_REFUSALS.notConfigured }
        );
      }
      const opened =
        record.connectionAssetId === binding.connectionAssetId && record.subject === binding.subject
          ? openRecord(options, record, binding)
          : undefined;
      if (!opened) {
        throw new AppError(
          "CONFLICT",
          `${CREDENTIAL_REFUSALS.unreadable}: the stored secret cannot be opened with the configured keys`,
          { reason: CREDENTIAL_REFUSALS.unreadable }
        );
      }
      try {
        return opened.toString("utf8");
      } finally {
        opened.fill(0);
      }
    }
  };
}
