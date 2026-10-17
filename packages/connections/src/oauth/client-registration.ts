import {
  CREDENTIAL_REFUSALS,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCallReasonOf,
  connectionOAuthError,
  type AuditActor,
  type AuditRecorder,
  type ClientInstanceId,
  type ConnectionCredentialResolver,
  type ConnectionsStore,
  type JsonValue
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { StoredConnection } from "../connection-reads";
import { createSecretStore, type SecretKeyring } from "../secret-store";
import { issuersMatch } from "./checks";
import type { OAuthFetch } from "./fetch";
import { OAuthPortError, type OAuthClient, type OAuthPort, type OAuthServerMetadata } from "./port";

// Which OAuth client a sign-in uses. A client id in the Connection's settings is one the
// provider issued (pre-registered); its secret, if it has one, is the Connection's own secret.
// Otherwise the client the platform registered by Dynamic Client Registration for this
// server, origin and redirect URI, or a new registration where the server offers one. The
// registration result is runtime state on `connection_state.oauth_client`; a client secret it
// returns goes into the Connection's own secret slot, and the state notes its version so it is
// never handed to a pre-registered client.

/** What `connection_state.oauth_client` holds. Never a client secret. */
const registeredClientSchema = z.object({
  issuer: z.string(),
  clientId: z.string(),
  method: z.string(),
  registeredAt: z.string(),
  origin: z.string(),
  redirectUri: z.string(),
  /** The version of the Connection's own secret that holds the client secret, where one came. */
  secretVersion: z.number().int().positive().optional()
});

export type RegisteredOAuthClient = z.infer<typeof registeredClientSchema>;

/** The registered client of the Connection's state, or nothing where it holds none. */
export function registeredClientOf(
  value: JsonValue | undefined
): RegisteredOAuthClient | undefined {
  const read = registeredClientSchema.safeParse(value);
  return read.success ? read.data : undefined;
}

export interface ClientRegistrationDeps {
  clientInstanceId: ClientInstanceId;
  store: ConnectionsStore;
  credentials: ConnectionCredentialResolver;
  keyring: SecretKeyring;
  port: OAuthPort;
}

/** The Connection's own secret for `origin` with its version, or nothing where none is set. */
async function ownSecret(
  deps: ClientRegistrationDeps,
  connection: StoredConnection,
  origin: string
): Promise<{ value: string; version: number } | undefined> {
  const binding = { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT };
  const record = await deps.store.findSecret({ clientInstanceId: deps.clientInstanceId, binding });
  if (!record || record.origin !== origin) return undefined;
  try {
    const value = await deps.credentials.resolve({ handle: record.handle, binding, origin });
    return { value, version: record.version };
  } catch (error) {
    // A secret of another origin counts as none; an unreadable one is told.
    if (connectionCallReasonOf(error) === CREDENTIAL_REFUSALS.notConfigured) return undefined;
    throw error;
  }
}

/** The client a sign-in started with, at its callback: its id and, where it has one, secret. */
export async function clientOfSession(
  deps: ClientRegistrationDeps,
  input: {
    connection: StoredConnection;
    origin: string;
    clientId: string;
    preregisteredId: string | undefined;
  }
): Promise<OAuthClient> {
  const { connection, origin, clientId } = input;
  const registered = registeredClientOf(connection.state?.oauthClient);
  const secret = await ownSecret(deps, connection, origin);
  if (input.preregisteredId === clientId) {
    const isRegistrationSecret =
      registered?.secretVersion !== undefined && registered.secretVersion === secret?.version;
    return {
      clientId,
      ...(secret === undefined || isRegistrationSecret ? {} : { clientSecret: secret.value })
    };
  }
  if (registered?.clientId === clientId) {
    return {
      clientId,
      tokenEndpointAuthMethod: registered.method,
      ...(registered.secretVersion !== undefined && registered.secretVersion === secret?.version
        ? { clientSecret: secret.value }
        : {})
    };
  }
  return { clientId };
}

/**
 * The client a new sign-in uses, registering one where needed. Answers the client and, for a
 * new registration, the issuer host for the audit event.
 */
export async function clientForSignIn(
  deps: ClientRegistrationDeps,
  input: {
    connection: StoredConnection;
    server: OAuthServerMetadata;
    origin: string;
    redirectUri: string;
    clientName: string;
    preregisteredId: string | undefined;
    scope: string | undefined;
    fetch: OAuthFetch;
    audit: { recorder: AuditRecorder; actor: AuditActor; correlationId: string };
  }
): Promise<OAuthClient> {
  const { connection, server, origin, redirectUri } = input;
  if (input.preregisteredId !== undefined) {
    return clientOfSession(deps, {
      connection,
      origin,
      clientId: input.preregisteredId,
      preregisteredId: input.preregisteredId
    });
  }
  const registered = registeredClientOf(connection.state?.oauthClient);
  if (
    registered !== undefined &&
    issuersMatch(registered.issuer, server.issuer) &&
    registered.origin === origin &&
    registered.redirectUri === redirectUri
  ) {
    return clientOfSession(deps, {
      connection,
      origin,
      clientId: registered.clientId,
      preregisteredId: undefined
    });
  }
  if (server.registrationEndpoint === undefined)
    throw connectionOAuthError("oauth_client_required");

  let client;
  try {
    client = await deps.port.register({
      server,
      clientName: input.clientName,
      redirectUri,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      fetch: input.fetch
    });
  } catch (error) {
    if (error instanceof OAuthPortError) throw connectionOAuthError("oauth_registration_refused");
    throw error;
  }
  // The server stores the redirect URIs it will send a browser to. Any other than ours could
  // carry a code elsewhere.
  if (client.redirectUris.length !== 1 || client.redirectUris[0] !== redirectUri) {
    throw connectionOAuthError(
      "oauth_registration_refused",
      "the authorization server registered other redirect URIs than the instance's"
    );
  }
  let secretVersion: number | undefined;
  if (client.clientSecret !== undefined) {
    const written = await createSecretStore({
      clientInstanceId: deps.clientInstanceId,
      keyring: deps.keyring,
      store: deps.store
    }).put({
      binding: { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT },
      value: client.clientSecret,
      source: "runtime",
      ...(connection.config.secretHandle === undefined
        ? {}
        : { handle: connection.config.secretHandle }),
      origin
    });
    secretVersion = written.version;
  }
  const method =
    client.tokenEndpointAuthMethod ??
    (client.clientSecret === undefined ? "none" : "client_secret_basic");
  const state: RegisteredOAuthClient = {
    issuer: server.issuer,
    clientId: client.clientId,
    method,
    registeredAt: new Date().toISOString(),
    origin,
    redirectUri,
    ...(secretVersion === undefined ? {} : { secretVersion })
  };
  await deps.store.putConnectionOAuthClient({
    clientInstanceId: deps.clientInstanceId,
    connectionAssetId: connection.assetId,
    oauthClient: state
  });
  await input.audit.recorder.record({
    type: "connection.oauth_client_registered",
    status: "success",
    actor: input.audit.actor,
    subject: connection.config.name,
    correlationId: input.audit.correlationId,
    metadata: {
      connectionName: connection.config.name,
      connectionRevision: connection.revision,
      issuerHost: new URL(server.issuer).host,
      method: "dcr"
    }
  });
  return {
    clientId: client.clientId,
    tokenEndpointAuthMethod: method,
    ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret })
  };
}
