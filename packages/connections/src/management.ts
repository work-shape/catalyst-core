import type { Catalogue, CatalogueEntryView } from "./catalogue/catalogue";
import {
  AppError,
  CONNECTION_ASSET_KIND,
  CONNECTION_REFUSALS,
  CREDENTIAL_REFUSALS,
  EGRESS_DENIED,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCallError,
  connectionCallReasonOf,
  connectionOperationName,
  parseConnectionOperationName,
  type AccessResource,
  type JsonObject,
  type AuditActor,
  type ConnectionProviderRevocation,
  type ConnectionBindingState,
  type ConnectionOAuthRegistration,
  type ConnectionCallReason,
  type ConnectionExposure,
  type ConnectionHealth,
  type ConnectionOperationEffect,
  type ConnectionOperationStatus,
  type ConnectorTestStatus,
  type OperationResource,
  type OperationPaging,
  type SecretState
} from "@work-shape/catalyst-core";
import { connectorTypeOffers, type ConnectorTypeOfferView } from "./connector-type-offers";
import {
  createConnectionPersonContextManagement,
  resolveConnectionPersonContext
} from "./person-context";
import type { AuthenticatedIdentity } from "@work-shape/catalyst-core";
import { connectionCallLimits } from "./call";
import { connectionOperationStatus, type ConnectionOperationState } from "./catalog";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import {
  AUTH_SCHEME_NONE,
  NO_CREDENTIALS,
  connectionOriginOf,
  openConnectorContext
} from "./connector-context";
import { registeredClientOf } from "./oauth/client-registration";
import { createSignInEnding } from "./oauth/sign-in-ending";
import {
  createConnectionSignIn,
  signInLandingUrl,
  type ConnectionSignIn,
  type ConnectionSignInDeps
} from "./oauth/sign-in";
import { createSecretStore, type SecretKeyring } from "./secret-store";
import { connectionConsumers, type ConnectionConsumer } from "./used-by";
import { isJsonSchemaWithinBounds } from "./json-schema";

// What the Connection's page and the agent editor read beyond the asset, and the test of a
// Connection. Nothing here answers a secret, a handle of one or data of the outside system.

/** How long a description is at most as these answers carry it. */
export const CONNECTION_DESCRIPTION_MAX_CHARS = 4_000;

export interface ConnectionOperationView {
  paging?: OperationPaging;
  name: string;
  toolName: string;
  effect: ConnectionOperationEffect;
  exposure: ConnectionExposure[];
  enabled: boolean;
  status: ConnectionOperationStatus;
  description?: string;
  inputSchema?: JsonObject;
  discoveredFingerprint?: string;
  /** Only with status `unknown`: the bound the operation's stored schema is over. */
  schemaRefusal?: string;
}

/** A tool the last discovery read that the Connection does not accept. */
export interface ConnectionDiscoveredToolView {
  name: string;
  description?: string;
  proposedEffect: ConnectionOperationEffect;
  fingerprint: string;
}

/** The shared sign-in of a Connection that signs in with OAuth. Never a token. */
export interface ConnectionBindingView {
  state: ConnectionBindingState;
  /** The account as the provider reports it, where it reports one. */
  account?: string;
  scopes: string[];
  connectedAt: string;
  /** The person who signed in. */
  connectedBy?: string;
  lastUsedOn?: string;
  accessExpiresAt?: string;
  /** Why the binding left `connected`, as a reason code. */
  reason?: string;
}

/** How a Connection that signs in with OAuth is registered at its provider. */
export interface ConnectionOAuthView {
  /** `preregistered` where the settings name the client id the provider issued. */
  registration: ConnectionOAuthRegistration;
  /** The address the provider sends the browser back to. Missing without `instance.publicUrl`. */
  redirectUri?: string;
  /** The host of the authorization server a registration was made at. */
  providerHost?: string;
}

export interface ConnectionView {
  name: string;
  health: ConnectionHealth;
  lastTestedAt?: string;
  lastErrorCode?: string;
  secret: { state: SecretState; version?: number };
  sharedCredential: boolean;
  operations: ConnectionOperationView[];
  discovered: ConnectionDiscoveredToolView[];
  usedBy: { agentName: string; title: string; toolNames: string[] }[];
  usedByAssets?: ConnectionConsumer[];
  usedByAssetsTruncated?: boolean;
  discoveredAt?: string;
  /** The shared sign-in, where one was made for the Connection's address. */
  binding?: ConnectionBindingView;
  /** Only for a Connection whose auth scheme is `oauth`. */
  oauth?: ConnectionOAuthView;
}

export interface ConnectionTestView {
  status: ConnectorTestStatus;
  testedAt: string;
}

export interface ConnectionToolsView {
  connections: {
    name: string;
    title: string;
    /** The system behind the Connection, as it names it for its icon. */
    service?: string;
    connectorType: string;
    tools: {
      toolName: string;
      operation: string;
      description?: string;
      effect: ConnectionOperationEffect;
    }[];
  }[];
}

/** An agent that lists tools, as the reader of a Connection's page may or may not see it. */
export interface AgentToolListing {
  name: string;
  title: string;
  toolNames: readonly string[];
}

export interface ConnectionManagement extends ReturnType<
  typeof createConnectionPersonContextManagement
> {
  /** What a right on the Connection is decided on. Nothing where no such Connection exists. */
  resource(name: string): Promise<OperationResource | undefined>;
  /** `agents` are the agents the caller may read: `usedBy` names no other. */
  get(
    name: string,
    agents: readonly AgentToolListing[],
    readable?: (resource: AccessResource) => boolean
  ): Promise<ConnectionView>;
  /** The type's bounded test. Writes the health and answers no data of the outside system. */
  test(
    name: string,
    signal?: AbortSignal,
    actor?: AuthenticatedIdentity
  ): Promise<ConnectionTestView>;
  /** The tools an agent can carry, of the Connections `readable` admits. */
  listTools(readable: (resource: AccessResource) => boolean): Promise<ConnectionToolsView>;
  /**
   * The Connector types of the build that the New connection dialog offers with a form, and
   * the catalogue's entries.
   */
  connectorTypes(): { types: ConnectorTypeOfferView[]; entries: CatalogueEntryView[] };
  /**
   * Stores the shared secret of a Connection made on the instance, as the next version. The
   * value is written once and never read back. `expectedVersion` is the version the writer
   * saw, `null` for none: another writer's version in between refuses the write.
   * `expectedRevision` is the revision of the Connection the writer read: the secret is for
   * the addresses that revision names, and a Connection changed since refuses the write with
   * `connection_changed`.
   */
  setSecret(
    name: string,
    input: { value: string; expectedVersion: number | null; expectedRevision: number }
  ): Promise<{ state: "set"; version: number }>;
  /** Starts the shared OAuth sign-in of a Connection. See `ConnectionSignIn`. */
  oauthStart: ConnectionSignIn["start"];
  /** Completes a sign-in at its callback. See `ConnectionSignIn`. */
  oauthComplete: ConnectionSignIn["complete"];
  /** Whether a person's sign-in still waits for its callback. See `ConnectionSignIn`. */
  oauthWaiting: ConnectionSignIn["waiting"];
  /** The in-app address a callback sends the browser to, or nothing without a public URL. */
  oauthLandingUrl(outcome: string, connectionName?: string): string | undefined;
  /**
   * Disconnect: ends the shared sign-in of a Connection. The binding becomes `revoked` and its
   * token set is deleted, and only once that committed is the provider asked to revoke the
   * grant (RFC 7009), best effort. Answers what the provider said. A Connection without a
   * sign-in to end answers CONFLICT `connection_not_connected`.
   */
  disconnect(
    name: string,
    audit: { actor: AuditActor; correlationId: string }
  ): Promise<ConnectionDisconnected>;
}

/** What Disconnect answers. */
export interface ConnectionDisconnected {
  state: "revoked";
  providerRevocation: ConnectionProviderRevocation;
}

function resourceOf(connection: StoredConnection): OperationResource {
  return {
    kind: CONNECTION_ASSET_KIND,
    id: connection.assetId,
    assetId: connection.assetId,
    name: connection.config.name
  };
}

function notFound(name: string): AppError {
  return new AppError("NOT_FOUND", `Connection '${name}' does not exist`);
}

/** What the last discovery read that the accepted list does not name. */
function discoveredOf(connection: StoredConnection): ConnectionDiscoveredToolView[] {
  const accepted = new Set(connection.config.operations.map((operation) => operation.name));
  return (connection.catalog?.entries ?? [])
    .filter((entry) => !accepted.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      ...(entry.description === ""
        ? {}
        : { description: entry.description.slice(0, CONNECTION_DESCRIPTION_MAX_CHARS) }),
      proposedEffect: entry.proposedEffect,
      fingerprint: entry.fingerprint
    }));
}

function secretWriteRefusal(reason: string, sentence: string): AppError {
  return new AppError("CONFLICT", `${reason}: ${sentence}`, { reason });
}

function operationsOf(connection: StoredConnection): ConnectionOperationView[] {
  return connection.config.operations.map((operation) => {
    const state: ConnectionOperationState = connection.type
      ? connectionOperationStatus({ type: connection.type, operation, catalog: connection.catalog })
      : { status: "unknown" };
    const description = state.descriptor?.description;
    const fingerprint = state.status === "needs_review" ? state.discoveredFingerprint : undefined;
    return {
      name: operation.name,
      toolName: connectionOperationName(connection.config.name, operation.name),
      effect: operation.effect,
      exposure: [...operation.exposure],
      ...(operation.paging ? { paging: operation.paging } : {}),
      enabled: operation.enabled,
      status: state.status,
      ...(description === undefined
        ? {}
        : { description: description.slice(0, CONNECTION_DESCRIPTION_MAX_CHARS) }),
      ...(state.descriptor && isJsonSchemaWithinBounds(state.descriptor.inputSchema)
        ? { inputSchema: state.descriptor.inputSchema }
        : {}),
      ...(fingerprint === undefined ? {} : { discoveredFingerprint: fingerprint }),
      ...(state.schemaRefusal === undefined ? {} : { schemaRefusal: state.schemaRefusal })
    };
  });
}

/** What a reason of the context or of the type comes to as the answer of a test. */
function testStatusOf(reason: ConnectionCallReason | undefined): ConnectorTestStatus {
  switch (reason) {
    case EGRESS_DENIED:
      return "network_denied";
    case "upstream_unauthorized":
    case "connection_not_configured":
    case "secret_unreadable":
      return "unauthorized";
    // A Connection that signs in and has no live sign-in asks for one.
    case "connection_not_connected":
    case "connection_needs_reconnect":
      return "oauth_required";
    default:
      return "unavailable";
  }
}

function healthOfTest(
  status: ConnectorTestStatus,
  reason: ConnectionCallReason | undefined
): ConnectionHealth {
  if (status === "ready") return "ok";
  if (reason === CREDENTIAL_REFUSALS.unreadable) return "secret_unreadable";
  if (reason === CREDENTIAL_REFUSALS.notConfigured) return "needs_configuration";
  if (reason === CREDENTIAL_REFUSALS.notConnected) return "needs_configuration";
  return "failed";
}

export function createConnectionManagement(
  deps: ConnectionOperationSourceDeps &
    Pick<ConnectionSignInDeps, "publicUrl" | "oauth"> & {
      /** The keys of the Secret Store. Without them no secret is stored. */
      keyring?: SecretKeyring;
      /** The catalogue's entries, which New connection shows in "Dienste". */
      catalogue?: Pick<Catalogue, "entries">;
      now?: () => Date;
    }
): ConnectionManagement {
  const now = deps.now ?? (() => new Date());
  const signIn = createConnectionSignIn(deps);
  // Without a key of the Secret Store there is no token set, and so no sign-in to end.
  const ending =
    deps.keyring === undefined
      ? undefined
      : createSignInEnding({
          clientInstanceId: deps.clientInstanceId,
          connectorTypes: deps.connectorTypes,
          egress: deps.egress,
          keyring: deps.keyring,
          audit: deps.stores.audit,
          logger: deps.logger,
          ...(deps.oauth === undefined ? {} : { oauth: deps.oauth })
        });

  /** The binding of the Connection's address, as its page shows it. */
  async function bindingOf(
    connection: StoredConnection,
    origin: string | undefined
  ): Promise<ConnectionBindingView | undefined> {
    const binding = await deps.stores.connections.getConnectionBinding({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: connection.assetId,
      subject: SHARED_CREDENTIAL_SUBJECT
    });
    // A sign-in made for another address is none for this one.
    if (!binding || origin === undefined || binding.origin !== origin) return undefined;
    return {
      state: binding.state,
      ...(binding.accountLabel === undefined ? {} : { account: binding.accountLabel }),
      scopes: binding.grantedScopes,
      connectedAt: binding.connectedAt,
      ...(binding.connectedBy === undefined ? {} : { connectedBy: binding.connectedBy }),
      ...(binding.lastUsedOn === undefined ? {} : { lastUsedOn: binding.lastUsedOn }),
      ...(binding.accessExpiresAt === undefined
        ? {}
        : { accessExpiresAt: binding.accessExpiresAt }),
      ...(binding.stateReason === undefined ? {} : { reason: binding.stateReason })
    };
  }

  function oauthOf(connection: StoredConnection): ConnectionOAuthView | undefined {
    const { type, config } = connection;
    if (config.authScheme !== "oauth" || !type?.signIn) return undefined;
    const settings = type.settingsSchema.safeParse(config.settings);
    const chosen = settings.success ? type.signIn.oauthSettings(settings.data) : {};
    const registered = registeredClientOf(connection.state?.oauthClient);
    const redirectUri = signIn.redirectUri(config.name);
    // A server the settings name shows the host of its authorization address; a registration
    // made by DCR the host of the server it was made at.
    const named = settings.success ? type.oauthEndpoints?.(settings.data) : undefined;
    let providerHost: string | undefined;
    try {
      providerHost =
        named?.authorizationUrl !== undefined
          ? new URL(named.authorizationUrl).host
          : registered === undefined || chosen.clientId !== undefined
            ? undefined
            : new URL(registered.issuer).host;
    } catch {
      providerHost = undefined;
    }
    return {
      registration: chosen.clientId === undefined ? "dcr" : "preregistered",
      ...(redirectUri === undefined ? {} : { redirectUri }),
      ...(providerHost === undefined ? {} : { providerHost })
    };
  }

  async function secretOf(connection: StoredConnection): Promise<ConnectionView["secret"]> {
    const record = await deps.stores.connections.findSecret({
      clientInstanceId: deps.clientInstanceId,
      binding: { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT }
    });
    // A secret set for another address than the Connection's is never sent, and so none.
    const origin = connection.type
      ? connectionOriginOf(connection.type, connection.config)
      : undefined;
    if (!record || origin === undefined || record.origin !== origin) return { state: "not_set" };
    // Whether the keys open it is what the seed, a test and a call found out and wrote down.
    const unreadable = connection.state?.health === "secret_unreadable";
    return { state: unreadable ? "unreadable" : "set", version: record.version };
  }

  return {
    ...createConnectionPersonContextManagement(deps),
    async resource(name) {
      const connection = await readConnection(deps, name);
      return connection ? resourceOf(connection) : undefined;
    },

    async get(name, agents, readable) {
      const connection = await readConnection(deps, name);
      if (!connection) throw notFound(name);
      const usedBy = agents.flatMap((agent) => {
        const toolNames = agent.toolNames.filter(
          (toolName) => parseConnectionOperationName(toolName)?.connection === name
        );
        return toolNames.length > 0
          ? [{ agentName: agent.name, title: agent.title, toolNames }]
          : [];
      });
      const consumers = readable ? await connectionConsumers(deps, name, readable) : undefined;
      const { state, catalog } = connection;
      const origin = connection.type
        ? connectionOriginOf(connection.type, connection.config)
        : undefined;
      const binding = await bindingOf(connection, origin);
      const oauth = oauthOf(connection);
      return {
        name: connection.config.name,
        health: state?.health ?? "unknown",
        ...(state?.lastTestedAt === undefined ||
        state.health === "unknown" ||
        (state.health === "needs_configuration" && !state.lastErrorCode)
          ? {}
          : { lastTestedAt: state.lastTestedAt }),
        ...(state?.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
        secret: await secretOf(connection),
        sharedCredential: connection.config.credentialMode === "shared",
        operations: operationsOf(connection),
        discovered: discoveredOf(connection),
        usedBy,
        ...(consumers === undefined
          ? {}
          : {
              usedByAssets: consumers.assets,
              usedByAssetsTruncated: consumers.truncated
            }),
        ...(catalog ? { discoveredAt: catalog.discoveredAt } : {}),
        ...(binding === undefined ? {} : { binding }),
        ...(oauth === undefined ? {} : { oauth })
      };
    },

    async test(name, outer, actor) {
      const connection = await readConnection(deps, name);
      if (!connection) throw notFound(name);
      const { type } = connection;
      if (!type) throw connectionCallError("connection_unavailable");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), connectionCallLimits(type).callTimeoutMs);
      const onOuterAbort = () => controller.abort();
      outer?.addEventListener("abort", onOuterAbort, { once: true });
      let status: ConnectorTestStatus;
      let reason: ConnectionCallReason | undefined;
      try {
        // The one way to a context: settings, then egress, then the credential.
        const context = await openConnectorContext({
          type,
          connection: {
            id: connection.assetId,
            revision: connection.revision,
            config: connection.config
          },
          egress: deps.egress,
          credentials: deps.credentials ?? NO_CREDENTIALS,
          resolvePersonContext: (header, origin) =>
            resolveConnectionPersonContext(deps, connection.assetId, header, origin, actor),
          signal: controller.signal
        });
        const testing = type.test(context);
        testing.catch(() => undefined);
        // A type that ignores the signal does not hold the test open past its deadline.
        status = (
          await Promise.race([
            testing,
            new Promise<never>((_resolve, reject) => {
              const stop = () => reject(connectionCallError("upstream_timeout"));
              if (controller.signal.aborted) stop();
              else controller.signal.addEventListener("abort", stop, { once: true });
            })
          ])
        ).status;
      } catch (error) {
        // Only the reason is read. The text of the error is the type's or the outside system's.
        reason = connectionCallReasonOf(error);
        // A missing actor mapping says nothing about the shared Connection's health.
        if (reason === "person_context_unmapped") throw connectionCallError(reason);
        status = testStatusOf(reason);
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onOuterAbort);
      }
      const testedAt = now().toISOString();
      await deps.stores.connections.putConnectionState({
        clientInstanceId: deps.clientInstanceId,
        connectionAssetId: connection.assetId,
        health: healthOfTest(status, reason),
        lastTestedAt: testedAt,
        lastErrorCode: status === "ready" ? null : (reason ?? status)
      });
      return { status, testedAt };
    },

    async setSecret(name, { value, expectedVersion, expectedRevision }) {
      return deps.stores.transaction(async (stores) => {
        // Held until the end: a write of the Connection waits, so the addresses the revision
        // below names are the ones the secret is stored for.
        const connection = await readConnection({ ...deps, stores }, name, { held: true });
        if (!connection) throw notFound(name);
        const { config } = connection;
        if (config.origin === "release") {
          throw new AppError(
            "FORBIDDEN",
            `${CONNECTION_REFUSALS.readOnlyOrigin}: this Connection is defined in release config, and its secret comes from the environment`,
            { reason: CONNECTION_REFUSALS.readOnlyOrigin }
          );
        }
        // The secret was typed for the Connection as the writer read it. Another writer may
        // have moved its token address, issuer or client since: the secret is not sent there.
        if (connection.revision !== expectedRevision) {
          throw new AppError(
            "CONFLICT",
            `${CONNECTION_REFUSALS.changedSinceRead}: the Connection was changed by somebody else since it was read. Nothing was stored; read the Connection again`,
            { reason: CONNECTION_REFUSALS.changedSinceRead }
          );
        }
        if (config.authScheme === AUTH_SCHEME_NONE || config.secretHandle === undefined) {
          throw secretWriteRefusal(
            CONNECTION_REFUSALS.takesNoSecret,
            "the Connection sends no credential. Choose an auth scheme that does first"
          );
        }
        if (!deps.keyring) {
          throw secretWriteRefusal(
            CONNECTION_REFUSALS.secretStoreUnavailable,
            "this instance names no key of the Secret Store. An operator names one under 'secretStore.keys'"
          );
        }
        const binding = {
          connectionAssetId: connection.assetId,
          subject: SHARED_CREDENTIAL_SUBJECT
        };
        // The secret is for the address the Connection has on this read, and is sent nowhere
        // else.
        const origin = connection.type
          ? connectionOriginOf(connection.type, connection.config)
          : undefined;
        if (origin === undefined) {
          throw secretWriteRefusal(
            CREDENTIAL_REFUSALS.notConfigured,
            "the Connection's settings name no address its connector type reads. Fix the settings first"
          );
        }
        // The version is compared on the read the write follows: a check before it here would
        // let a write that lands in between be replaced unseen.
        const written = await createSecretStore({
          clientInstanceId: deps.clientInstanceId,
          keyring: deps.keyring,
          store: stores.connections
        }).put({
          binding,
          value,
          source: "runtime",
          handle: config.secretHandle,
          expectedVersion,
          origin
        });
        if (written.changed) {
          // What a test found was found with the secret before.
          await stores.connections.putConnectionState({
            clientInstanceId: deps.clientInstanceId,
            connectionAssetId: connection.assetId,
            health: "unknown",
            lastErrorCode: null
          });
        }
        return { state: "set" as const, version: written.version };
      });
    },

    async disconnect(name, audit) {
      const ended = await deps.stores.transaction(async (stores) => {
        // Held until the end: a write of the Connection waits, and ends nothing twice.
        const connection = await readConnection({ ...deps, stores }, name, { held: true });
        if (!connection) throw notFound(name);
        if (ending === undefined) return undefined;
        return ending.end(stores, {
          connectionAssetId: connection.assetId,
          connectionName: connection.config.name,
          connectionRevision: connection.revision,
          config: connection.config,
          reason: "disconnect",
          actor: audit.actor,
          correlationId: audit.correlationId
        });
      });
      if (ended === undefined) {
        throw new AppError(
          "CONFLICT",
          `${CREDENTIAL_REFUSALS.notConnected}: the Connection has no sign-in to end`,
          { reason: CREDENTIAL_REFUSALS.notConnected }
        );
      }
      return { state: "revoked", providerRevocation: await ended.revokeAtProvider() };
    },

    oauthStart: (name, input) => signIn.start(name, input),
    oauthComplete: (input) => signIn.complete(input),
    oauthWaiting: (name, input) => signIn.waiting(name, input),
    oauthLandingUrl: (outcome, connectionName) =>
      deps.publicUrl === undefined
        ? undefined
        : signInLandingUrl(deps.publicUrl, outcome, connectionName),

    connectorTypes: () => connectorTypeOffers(deps.connectorTypes, deps.catalogue),

    async listTools(readable) {
      const connections = (await readConnections(deps))
        .filter((connection) => readable(resourceOf(connection)))
        .sort((left, right) => (left.config.name < right.config.name ? -1 : 1));
      return {
        connections: connections.flatMap((connection) => {
          if (!connection.config.enabled || connection.state?.health === "secret_unreadable") {
            return [];
          }
          const tools = operationsOf(connection)
            .filter(
              (operation) =>
                operation.enabled &&
                operation.status === "ready" &&
                operation.exposure.includes("agent")
            )
            .map((operation) => ({
              toolName: operation.toolName,
              operation: operation.name,
              ...(operation.description === undefined
                ? {}
                : { description: operation.description }),
              effect: operation.effect
            }));
          const { name, displayName, service, connectorType } = connection.config;
          return tools.length > 0
            ? [
                {
                  name,
                  title: displayName,
                  ...(service === undefined ? {} : { service }),
                  connectorType,
                  tools
                }
              ]
            : [];
        })
      };
    }
  };
}
