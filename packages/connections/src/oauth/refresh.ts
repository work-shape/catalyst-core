import { randomUUID } from "node:crypto";
import {
  AppError,
  CREDENTIAL_REFUSALS,
  SHARED_CREDENTIAL_SUBJECT,
  StoreBackedAuditRecorder,
  connectionCallError,
  connectionOAuthReasonOf,
  signInSecretSubject,
  type AuditActor,
  type ClientInstanceId,
  type ConnectionBindingKey,
  type ConnectionBindingRecord,
  type ConnectionBindingRefusal,
  type ConnectionCredentialResolver,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type Logger,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { readConnections, type StoredConnection } from "../connection-reads";
import { connectionOriginOf } from "../connector-context";
import { createSecretStore, openSignInTokenSet, type SecretKeyring } from "../secret-store";
import { scopesOf } from "./checks";
import { bindingAuditSubject } from "../personal-bindings";
import { clientOfSession } from "./client-registration";
import { createOAuthFetch } from "./fetch";
import { OAuthPortError, type OAuthPort } from "./port";
import { createSdkOAuthPort } from "./sdk-adapter";
import { signInServerOf } from "./static-server";
import { writeTokenSet, type StoredTokenSet } from "./token-set";

// The access token of a sign-in as a call is handed it, refreshed where it is about to expire
// (CS-4b3). One process at a time refreshes a binding: it takes the binding's lease in the
// database, reads the binding again, and uses what another process wrote meanwhile where the
// row version moved. Otherwise it asks the token endpoint with the refresh token and
// `resource`, and writes the new token set as the next secret version and the binding in one
// transaction, under compare-and-swap on the row version. Inside one process the calls that
// need the same refresh share it, so twenty calls make one request.
//
// A refusal of the grant (`invalid_grant`, `invalid_client`) sets the binding to
// `needs_reconnect` and deletes the token set: a refused refresh token is worth nothing and is
// one thing less to leak. The call then answers `connection_needs_reconnect` and never falls
// back to the Connection's own secret. Nothing here logs or answers a token.

/** How long before its expiry an access token is refreshed. */
export const SIGN_IN_REFRESH_AHEAD_MS = 60_000;
/** How long one refresh may hold a binding's lease. */
export const SIGN_IN_REFRESH_LEASE_MS = 30_000;
/** How long a call waits for another process's refresh before it answers `connection_busy`. */
export const SIGN_IN_REFRESH_WAIT_MS = 5_000;
/** How often a call that waits for another process's refresh reads the binding again. */
const SIGN_IN_REFRESH_POLL_MS = 100;
/** How long one refresh request may take, from the metadata read to the token's answer. */
const SIGN_IN_REFRESH_TIMEOUT_MS = 15_000;

/** A shared binding no call used for this long is refreshed by the keep-alive (question 4). */
export const SIGN_IN_KEEP_ALIVE_IDLE_MS = 7 * 24 * 60 * 60_000;
/** How many bindings one keep-alive tick refreshes at most. */
const SIGN_IN_KEEP_ALIVE_BATCH = 50;

const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

/** A sign-in the outside system refused, as the instance is told of it. */
export interface SignInRefusal {
  connection: StoredConnection;
  subject?: string;
  reason: Exclude<ConnectionBindingRefusal, "insufficient_scope">;
}

export interface SignInTokensDeps {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  connectorTypes: ConnectorTypeRegistry;
  egress: EgressChecker;
  keyring: SecretKeyring;
  /** The Connection's own secrets: where a client's secret is read from. */
  credentials: ConnectionCredentialResolver;
  logger: Logger;
  /** The OAuth port. Left out, the adapter over the MCP SDK. */
  oauth?: OAuthPort;
  now?: () => Date;
  /**
   * Told once a binding fell to `needs_reconnect`, after its event was recorded: the Inbox
   * notice of those who may connect the Connection again. A failure is logged.
   */
  onRefused?(refusal: SignInRefusal): Promise<void>;
  /** For tests: how long a call waits for another process's refresh. */
  waitMs?: number;
}

export interface SignInTokens {
  /** As `ConnectionCredentialResolver.resolveSignIn`, refreshed where due. */
  accessToken(input: {
    connectionAssetId: string;
    subject?: string;
    origin: string;
    refused?: string;
    signal?: AbortSignal;
  }): Promise<string>;
  /**
   * Refreshes the shared bindings no call used for `SIGN_IN_KEEP_ALIVE_IDLE_MS`, under the same
   * lease. Personal bindings are never asked for. Answers how many were refreshed and failed.
   */
  keepAlive(input: { signal: AbortSignal }): Promise<{ refreshed: number; failed: number }>;
}

/** The resolver of a process that refreshes: the Connection's own secrets as before. */
export function withSignInRefresh(
  base: ConnectionCredentialResolver,
  tokens: SignInTokens
): ConnectionCredentialResolver {
  return {
    resolve: (input) => base.resolve(input),
    resolveSignIn: (input) => tokens.accessToken(input)
  };
}

function notConnected(): AppError {
  return new AppError(
    "CONFLICT",
    `${CREDENTIAL_REFUSALS.notConnected}: nobody has signed in for the Connection's address`,
    { reason: CREDENTIAL_REFUSALS.notConnected }
  );
}

function needsReconnect(cause?: string): AppError {
  return new AppError(
    "CONFLICT",
    `${CREDENTIAL_REFUSALS.needsReconnect}: the outside system refused the Connection's sign-in`,
    {
      reason: CREDENTIAL_REFUSALS.needsReconnect,
      state: "needs_reconnect",
      ...(cause === undefined ? {} : { cause })
    }
  );
}

/**
 * What a binding that is not usable for `origin` answers: a refused one asks for a new
 * sign-in, one that ended or was made for another origin is none, and a Connection deleted
 * meanwhile is gone.
 */
function refusalOf(binding: ConnectionBindingRecord | undefined, origin: string): AppError {
  if (binding?.origin === origin && binding.state === "needs_reconnect")
    return needsReconnect(binding.stateReason);
  if (binding?.origin === origin && binding.stateReason === "deleted") {
    return connectionCallError("connection_unavailable");
  }
  return notConnected();
}

function usable(binding: ConnectionBindingRecord | undefined, origin: string): boolean {
  return binding?.state === "connected" && binding.origin === origin;
}

/** Whether a token set needs a refresh now: it expires within the margin, or was refused. */
function due(tokenSet: StoredTokenSet, now: number, refused: string | undefined): boolean {
  if (refused !== undefined && refused === tokenSet.accessToken) return true;
  if (tokenSet.expiresAt === undefined) return false;
  return Date.parse(tokenSet.expiresAt) - now <= SIGN_IN_REFRESH_AHEAD_MS;
}

function stillValid(tokenSet: StoredTokenSet, now: number): boolean {
  return tokenSet.expiresAt === undefined || Date.parse(tokenSet.expiresAt) > now;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(connectionCallError("upstream_timeout"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(connectionCallError("upstream_timeout"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rejects when the signal ends, so a call that stops does not wait for a shared refresh. */
function untilAborted<Value>(
  work: Promise<Value>,
  signal: AbortSignal | undefined
): Promise<Value> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(connectionCallError("upstream_timeout"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(connectionCallError("upstream_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export function createSignInTokens(deps: SignInTokensDeps): SignInTokens {
  const { clientInstanceId, stores, keyring } = deps;
  const port = deps.oauth ?? createSdkOAuthPort();
  const now = deps.now ?? (() => new Date());
  const waitMs = deps.waitMs ?? SIGN_IN_REFRESH_WAIT_MS;
  /** The lease owner of this process. */
  const owner = `refresh_${randomUUID()}`;
  const audit = new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit });
  /** The refresh under way per binding in this process, which the calls that need it share. */
  const running = new Map<string, Promise<string>>();
  /** The day each binding's use was last noted by this process. */
  const noted = new Map<string, string>();

  const keyOf = (connectionAssetId: string, subject: string): ConnectionBindingKey => ({
    clientInstanceId,
    connectionAssetId,
    subject
  });
  const secrets = (store = stores.connections) => ({ clientInstanceId, keyring, store });

  /** Notes the use of a binding once a day per process. A failure changes nothing of the call. */
  async function noteUse(connectionAssetId: string, subject: string): Promise<void> {
    const id = JSON.stringify([connectionAssetId, subject]);
    const today = now().toISOString().slice(0, 10);
    if (noted.get(id) === today) return;
    noted.set(id, today);
    try {
      await stores.connections.noteConnectionBindingUse(keyOf(connectionAssetId, subject));
    } catch {
      noted.delete(id);
      deps.logger.warn(
        { module: "connections" },
        "The use of a Connection's sign-in was not noted"
      );
    }
  }

  async function connectionOf(connectionAssetId: string): Promise<StoredConnection | undefined> {
    return (await readConnections(deps)).find(
      (connection) => connection.assetId === connectionAssetId
    );
  }

  /** Records a refusal and tells whoever files the notice. Never throws. */
  async function told(refusal: SignInRefusal): Promise<void> {
    const { connection, reason } = refusal;
    try {
      await audit.record({
        type: "connection.binding_needs_reconnect",
        status: "failed",
        actor: SYSTEM_ACTOR,
        subject: connection.config.name,
        reason,
        correlationId: `sign_in_${randomUUID()}`,
        metadata: {
          connectionName: connection.config.name,
          connectionRevision: connection.revision,
          ...bindingAuditSubject(refusal.subject ?? SHARED_CREDENTIAL_SUBJECT)
        }
      });
      if (!refusal.subject?.startsWith("user:")) await deps.onRefused?.(refusal);
    } catch {
      deps.logger.warn(
        { module: "connections", connection: connection.config.name, reason },
        "A refused sign-in of a Connection was not recorded"
      );
    }
  }

  /**
   * Sets a binding the provider refused to `needs_reconnect` and deletes its token set, in one
   * transaction at the row version the refresher read.
   */
  async function refuse(
    binding: ConnectionBindingRecord,
    reason: Exclude<ConnectionBindingRefusal, "insufficient_scope">
  ): Promise<void> {
    const changed = await stores.transaction(async (tx) => {
      const moved = await tx.connections.changeConnectionBindingState({
        ...keyOf(binding.connectionAssetId, binding.subject),
        expectedRowVersion: binding.rowVersion,
        state: "needs_reconnect",
        reason
      });
      if (moved === undefined) return false;
      await tx.connections.deleteSecrets({
        clientInstanceId,
        connectionAssetId: binding.connectionAssetId,
        subject: signInSecretSubject(binding.subject)
      });
      return true;
    });
    if (!changed) return;
    const connection = await connectionOf(binding.connectionAssetId);
    if (connection) await told({ connection, reason, subject: binding.subject });
  }

  /**
   * One refresh of a binding this process holds the lease of, read at `leased`. Answers the
   * new access token, or the stored one where the refresh failed and it is still valid.
   */
  async function refreshLeased(
    leased: ConnectionBindingRecord,
    tokenSet: StoredTokenSet,
    origin: string
  ): Promise<string> {
    const connection = await connectionOf(leased.connectionAssetId);
    if (!connection?.type?.signIn) throw connectionCallError("connection_unavailable");
    const { issuer, resource, clientId, refreshToken } = tokenSet;
    // A sign-in without a refresh token, or stored before its token set named its issuer, is
    // worth its access token until that expires, and then a new sign-in.
    if (
      refreshToken === undefined ||
      issuer === undefined ||
      resource === undefined ||
      clientId === undefined
    ) {
      if (stillValid(tokenSet, now().getTime())) return tokenSet.accessToken;
      await refuse(leased, "invalid_grant");
      throw needsReconnect("invalid_grant");
    }
    const settings = connection.type.settingsSchema.safeParse(connection.config.settings);
    if (!settings.success) throw connectionCallError("connection_not_configured");
    // The Connection is read now, after the binding: a write may have landed in between. The
    // refresh token and the client secret go only to the server of this very config, so it
    // must still be bound to the origin the sign-in was made for (its target, the full
    // addresses of the server it names, the issuer and the client). A write that changed one
    // of them ended the sign-in in its transaction; nothing is sent.
    if (connectionOriginOf(connection.type, connection.config) !== origin) throw notConnected();
    const signal = AbortSignal.timeout(SIGN_IN_REFRESH_TIMEOUT_MS);
    const fetch = createOAuthFetch({ egress: deps.egress, signal });
    let tokens;
    try {
      const { server, endpoints } = await signInServerOf({
        port,
        type: connection.type,
        settings: settings.data,
        issuer,
        connectionOrigin: new URL(connection.type.signIn.resourceUrl(settings.data)).origin,
        fetch
      });
      const client = await clientOfSession(
        {
          clientInstanceId,
          store: stores.connections,
          credentials: deps.credentials,
          keyring,
          port
        },
        {
          connection,
          origin,
          clientId,
          preregisteredId: connection.type.signIn.oauthSettings(settings.data).clientId
        }
      );
      // A server the settings name is sent no `resource`, as at the sign-in.
      tokens = await port.refresh({
        server,
        client,
        refreshToken,
        ...(endpoints === undefined ? { resource } : {}),
        fetch
      });
    } catch (error) {
      if (
        error instanceof OAuthPortError &&
        (error.failure === "invalid_grant" || error.failure === "invalid_client")
      ) {
        await refuse(leased, error.failure);
        throw needsReconnect(error.failure);
      }
      // The settings now name another authorization server at the same origins (another
      // token path or issuer): the sign-in was made at the old one, and only a new one helps.
      if (connectionOAuthReasonOf(error) === "oauth_connection_changed") {
        await refuse(leased, "invalid_client");
        throw needsReconnect("invalid_client");
      }
      // Anything else may pass: the token that is still valid is used, else the call fails
      // as an outage of the outside system, and the next call tries again.
      deps.logger.warn(
        { module: "connections", connection: connection.config.name },
        "The sign-in of a Connection could not be refreshed"
      );
      if (stillValid(tokenSet, now().getTime())) return tokenSet.accessToken;
      throw connectionCallError("connection_unavailable");
    }
    const written = writeTokenSet({
      tokens,
      issuedAt: now().getTime(),
      origin: { issuer, resource, clientId },
      ...(refreshToken === undefined ? {} : { previousRefreshToken: refreshToken }),
      ...(tokenSet.scope === undefined ? {} : { previousScope: tokenSet.scope })
    });
    const stored = await stores
      .transaction(async (tx) => {
        const held = await tx.connections.getConnectionBinding({
          ...keyOf(leased.connectionAssetId, leased.subject),
          lock: "update"
        });
        if (
          held?.rowVersion !== leased.rowVersion ||
          held.state !== "connected" ||
          held.leaseOwner !== owner
        ) {
          throw new AppError("CONFLICT", "The binding changed");
        }
        const secret = await createSecretStore(secrets(tx.connections)).put({
          binding: {
            connectionAssetId: leased.connectionAssetId,
            subject: signInSecretSubject(leased.subject)
          },
          value: written.text,
          source: "runtime",
          handle: leased.secretHandle,
          expectedVersion: leased.secretVersion,
          origin
        });
        const refreshed = await tx.connections.refreshConnectionBinding({
          ...keyOf(leased.connectionAssetId, leased.subject),
          owner,
          expectedRowVersion: leased.rowVersion,
          secretVersion: secret.version,
          grantedScopes:
            written.scope === undefined ? leased.grantedScopes : scopesOf(written.scope),
          accessExpiresAt: written.accessExpiresAt ?? null
        });
        // The binding changed under the lease: a Disconnect, a new sign-in or a lost lease.
        // Nothing of this refresh is kept; the call reads what is stored now.
        if (refreshed === undefined) throw new AppError("CONFLICT", "The binding changed");
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof AppError && error.code === "CONFLICT") return false;
        throw error;
      });
    if (!stored) {
      // The discarded refresh's token is never answered: it may be the grant of the account
      // a reconnect replaced. The call acts through what is stored now, or not at all.
      const current = await stores.connections.getConnectionBinding(
        keyOf(leased.connectionAssetId, leased.subject)
      );
      if (current === undefined || !usable(current, origin)) throw refusalOf(current, origin);
      const currentSet = await openSignInTokenSet(secrets(), { ...current, origin });
      if (stillValid(currentSet, now().getTime())) return currentSet.accessToken;
      throw connectionCallError("connection_busy");
    }
    return tokens.accessToken;
  }

  /**
   * The refresh of a binding, across processes: under the lease, or by waiting for the one
   * that holds it. `seen` is the binding the caller read, `refused` the token a 401 refused.
   */
  async function refresh(
    seen: ConnectionBindingRecord,
    origin: string,
    refused: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<string> {
    const key = keyOf(seen.connectionAssetId, seen.subject);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const leased = await stores.connections.takeConnectionBindingLease({
        ...key,
        owner,
        leaseMs: SIGN_IN_REFRESH_LEASE_MS
      });
      if (leased !== undefined) {
        try {
          if (!usable(leased, origin)) throw refusalOf(leased, origin);
          const tokenSet = await openSignInTokenSet(secrets(), { ...leased, origin });
          // Another process refreshed between the caller's read and the lease.
          if (leased.rowVersion !== seen.rowVersion && !due(tokenSet, now().getTime(), refused)) {
            return tokenSet.accessToken;
          }
          return await refreshLeased(leased, tokenSet, origin);
        } finally {
          await stores.connections.releaseConnectionBindingLease({ ...key, owner }).catch(() => {
            deps.logger.warn({ module: "connections" }, "A sign-in's lease was not given back");
          });
        }
      }
      // Another process refreshes. Its result is read as soon as it is written; a binding that
      // ended, or a Connection deleted, stops the wait.
      if (Date.now() >= deadline) throw connectionCallError("connection_busy");
      await wait(SIGN_IN_REFRESH_POLL_MS, signal);
      const current = await stores.connections.getConnectionBinding(key);
      if (!usable(current, origin) || current === undefined) throw refusalOf(current, origin);
      if (current.rowVersion !== seen.rowVersion) {
        const tokenSet = await openSignInTokenSet(secrets(), { ...current, origin });
        if (!due(tokenSet, now().getTime(), refused)) return tokenSet.accessToken;
      }
    }
  }

  /** The shared refresh of this process for a binding, which every call that needs it joins. */
  function sharedRefresh(
    seen: ConnectionBindingRecord,
    origin: string,
    refused: string | undefined
  ): Promise<string> {
    const id = JSON.stringify([seen.connectionAssetId, seen.subject]);
    const under = running.get(id);
    if (under) return under;
    // The refresh runs to its end whoever stops waiting for it: another call may need it.
    const started = refresh(seen, origin, refused, undefined).finally(() => running.delete(id));
    running.set(id, started);
    return started;
  }

  return {
    async accessToken({
      connectionAssetId,
      subject = SHARED_CREDENTIAL_SUBJECT,
      origin,
      refused,
      signal
    }) {
      const binding = await stores.connections.getConnectionBinding(
        keyOf(connectionAssetId, subject)
      );
      if (!usable(binding, origin) || binding === undefined) throw refusalOf(binding, origin);
      const tokenSet = await openSignInTokenSet(secrets(), { ...binding, origin });
      await noteUse(connectionAssetId, subject);
      // A token another call refreshed since this one was refused is the newer one.
      if (refused !== undefined && refused !== tokenSet.accessToken) return tokenSet.accessToken;
      if (!due(tokenSet, now().getTime(), refused)) return tokenSet.accessToken;
      return untilAborted(sharedRefresh(binding, origin, refused), signal);
    },

    async keepAlive({ signal }) {
      const idle = await stores.connections.listIdleConnectionBindings({
        clientInstanceId,
        // Never a personal binding: no system path decrypts a personal token.
        subject: SHARED_CREDENTIAL_SUBJECT,
        idleMs: SIGN_IN_KEEP_ALIVE_IDLE_MS,
        limit: SIGN_IN_KEEP_ALIVE_BATCH
      });
      let refreshed = 0;
      let failed = 0;
      for (const binding of idle) {
        if (signal.aborted) break;
        try {
          const connection = await connectionOf(binding.connectionAssetId);
          if (
            binding.subject !== SHARED_CREDENTIAL_SUBJECT ||
            connection?.config.credentialMode !== "shared"
          )
            continue;
          const tokenSet = await openSignInTokenSet(secrets(), binding);
          // Refused as if a call had been: the refresh runs whatever the expiry says.
          await sharedRefresh(binding, binding.origin, tokenSet.accessToken);
          refreshed += 1;
        } catch {
          failed += 1;
        }
      }
      return { refreshed, failed };
    }
  };
}
