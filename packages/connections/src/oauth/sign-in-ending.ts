import { randomUUID } from "node:crypto";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  SHARED_CREDENTIAL_SUBJECT,
  StoreBackedAuditRecorder,
  endConnectionSignIn,
  type AuditActor,
  type AuditEventStore,
  type ClientInstanceId,
  type ConnectionBindingRecord,
  type ConnectionProviderRevocation,
  type ConnectionSignInEnded,
  type ConnectionSignInEnding,
  type ConnectorTypeDefinition,
  type ConnectorTypeRegistry,
  type JsonObject,
  type EgressChecker,
  type Logger
} from "@work-shape/catalyst-core";
import type { StoredConnection } from "../connection-reads";
import { connectionOriginOf } from "../connector-context";
import {
  createConnectionCredentialResolver,
  openSignInTokenSet,
  type SecretKeyring
} from "../secret-store";
import { clientOfSession } from "./client-registration";
import { createOAuthFetch } from "./fetch";
import type { OAuthClient, OAuthPort, OAuthTokenTypeHint } from "./port";
import { createSdkOAuthPort } from "./sdk-adapter";
import { signInServerOf } from "./static-server";
import type { StoredTokenSet } from "./token-set";

// The end of a Connection's sign-in with the provider told (RFC 7009). Inside the transaction
// that ends the sign-in, the token set and the client it was obtained by are read into memory,
// the binding is revoked and the token set deleted. Only once that committed is the provider
// asked to revoke the grant: a revocation that fails or never happens leaves no token on the
// instance, and a transaction that rolls back has asked nobody. Nothing here logs or answers a
// token.

/** How long one revocation may take, from the metadata read to the provider's answer. */
const REVOCATION_TIMEOUT_MS = 15_000;

const SYSTEM_ACTOR: AuditActor = { displayLabel: "System", roles: [] };

export interface SignInEndingDeps {
  clientInstanceId: ClientInstanceId;
  connectorTypes: ConnectorTypeRegistry;
  egress: EgressChecker;
  keyring: SecretKeyring;
  audit: AuditEventStore;
  logger: Logger;
  /** The OAuth port. Left out, the adapter over the MCP SDK. */
  oauth?: OAuthPort;
}

/** What the provider is told with: read before the token set was deleted. */
interface Revocable {
  tokenSet: StoredTokenSet;
  issuer: string;
  client: OAuthClient;
  connectionOrigin: string;
  /** The type and settings the sign-in was made under, whose server may be named in them. */
  type: ConnectorTypeDefinition;
  settings: JsonObject;
}

export function createSignInEnding(deps: SignInEndingDeps): ConnectionSignInEnding {
  const { clientInstanceId, keyring } = deps;
  const port = deps.oauth ?? createSdkOAuthPort();
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: deps.audit });

  return {
    async end(stores, input) {
      const key = { clientInstanceId, connectionAssetId: input.connectionAssetId };
      const store = stores.connections;
      const binding = await store.getConnectionBinding({
        ...key,
        subject: SHARED_CREDENTIAL_SUBJECT
      });
      let revocable: Revocable | undefined;
      if (binding !== undefined && binding.state !== "revoked") {
        // Best effort: what cannot be read is not revoked at the provider, and the sign-in
        // ends on the instance all the same.
        revocable = await readRevocable(input, binding, store).catch(() => undefined);
      }
      const ended = await endConnectionSignIn(store, key, {
        reason: input.reason,
        ...(input.actor?.userId === undefined ? {} : { changedBy: input.actor.userId })
      });
      if (ended === undefined) return undefined;
      return endedSignIn(input, revocable);
    }
  };

  async function readRevocable(
    input: Parameters<ConnectionSignInEnding["end"]>[1],
    binding: ConnectionBindingRecord,
    store: Parameters<ConnectionSignInEnding["end"]>[0]["connections"]
  ): Promise<Revocable | undefined> {
    const { origin } = binding;
    const parsed = connectionConfigSchema.safeParse(input.config);
    if (!parsed.success) return undefined;
    const type = deps.connectorTypes.get(parsed.data.connectorType);
    if (!type?.signIn) return undefined;
    const settings = type.settingsSchema.safeParse(parsed.data.settings);
    if (!settings.success) return undefined;
    // The provider is told only at the server the sign-in was made for: a config bound to
    // another origin is not that server, and is sent neither the token nor the client secret.
    if (connectionOriginOf(type, parsed.data) !== origin) return undefined;
    const tokenSet = await openSignInTokenSet(
      { clientInstanceId, keyring, store },
      { ...binding, origin }
    );
    if (tokenSet.issuer === undefined || tokenSet.clientId === undefined) return undefined;
    const connection: StoredConnection = {
      assetId: input.connectionAssetId,
      revision: input.connectionRevision,
      config: parsed.data,
      type,
      state: await store.getConnectionState({
        clientInstanceId,
        connectionAssetId: input.connectionAssetId
      }),
      catalog: undefined
    };
    const client = await clientOfSession(
      {
        clientInstanceId,
        store,
        credentials: createConnectionCredentialResolver({ clientInstanceId, keyring, store }),
        keyring,
        port
      },
      {
        connection,
        origin,
        clientId: tokenSet.clientId,
        preregisteredId: type.signIn.oauthSettings(settings.data).clientId
      }
    );
    return {
      tokenSet,
      issuer: tokenSet.issuer,
      client,
      connectionOrigin: new URL(type.signIn.resourceUrl(settings.data)).origin,
      type,
      settings: settings.data
    };
  }

  function endedSignIn(
    input: Parameters<ConnectionSignInEnding["end"]>[1],
    read: Revocable | undefined
  ): ConnectionSignInEnded {
    let revocable = read;
    let answered: Promise<ConnectionProviderRevocation> | undefined;

    async function ask(): Promise<ConnectionProviderRevocation> {
      const held = revocable;
      revocable = undefined;
      if (held === undefined) return "failed";
      const signal = AbortSignal.timeout(REVOCATION_TIMEOUT_MS);
      const fetch = createOAuthFetch({ egress: deps.egress, signal });
      try {
        const { server } = await signInServerOf({
          port,
          type: held.type,
          settings: held.settings,
          issuer: held.issuer,
          connectionOrigin: held.connectionOrigin,
          fetch
        });
        // The refresh token, where there is one: revoking it ends the grant (RFC 7009 2.1).
        const { refreshToken, accessToken } = held.tokenSet;
        const tokenTypeHint: OAuthTokenTypeHint =
          refreshToken === undefined ? "access_token" : "refresh_token";
        return await port.revoke({
          server,
          client: held.client,
          token: refreshToken ?? accessToken,
          tokenTypeHint,
          fetch
        });
      } catch {
        return "failed";
      }
    }

    async function revokeAtProvider(): Promise<ConnectionProviderRevocation> {
      const providerRevocation = await ask();
      try {
        await auditRecorder.record({
          type: "connection.binding_revoked",
          status: "success",
          actor: input.actor ?? SYSTEM_ACTOR,
          subject: input.connectionName,
          reason: input.reason,
          correlationId: input.correlationId ?? `sign_in_${randomUUID()}`,
          metadata: {
            connectionName: input.connectionName,
            connectionRevision: input.connectionRevision,
            subjectKind: SHARED_CREDENTIAL_SUBJECT,
            providerRevocation
          }
        });
      } catch {
        deps.logger.warn(
          { module: "connections", connection: input.connectionName },
          "The end of a Connection's sign-in was not recorded"
        );
      }
      return providerRevocation;
    }

    return {
      revokeAtProvider() {
        answered ??= revokeAtProvider();
        return answered;
      },
      discard() {
        revocable = undefined;
      }
    };
  }
}
