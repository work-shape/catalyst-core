import { randomBytes, randomUUID } from "node:crypto";
import {
  AppError,
  CONNECTION_ASSET_KIND,
  CONNECTION_OAUTH_CONNECTED,
  CONNECTION_OAUTH_LANDING_PATH,
  CONNECTION_OAUTH_SESSION_TTL_MS,
  CONNECTION_REFUSALS,
  CREDENTIAL_REFUSALS,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCallError,
  connectionCallReasonOf,
  connectionOAuthError,
  connectionOAuthCallbackPath,
  connectionOAuthReasonOf,
  signInSecretSubject,
  type AuditActor,
  type AuditRecorder,
  type ConnectionSetupSessionRecord,
  type ConnectorOAuthEndpoints,
  type ConnectorSignIn,
  type ConnectorTypeDefinition,
  type EgressGrant,
  type JsonObject,
  type OperationResource
} from "@work-shape/catalyst-core";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "../connection-reads";
import { NO_CREDENTIALS, credentialOriginOf } from "../connector-context";
import { egressTargetOfUrl } from "../egress";
import { createSecretStore, type SecretKeyring } from "../secret-store";
import { onOrigins, resourceAllowed, scopesOf, stateHashOf } from "./checks";
import {
  clientForSignIn,
  clientOfSession,
  type ClientRegistrationDeps
} from "./client-registration";
import { createOAuthFetch, type OAuthFetch } from "./fetch";
import type { OAuthClient, OAuthPort, OAuthServerMetadata } from "./port";
import { createSdkOAuthPort } from "./sdk-adapter";
import { checkedServer, portFailure } from "./server";
import { signInServerOf, staticServerOf, withAuthorizationParams } from "./static-server";
import { writeTokenSet } from "./token-set";

// The shared OAuth sign-in of a Connection (CS-4b2): its start and its callback. The start
// discovers the server, settles the client, and stores a setup session that holds the state as
// a hash and the PKCE verifier sealed. The callback checks the session, the person, their right
// and the Connection's revision, exchanges the code and writes the token set and the binding in
// one transaction. Nothing here writes a token, a code, a verifier, a state or a client secret
// into an answer, an event or a log line.

/** How long the whole start or the whole callback may take. */
export const OAUTH_FLOW_TIMEOUT_MS = 30_000;

/** What `associatedData` of a sealed verifier binds it to: the instance, session and state. */
function verifierAssociatedData(session: {
  clientInstanceId: string;
  id: string;
  connectionAssetId: string;
  stateHash: string;
}): string {
  return [
    "oauth-setup",
    session.clientInstanceId,
    session.id,
    session.connectionAssetId,
    session.stateHash
  ].join("|");
}

/** The audit of a step: the run's recorder, the person and the call's correlation. */
export interface SignInAudit {
  auditRecorder: AuditRecorder;
  actor: AuditActor;
  correlationId: string;
}

/** Who starts a sign-in: a person, with their signed-in session or the key they called with. */
export interface SignInStarter {
  userId: string;
  /** The first-party session's id, or `key:<id>` for a start through a personal key. */
  authSessionId: string;
}

/** Who reaches the callback. Only a person in their first-party session completes one. */
export interface SignInCompleter {
  userId: string;
  /** Set only for a first-party signed-in session; an embedding host's token has none. */
  firstPartySessionId: string | undefined;
}

export interface OAuthStartAnswer {
  /** The id of the session that waits for the callback. It proves nothing and opens nothing. */
  signInId: string;
  authorizationUrl: string;
  providerHost: string;
  scopes: string[];
  expiresAt: string;
}

/** What a callback reads of its query. Untrusted: from the provider through the browser. */
export interface OAuthCallbackQuery {
  state?: string;
  code?: string;
  error?: string;
  iss?: string;
}

export interface ConnectionSignInDeps extends ConnectionOperationSourceDeps {
  keyring?: SecretKeyring;
  /** `instance.publicUrl`: the origin the provider sends the browser back to. */
  publicUrl?: string;
  /** The OAuth port. Left out, the adapter over the MCP SDK. */
  oauth?: OAuthPort;
  now?: () => Date;
}

export interface ConnectionSignIn {
  start(
    name: string,
    input: { starter: SignInStarter; audit: SignInAudit; signal?: AbortSignal }
  ): Promise<OAuthStartAnswer>;
  /**
   * Completes a sign-in. Answers the in-app address to send the browser to. A refusal throws
   * with its reason and, where known, the Connection's name in `details.connection`.
   */
  complete(input: {
    /** The Connection the callback's path names. A session of another one is refused. */
    connectionName: string;
    query: OAuthCallbackQuery;
    completer: SignInCompleter | undefined;
    /** Whether the person holds `connection.write` on the Connection now. */
    mayWrite(resource: OperationResource): boolean;
    audit: SignInAudit;
    signal?: AbortSignal;
  }): Promise<{ location: string; connectionName: string }>;
  /**
   * Whether the sign-in `signInId` of the Connection, started by `userId`, still waits for its
   * callback. `false` once a callback took it, whatever its outcome, once it expired, and for
   * a sign-in of another person or another Connection.
   */
  waiting(connectionName: string, input: { signInId: string; userId: string }): Promise<boolean>;
  /** The redirect URI of a Connection, or nothing without `instance.publicUrl`. */
  redirectUri(connectionName: string): string | undefined;
}

/** The in-app address after a callback. It holds the outcome and the name, nothing else. */
export function signInLandingUrl(
  publicUrl: string,
  outcome: string,
  connectionName?: string
): string {
  const url = new URL(CONNECTION_OAUTH_LANDING_PATH, publicUrl);
  url.searchParams.set("signIn", outcome);
  if (connectionName !== undefined) url.searchParams.set("connection", connectionName);
  return url.href;
}

/** The Connection a refusal of a callback names, for its landing address. */
function withConnection(error: unknown, connectionName: string): unknown {
  if (!(error instanceof AppError)) return error;
  const details = typeof error.details === "object" && error.details !== null ? error.details : {};
  return new AppError(error.code, error.message, { ...details, connection: connectionName });
}

function resourceOf(connection: StoredConnection): OperationResource {
  return {
    kind: CONNECTION_ASSET_KIND,
    id: connection.assetId,
    assetId: connection.assetId,
    name: connection.config.name
  };
}

function signInOf(connection: StoredConnection): {
  type: ConnectorTypeDefinition;
  signIn: ConnectorSignIn;
  settings: JsonObject;
} {
  const { type, config } = connection;
  if (!type?.signIn || config.authScheme !== "oauth" || !type.authSchemes.includes("oauth")) {
    throw connectionCallError(
      "connection_not_configured",
      "the Connection does not sign in with OAuth: its auth scheme is not 'oauth'"
    );
  }
  const settings = type.settingsSchema.safeParse(config.settings);
  if (!settings.success) throw connectionCallError("connection_not_configured");
  return { type, signIn: type.signIn, settings: settings.data };
}

export function createConnectionSignIn(deps: ConnectionSignInDeps): ConnectionSignIn {
  const port = deps.oauth ?? createSdkOAuthPort();
  const now = deps.now ?? (() => new Date());
  const redirectUri = (connectionName: string) =>
    deps.publicUrl === undefined
      ? undefined
      : new URL(connectionOAuthCallbackPath(connectionName), deps.publicUrl).href;

  function registration(keyring: SecretKeyring): ClientRegistrationDeps {
    return {
      clientInstanceId: deps.clientInstanceId,
      store: deps.stores.connections,
      credentials: deps.credentials ?? NO_CREDENTIALS,
      keyring,
      port
    };
  }

  function required(connectionName: string): {
    keyring: SecretKeyring;
    publicUrl: string;
    redirect: string;
  } {
    const redirect = redirectUri(connectionName);
    if (deps.publicUrl === undefined || redirect === undefined) {
      throw connectionOAuthError("oauth_redirect_unconfigured");
    }
    if (!deps.keyring) {
      throw new AppError(
        "CONFLICT",
        `${CONNECTION_REFUSALS.secretStoreUnavailable}: this instance names no key of the Secret Store. An operator names one under 'secretStore.keys'`,
        { reason: CONNECTION_REFUSALS.secretStoreUnavailable }
      );
    }
    return { keyring: deps.keyring, publicUrl: deps.publicUrl, redirect };
  }

  /** The authorization server's metadata, as every step checks it. */
  function serverOf(
    asked: string,
    connectionOrigin: string,
    fetch: OAuthFetch
  ): Promise<OAuthServerMetadata> {
    return checkedServer({ port, issuer: asked, connectionOrigin, fetch });
  }

  async function refused(
    audit: SignInAudit,
    stage: "start" | "callback",
    error: unknown,
    connection?: StoredConnection
  ): Promise<void> {
    const reason =
      connectionOAuthReasonOf(error) ??
      connectionCallReasonOf(error) ??
      (error instanceof AppError && error.code === "FORBIDDEN" ? "forbidden" : undefined);
    if (reason === undefined) return;
    await audit.auditRecorder.record({
      type: "connection.oauth_refused",
      status: "denied",
      actor: audit.actor,
      reason,
      ...(connection === undefined ? {} : { subject: connection.config.name }),
      correlationId: audit.correlationId,
      metadata: {
        stage,
        subjectKind: SHARED_CREDENTIAL_SUBJECT,
        ...(connection === undefined
          ? {}
          : { connectionName: connection.config.name, connectionRevision: connection.revision })
      }
    });
  }

  /** What a start found: the server, the scopes asked for and the client that asks. */
  interface Found {
    server: OAuthServerMetadata;
    scopes: string[];
    client: OAuthClient;
    /** The RFC 8707 `resource` kept on the session. */
    resource: string;
    /** Whether `resource` is sent: never to a server the settings name. */
    sendsResource: boolean;
  }

  /** What a start of one Connection knows before it asks anybody. */
  interface Starting {
    connection: StoredConnection;
    keyring: SecretKeyring;
    origin: string;
    resourceUrl: string;
    fetch: OAuthFetch;
  }

  /**
   * The server the settings name (CONN-OAUTH-1): each of its addresses passes the egress
   * checker now, before the browser is sent anywhere, and the client is the one it issued.
   */
  async function namedServer(
    starting: Starting,
    endpoints: ConnectorOAuthEndpoints
  ): Promise<Found> {
    for (const address of [
      endpoints.authorizationUrl,
      endpoints.tokenUrl,
      endpoints.revocationUrl
    ]) {
      if (address !== undefined) await deps.egress.check(egressTargetOfUrl(address));
    }
    const client = await clientOfSession(registration(starting.keyring), {
      connection: starting.connection,
      origin: starting.origin,
      clientId: endpoints.clientId,
      preregisteredId: endpoints.clientId
    });
    return {
      server: staticServerOf(endpoints),
      scopes: [...endpoints.scopes],
      client,
      // Kept on the session for the record; never sent to a server the settings name.
      resource: starting.resourceUrl,
      sendsResource: false
    };
  }

  /** The server the Connection's server names (CS-4b): discovered, its client registered. */
  async function discoveredServer(
    starting: Starting,
    input: {
      signIn: ConnectorSignIn;
      settings: JsonObject;
      target: EgressGrant;
      redirect: string;
      publicUrl: string;
      audit: SignInAudit;
      signal: AbortSignal;
    }
  ): Promise<Found> {
    const { connection, keyring, origin, resourceUrl, fetch } = starting;
    const { signIn, settings, target, redirect, publicUrl, audit, signal } = input;
    const chosen = signIn.oauthSettings(settings);
    const challenge = await signIn.challenge({ target, settings, signal });
    const connectionOrigin = new URL(resourceUrl).origin;
    // The challenge is the server's answer, so the metadata it names is on the server's origin.
    if (
      challenge?.resourceMetadataUrl !== undefined &&
      !onOrigins(challenge.resourceMetadataUrl, [connectionOrigin])
    ) {
      throw connectionOAuthError(
        "oauth_discovery_failed",
        "the server's challenge names resource metadata on another host than its own"
      );
    }
    let resource;
    try {
      resource = await port.discoverResource({
        resourceUrl,
        ...(challenge?.resourceMetadataUrl === undefined
          ? {}
          : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
        fetch
      });
    } catch (error) {
      throw portFailure(error, "oauth_discovery_failed");
    }
    if (!resourceAllowed(resource.resource, resourceUrl)) {
      throw connectionOAuthError(
        "oauth_discovery_failed",
        "the resource metadata describes another server than the Connection's"
      );
    }
    const asked = resource.authorizationServers[0];
    if (asked === undefined) {
      throw connectionOAuthError(
        "oauth_discovery_failed",
        "the resource metadata names no authorization server"
      );
    }
    const server = await serverOf(asked, connectionOrigin, fetch);
    // The admin's choice, else the challenge's scopes, else all the server lists, else none.
    const scopes = [...(chosen.scopes ?? challenge?.scopes ?? resource.scopesSupported ?? [])];
    const scope = scopes.length > 0 ? scopes.join(" ") : undefined;
    const client = await clientForSignIn(registration(keyring), {
      connection,
      server,
      origin,
      redirectUri: redirect,
      clientName: `Workshape Catalyst (${new URL(publicUrl).host})`,
      preregisteredId: chosen.clientId,
      scope,
      fetch,
      audit
    });
    return { server, scopes, client, resource: resource.resource, sendsResource: true };
  }

  async function start(
    connection: StoredConnection,
    starter: SignInStarter,
    audit: SignInAudit,
    signal: AbortSignal
  ): Promise<OAuthStartAnswer> {
    const { keyring, publicUrl, redirect } = required(connection.config.name);
    const { type, signIn, settings } = signInOf(connection);
    const target = await deps.egress.check(type.target(settings));
    const starting: Starting = {
      connection,
      keyring,
      origin: credentialOriginOf(type, settings, target),
      resourceUrl: signIn.resourceUrl(settings),
      fetch: createOAuthFetch({ egress: deps.egress, signal })
    };
    const endpoints = type.oauthEndpoints?.(settings);
    const found =
      endpoints === undefined
        ? await discoveredServer(starting, {
            signIn,
            settings,
            target,
            redirect,
            publicUrl,
            audit,
            signal
          })
        : await namedServer(starting, endpoints);
    const { server, scopes, client } = found;
    const scope = scopes.length > 0 ? scopes.join(" ") : undefined;
    const state = randomBytes(32).toString("base64url");
    const authorization = await port
      .authorizationUrl({
        server,
        client,
        redirectUri: redirect,
        ...(scope === undefined ? {} : { scope }),
        state,
        ...(found.sendsResource ? { resource: found.resource } : {})
      })
      .catch((error: unknown) => {
        throw portFailure(error, "oauth_discovery_failed");
      });
    const id = `setup_${randomUUID()}`;
    const stateHash = stateHashOf(state);
    const verifier = Buffer.from(authorization.codeVerifier, "utf8");
    let sealed;
    try {
      sealed = keyring.seal({
        plaintext: verifier,
        associatedData: verifierAssociatedData({
          clientInstanceId: deps.clientInstanceId,
          id,
          connectionAssetId: connection.assetId,
          stateHash
        })
      });
    } finally {
      verifier.fill(0);
    }
    const session = await deps.stores.connections.createConnectionSetupSession({
      id,
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: connection.assetId,
      connectionRevision: connection.revision,
      subject: SHARED_CREDENTIAL_SUBJECT,
      actorUserId: starter.userId,
      authSessionId: starter.authSessionId,
      stateHash,
      verifier: sealed,
      redirectUri: redirect,
      issuer: server.issuer,
      resource: found.resource,
      clientId: client.clientId,
      scopes,
      ttlMs: CONNECTION_OAUTH_SESSION_TTL_MS
    });
    return {
      signInId: session.id,
      authorizationUrl: withAuthorizationParams(authorization.url, endpoints),
      providerHost: new URL(server.authorizationEndpoint).host,
      scopes,
      expiresAt: session.expiresAt
    };
  }

  /** The Connection of a session, at the revision the session started on, or a refusal. */
  async function connectionOfSession(
    session: ConnectionSetupSessionRecord
  ): Promise<StoredConnection> {
    const connection = (await readConnections(deps)).find(
      (candidate) => candidate.assetId === session.connectionAssetId
    );
    if (!connection) throw connectionOAuthError("oauth_connection_changed");
    if (connection.revision !== session.connectionRevision) {
      throw withConnection(
        connectionOAuthError("oauth_connection_changed"),
        connection.config.name
      );
    }
    return connection;
  }

  async function complete(
    session: ConnectionSetupSessionRecord,
    connection: StoredConnection,
    query: OAuthCallbackQuery,
    audit: SignInAudit,
    signal: AbortSignal
  ): Promise<void> {
    const { keyring } = required(connection.config.name);
    // The config of the session's revision: what the start discovered and signed in for.
    const { type, signIn, settings } = signInOf(connection);
    const target = await deps.egress.check(type.target(settings));
    const origin = credentialOriginOf(type, settings, target);
    if (query.error !== undefined) throw connectionOAuthError("oauth_denied");
    if (query.code === undefined || query.code.length === 0) {
      throw connectionOAuthError("oauth_state_invalid", "the provider sent no code");
    }
    const fetch = createOAuthFetch({ egress: deps.egress, signal });
    const { server, endpoints } = await signInServerOf({
      port,
      type,
      settings,
      issuer: session.issuer,
      connectionOrigin: new URL(signIn.resourceUrl(settings)).origin,
      fetch
    });
    if (endpoints !== undefined) {
      // A server the settings name: its `iss` is compared with the issuer they name, if any.
      if (
        endpoints.issuer !== undefined &&
        query.iss !== undefined &&
        query.iss !== endpoints.issuer
      ) {
        throw connectionOAuthError("oauth_issuer_mismatch");
      }
    } else if (server.authorizationResponseIssParameterSupported || query.iss !== undefined) {
      // RFC 9207: a server that names itself in its answer must name the issuer asked.
      if (query.iss !== server.issuer) throw connectionOAuthError("oauth_issuer_mismatch");
    }
    const opened = keyring.open({
      ...session.verifier,
      associatedData: verifierAssociatedData(session)
    });
    if (opened === undefined) throw connectionOAuthError("oauth_state_invalid");
    const codeVerifier = opened.toString("utf8");
    opened.fill(0);
    const client = await clientOfSession(registration(keyring), {
      connection,
      origin,
      clientId: session.clientId,
      preregisteredId: signIn.oauthSettings(settings).clientId
    });
    let tokens;
    try {
      tokens = await port.exchange({
        server,
        client,
        code: query.code,
        codeVerifier,
        redirectUri: session.redirectUri,
        ...(endpoints === undefined ? { resource: session.resource } : {}),
        fetch
      });
    } catch (error) {
      throw portFailure(error, "oauth_denied");
    }
    const granted = tokens.scope === undefined ? session.scopes : scopesOf(tokens.scope);
    const { text: tokenSet, accessExpiresAt } = writeTokenSet({
      tokens,
      issuedAt: now().getTime(),
      origin: { issuer: server.issuer, resource: session.resource, clientId: client.clientId }
    });

    // One transaction: the Connection is held at the session's revision, the token set is
    // stored for the origin of that revision, and the binding names it. A write of the
    // Connection waits; one that landed before is seen here and refuses everything.
    await deps.stores.transaction(async (stores) => {
      const held = await stores.configAssets.getConfigAsset({
        clientInstanceId: deps.clientInstanceId,
        kind: CONNECTION_ASSET_KIND,
        name: connection.config.name,
        lock: "share"
      });
      if (
        !held ||
        held.status !== "active" ||
        held.id !== session.connectionAssetId ||
        held.revision !== session.connectionRevision
      ) {
        throw connectionOAuthError("oauth_connection_changed");
      }
      const key = {
        clientInstanceId: deps.clientInstanceId,
        connectionAssetId: session.connectionAssetId,
        subject: SHARED_CREDENTIAL_SUBJECT
      };
      const previous = await stores.connections.getConnectionBinding(key);
      const written = await createSecretStore({
        clientInstanceId: deps.clientInstanceId,
        keyring,
        store: stores.connections
      }).put({
        binding: {
          connectionAssetId: session.connectionAssetId,
          subject: signInSecretSubject(SHARED_CREDENTIAL_SUBJECT)
        },
        value: tokenSet,
        source: "runtime",
        ...(previous === undefined ? {} : { handle: previous.secretHandle }),
        origin
      });
      const connected = await stores.connections.connectConnectionBinding({
        ...key,
        scheme: "oauth",
        grantedScopes: granted,
        secretHandle: written.handle,
        secretVersion: written.version,
        ...(accessExpiresAt === undefined ? {} : { accessExpiresAt }),
        connectedBy: session.actorUserId,
        origin,
        expectedRowVersion: previous?.rowVersion ?? null
      });
      if (!connected) {
        throw new AppError(
          "CONFLICT",
          `${CREDENTIAL_REFUSALS.notConnected}: another sign-in of the Connection landed at the same time`,
          { reason: CREDENTIAL_REFUSALS.notConnected }
        );
      }
    });
    await deps.stores.connections.putConnectionState({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: session.connectionAssetId,
      health: "unknown",
      lastErrorCode: null
    });
    await audit.auditRecorder.record({
      type: "connection.binding_connected",
      status: "success",
      actor: audit.actor,
      subject: connection.config.name,
      correlationId: audit.correlationId,
      metadata: {
        connectionName: connection.config.name,
        connectionRevision: connection.revision,
        subjectKind: SHARED_CREDENTIAL_SUBJECT,
        scopes: granted
      }
    });
  }

  function deadline(outer: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(OAUTH_FLOW_TIMEOUT_MS);
    return outer ? AbortSignal.any([outer, timeout]) : timeout;
  }

  return {
    redirectUri,

    async start(name, { starter, audit, signal }) {
      const connection = await readConnection(deps, name);
      if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
      try {
        return await start(connection, starter, audit, deadline(signal));
      } catch (error) {
        await refused(audit, "start", error, connection);
        throw error;
      }
    },

    async waiting(name, { signInId, userId }) {
      const connection = await readConnection(deps, name);
      if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
      const session = await deps.stores.connections.readWaitingConnectionSetupSession({
        clientInstanceId: deps.clientInstanceId,
        id: signInId
      });
      return session?.actorUserId === userId && session.connectionAssetId === connection.assetId;
    },

    async complete({ connectionName, query, completer, mayWrite, audit, signal }) {
      let connection: StoredConnection | undefined;
      try {
        // Only a person in their own signed-in browser completes a sign-in: an embedding
        // host's token or a key proves no browser of the person who was asked.
        if (completer?.firstPartySessionId === undefined) {
          throw connectionOAuthError("oauth_requires_person");
        }
        if (query.state === undefined || query.state.length === 0 || query.state.length > 512) {
          throw connectionOAuthError("oauth_state_invalid");
        }
        const consumed = await deps.stores.connections.consumeConnectionSetupSession({
          clientInstanceId: deps.clientInstanceId,
          stateHash: stateHashOf(query.state)
        });
        if (consumed.outcome === "unknown") throw connectionOAuthError("oauth_state_invalid");
        if (consumed.outcome === "expired") throw connectionOAuthError("oauth_session_expired");
        const { session } = consumed;
        // The person who started, in the session they started from. A start through a
        // personal key is completed in any first-party session of the same person.
        const sameSession =
          session.authSessionId.startsWith("key:") ||
          session.authSessionId === completer.firstPartySessionId;
        if (session.actorUserId !== completer.userId || !sameSession) {
          throw connectionOAuthError("oauth_state_invalid");
        }
        connection = await connectionOfSession(session);
        // The browser came back to the address of the Connection whose client asked: a code
        // of one authorization server cannot complete the sign-in of another Connection, also
        // where the server sends no `iss`.
        if (
          connection.config.name !== connectionName ||
          session.redirectUri !== redirectUri(connectionName)
        ) {
          throw connectionOAuthError("oauth_state_invalid");
        }
        if (!mayWrite(resourceOf(connection))) {
          throw new AppError(
            "FORBIDDEN",
            "forbidden: connecting the Connection needs the right connection.write",
            { reason: "forbidden" }
          );
        }
        await complete(session, connection, query, audit, deadline(signal));
        const location = signInLandingUrl(
          required(connection.config.name).publicUrl,
          CONNECTION_OAUTH_CONNECTED,
          connection.config.name
        );
        return { location, connectionName: connection.config.name };
      } catch (error) {
        await refused(audit, "callback", error, connection);
        throw connection === undefined ? error : withConnection(error, connection.config.name);
      }
    }
  };
}
