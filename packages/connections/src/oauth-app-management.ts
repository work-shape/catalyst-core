import {
  AppError,
  CONNECTION_REFUSALS,
  CREDENTIAL_REFUSALS,
  SHARED_CREDENTIAL_SUBJECT,
  connectionOAuthServerOf,
  type ConnectorOAuthEndpoints,
  type PlatformStores
} from "@work-shape/catalyst-core";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { connectionOriginOf } from "./connector-context";
import { oauthAppsByServer, putOAuthApp, sameSecret, type OAuthAppView } from "./oauth/oauth-apps";
import { openSecretRecord, type SecretKeyring } from "./secret-store";

// Setting an instance's OAuth app (OAUTH-APP) from one Connection: its authorization server and
// client id are the app's, and the secret is typed, or adopted from the Connection's own. The
// same transaction deletes each own secret that is an exact copy of the app's: nothing is lost,
// and the Connections then use the app. A Connection with another secret keeps its own.

/** What the write answers: the app, never its secret, and whose copies it deleted. */
export interface OAuthAppWritten extends OAuthAppView {
  /** The Connections whose own copy of the secret was deleted, by name. */
  moved: string[];
}

export interface OAuthAppInput {
  /** The client secret. Left out, the named Connection's own secret is adopted. */
  value?: string;
  /** The app's version the writer saw, `null` for none. */
  expectedVersion: number | null;
  /** The Connection's revision the writer read: the server and client id are that revision's. */
  expectedRevision: number;
}

type Deps = ConnectionOperationSourceDeps & { keyring?: SecretKeyring };

/** The server a Connection's settings name, where it can use an app; nothing otherwise. */
function oauthAppEndpointsOf(connection: StoredConnection): ConnectorOAuthEndpoints | undefined {
  const { type, config } = connection;
  if (config.authScheme !== "oauth" || type?.oauthEndpoints === undefined) return undefined;
  const settings = type.settingsSchema.safeParse(config.settings);
  if (!settings.success) return undefined;
  try {
    const endpoints = type.oauthEndpoints(settings.data);
    return endpoints?.managedClient === undefined ? endpoints : undefined;
  } catch {
    return undefined;
  }
}

function refusal(reason: string, sentence: string): AppError {
  return new AppError("CONFLICT", `${reason}: ${sentence}`, { reason });
}

export function createOAuthAppManagement(deps: Deps) {
  /** The Connection's own secret for its address, opened, with its version, or nothing. */
  async function ownSecretOf(
    stores: PlatformStores,
    keyring: SecretKeyring,
    connection: StoredConnection
  ): Promise<{ value: string; nonce: Uint8Array } | undefined> {
    const origin = connection.type
      ? connectionOriginOf(connection.type, connection.config)
      : undefined;
    const binding = { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT };
    const record = await stores.connections.findSecret({
      clientInstanceId: deps.clientInstanceId,
      binding
    });
    // A secret set for another address, or by the environment, is not the writer's to move.
    if (!record || origin === undefined || record.origin !== origin || record.source !== "runtime")
      return undefined;
    const value = openSecretRecord(
      { clientInstanceId: deps.clientInstanceId, keyring },
      record,
      binding
    );
    return value === undefined ? undefined : { value, nonce: record.nonce };
  }

  /** Whether the Connection holds a secret for its address, from any source. */
  async function hasOwnSecret(stores: PlatformStores, connection: StoredConnection) {
    const origin = connection.type
      ? connectionOriginOf(connection.type, connection.config)
      : undefined;
    const record = await stores.connections.findSecret({
      clientInstanceId: deps.clientInstanceId,
      binding: { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT }
    });
    return record !== undefined && origin !== undefined && record.origin === origin;
  }

  return {
    /**
     * The app of the Connection's server, where the instance has one; `inUse` where the
     * Connection has its client id and no secret of its own (`withoutOwnSecret`).
     */
    async appOf(
      connection: StoredConnection,
      withoutOwnSecret: boolean
    ): Promise<{ clientId: string; version: number; inUse: boolean } | undefined> {
      const endpoints = oauthAppEndpointsOf(connection);
      if (endpoints === undefined) return undefined;
      const app = await deps.stores.connections.getOAuthApp({
        clientInstanceId: deps.clientInstanceId,
        server: connectionOAuthServerOf(endpoints)
      });
      if (app === undefined) return undefined;
      return {
        clientId: app.clientId,
        version: app.version,
        inUse: withoutOwnSecret && app.clientId === endpoints.clientId
      };
    },

    /** The app of each server the instance has one for, by server. Public values only. */
    oauthApps: () =>
      oauthAppsByServer({
        clientInstanceId: deps.clientInstanceId,
        store: deps.stores.connections
      }),

    /**
     * Sets or replaces the instance's OAuth app of the server and client id the Connection
     * names, with the value given or the Connection's own secret, and deletes each own secret
     * that equals it. The caller decided the instance-wide right.
     */
    async setOAuthApp(name: string, input: OAuthAppInput): Promise<OAuthAppWritten> {
      const { keyring } = deps;
      if (!keyring) {
        throw refusal(
          CONNECTION_REFUSALS.secretStoreUnavailable,
          "this instance names no key of the Secret Store. An operator names one under 'secretStore.keys'"
        );
      }
      return deps.stores.transaction(async (stores) => {
        const connection = await readConnection({ ...deps, stores }, name, { held: true });
        if (!connection) throw new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
        if (connection.config.origin === "release") {
          throw new AppError(
            "FORBIDDEN",
            `${CONNECTION_REFUSALS.readOnlyOrigin}: this Connection is defined in release config, and its secret comes from the environment`,
            { reason: CONNECTION_REFUSALS.readOnlyOrigin }
          );
        }
        if (connection.revision !== input.expectedRevision) {
          throw refusal(
            CONNECTION_REFUSALS.changedSinceRead,
            "the Connection was changed by somebody else since it was read. Nothing was stored; read the Connection again"
          );
        }
        const endpoints = oauthAppEndpointsOf(connection);
        if (endpoints === undefined) {
          throw refusal(
            CONNECTION_REFUSALS.oauthAppUnsupported,
            "an OAuth app is for a Connection that signs in with OAuth at a server its settings name, on a client of its own"
          );
        }
        const value = input.value ?? (await ownSecretOf(stores, keyring, connection))?.value;
        if (value === undefined) {
          throw refusal(
            CREDENTIAL_REFUSALS.notConfigured,
            "the Connection holds no client secret of its own to adopt. Enter the secret"
          );
        }
        const server = connectionOAuthServerOf(endpoints);
        const others = await readConnections({ ...deps, stores });
        const current = await stores.connections.getOAuthApp({
          clientInstanceId: deps.clientInstanceId,
          server
        });
        if (current !== undefined && current.clientId !== endpoints.clientId) {
          // A Connection on the app's old client id without a secret of its own signs in with
          // the app: replacing the client id would leave it with none.
          const using: string[] = [];
          for (const other of others) {
            const theirs = oauthAppEndpointsOf(other);
            if (theirs?.clientId !== current.clientId || connectionOAuthServerOf(theirs) !== server)
              continue;
            if (!(await hasOwnSecret(stores, other))) using.push(other.config.name);
          }
          if (using.length > 0) {
            throw refusal(
              CONNECTION_REFUSALS.oauthAppInUse,
              `${using.sort().join(", ")} sign in with the app's client id '${current.clientId}'. Give them the new client id or a secret of their own first`
            );
          }
        }
        const app = await putOAuthApp(
          { clientInstanceId: deps.clientInstanceId, keyring, store: stores.connections },
          {
            endpoints,
            service: connection.config.service,
            value,
            expectedVersion: input.expectedVersion
          }
        );
        // Every own secret that is the app's, byte for byte, is a copy: it goes.
        const expected = Buffer.from(value, "utf8");
        const moved: string[] = [];
        try {
          for (const other of others) {
            if (other.config.origin === "release") continue;
            const theirs = oauthAppEndpointsOf(other);
            if (
              theirs?.clientId !== endpoints.clientId ||
              connectionOAuthServerOf(theirs) !== server
            )
              continue;
            const own = await ownSecretOf(stores, keyring, other);
            if (own === undefined) continue;
            const candidate = Buffer.from(own.value, "utf8");
            try {
              if (!sameSecret(candidate, expected)) continue;
            } finally {
              candidate.fill(0);
            }
            await stores.connections.deleteSecrets({
              clientInstanceId: deps.clientInstanceId,
              connectionAssetId: other.assetId,
              subject: SHARED_CREDENTIAL_SUBJECT,
              source: "runtime",
              // Only the row compared: a value set meanwhile stays.
              nonce: own.nonce
            });
            moved.push(other.config.name);
          }
        } finally {
          expected.fill(0);
        }
        return { ...app, moved: moved.sort() };
      });
    }
  };
}
