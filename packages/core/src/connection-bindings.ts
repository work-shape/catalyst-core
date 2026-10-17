import {
  CONNECTION_PROVIDER_REVOCATIONS,
  type ConnectionBindingState,
  type ConnectionProviderRevocation
} from "@work-shape/catalyst-asset-schemas";
import type { ClientInstanceId } from "./ids";

export { CONNECTION_PROVIDER_REVOCATIONS };
export type { ConnectionBindingState, ConnectionProviderRevocation };

// A Connection's sign-in at its outside system: the binding that says whose account the
// Connection acts through and in which state that sign-in is, and the short-lived setup
// session of a sign-in that is under way. Both are runtime state, never an asset revision,
// and neither holds a token: the token set is a secret of the Secret Store that the binding
// names by handle and version.

/**
 * Why a binding was ended by the platform or a person: Disconnect, the Connection deleted,
 * moved to another origin, or set to another auth scheme. Each is the `reason` of
 * `connection.binding_revoked` and the binding's `stateReason`.
 */
export const CONNECTION_BINDING_END_REASONS = [
  "disconnect",
  "deleted",
  "origin_changed",
  "scheme_changed"
] as const;
export type ConnectionBindingEndReason = (typeof CONNECTION_BINDING_END_REASONS)[number];

/**
 * Why a refresh or a call refused the sign-in itself, each the `reason` of
 * `connection.binding_needs_reconnect`.
 */
export const CONNECTION_BINDING_REFUSALS = [
  "invalid_grant",
  "invalid_client",
  "insufficient_scope"
] as const;
export type ConnectionBindingRefusal = (typeof CONNECTION_BINDING_REFUSALS)[number];

/** How the binding was obtained. `static` is reserved for DT-3 and CS-9a. */
export type ConnectionBindingScheme = "oauth";

/**
 * The subject of the secret that holds a binding's token set: `oauth:<binding subject>`, so
 * `oauth:shared` for the shared binding. It is never the subject of the Connection's own
 * secret, which an administrator types.
 */
export function signInSecretSubject(bindingSubject: string): string {
  return `oauth:${bindingSubject}`;
}

/** Which binding: one per Connection and credential subject. */
export interface ConnectionBindingKey {
  clientInstanceId: ClientInstanceId;
  connectionAssetId: string;
  /** `shared`, later `user:<id>` or `test`. Derived by the platform, never named by a caller. */
  subject: string;
}

export interface ConnectionBindingRecord extends ConnectionBindingKey {
  /** The person a personal binding belongs to. Absent on a shared binding. */
  userId?: string;
  state: ConnectionBindingState;
  scheme: ConnectionBindingScheme;
  /** The outside account as the provider reports it. Never written into a log or an event. */
  accountId?: string;
  accountLabel?: string;
  grantedScopes: string[];
  /** The Secret Store handle and version of the token set. */
  secretHandle: string;
  secretVersion: number;
  accessExpiresAt?: string;
  lastRefreshedAt?: string;
  connectedAt: string;
  connectedBy?: string;
  /** The day of the last call that used the binding, `YYYY-MM-DD`. */
  lastUsedOn?: string;
  stateChangedAt: string;
  stateChangedBy?: string;
  /** Why the state changed last, as a reason code. Absent while connected. */
  stateReason?: string;
  /**
   * The origin (`egressOriginOf`) the sign-in was made for. A binding is used for that origin
   * only, so it never follows its Connection to another server.
   */
  origin: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** Rises by one with every change of the row. Every change names the version it read. */
  rowVersion: number;
}

/** A completed sign-in, as it becomes a connected binding. */
export interface ConnectionBindingSignIn extends ConnectionBindingKey {
  userId?: string;
  scheme: ConnectionBindingScheme;
  accountId?: string;
  accountLabel?: string;
  grantedScopes: readonly string[];
  secretHandle: string;
  secretVersion: number;
  accessExpiresAt?: string;
  connectedBy?: string;
  origin: string;
}

/**
 * One sign-in under way, from its start to its callback. It holds no state value and no
 * verifier in the clear: the state as a hash, the PKCE verifier sealed with a key of the
 * Secret Store's keyring.
 */
export interface ConnectionSetupSessionRecord {
  id: string;
  clientInstanceId: ClientInstanceId;
  connectionAssetId: string;
  /** The Connection's revision at the start. A callback on another revision is refused. */
  connectionRevision: number;
  subject: string;
  /** The person who started it, and their signed-in session. */
  actorUserId: string;
  authSessionId: string;
  stateHash: string;
  verifier: { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array };
  redirectUri: string;
  issuer: string;
  /**
   * The `resource` the authorization request named, from the protected resource metadata. The
   * code exchange sends the same value.
   */
  resource: string;
  /** The OAuth client the authorization request named. The code exchange uses the same one. */
  clientId: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
}

/** What a callback finds for its state. An expired session is gone after it was asked for. */
export type ConsumedConnectionSetupSession =
  | { outcome: "consumed"; session: ConnectionSetupSessionRecord }
  | { outcome: "expired" }
  | { outcome: "unknown" };

/** The rows of bindings and setup sessions. Times are the database's. */
export interface ConnectionBindingsStore {
  getConnectionBinding(key: ConnectionBindingKey): Promise<ConnectionBindingRecord | undefined>;
  /**
   * Writes a completed sign-in as a connected binding. `expectedRowVersion` is the version the
   * writer read: `null` creates the binding, a number replaces that version of it, as a new
   * sign-in does. Answers the stored binding, or `undefined` and writes nothing where the row
   * is not what the writer read.
   */
  connectConnectionBinding(
    input: ConnectionBindingSignIn & { expectedRowVersion: number | null }
  ): Promise<ConnectionBindingRecord | undefined>;
  /**
   * Moves a binding out of `connected`, at the row version the caller read. Answers the
   * changed binding, or `undefined` and changes nothing where the version is another.
   */
  changeConnectionBindingState(
    input: ConnectionBindingKey & {
      expectedRowVersion: number;
      state: Exclude<ConnectionBindingState, "connected">;
      reason: string;
      changedBy?: string;
    }
  ): Promise<ConnectionBindingRecord | undefined>;
  /**
   * Takes the binding's lease for `owner` until `leaseMs` from now, when nobody holds it, it
   * ran out, or `owner` holds it already. Answers the binding as it is now, with its row
   * version to read again, or `undefined` where another owner holds a live lease.
   */
  takeConnectionBindingLease(
    input: ConnectionBindingKey & { owner: string; leaseMs: number }
  ): Promise<ConnectionBindingRecord | undefined>;
  /** Gives the lease back. `false` where `owner` does not hold it, because it ran out. */
  releaseConnectionBindingLease(input: ConnectionBindingKey & { owner: string }): Promise<boolean>;
  /**
   * Writes a refresh: the token set's new secret version, its access expiry and the granted
   * scopes, and `lastRefreshedAt` now. Only while the binding is connected, at the row version
   * the refresher read, and while `owner` holds the lease. Answers the changed binding, or
   * `undefined` and changes nothing.
   */
  refreshConnectionBinding(
    input: ConnectionBindingKey & {
      owner: string;
      expectedRowVersion: number;
      secretVersion: number;
      grantedScopes: readonly string[];
      /** `null` where the new access token has no expiry. */
      accessExpiresAt: string | null;
    }
  ): Promise<ConnectionBindingRecord | undefined>;
  /**
   * Notes that a call used the binding today, by the database's date. It changes no row
   * version, so a refresh under way is not made to fail; a binding noted today is left alone.
   */
  noteConnectionBindingUse(key: ConnectionBindingKey): Promise<void>;
  /**
   * The connected `oauth` bindings of one subject whose last use, last refresh and sign-in
   * are all older than `idleMs`, the oldest first. The keep-alive asks for `shared` only.
   */
  listIdleConnectionBindings(input: {
    clientInstanceId: ClientInstanceId;
    subject: string;
    idleMs: number;
    limit: number;
  }): Promise<ConnectionBindingRecord[]>;
  /** Stores a new session that expires `ttlMs` from now. */
  createConnectionSetupSession(
    input: Omit<ConnectionSetupSessionRecord, "createdAt" | "expiresAt"> & { ttlMs: number }
  ): Promise<ConnectionSetupSessionRecord>;
  /**
   * Takes the session of a state out of the store, in one statement: a session is consumed
   * once. One that expired is removed too and answered as `expired`.
   */
  consumeConnectionSetupSession(input: {
    clientInstanceId: ClientInstanceId;
    stateHash: string;
  }): Promise<ConsumedConnectionSetupSession>;
  /** Removes the sessions that expired. Answers how many. */
  sweepExpiredConnectionSetupSessions(input: {
    clientInstanceId: ClientInstanceId;
  }): Promise<number>;
}
