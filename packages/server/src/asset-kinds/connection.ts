import { connectionConfigSchema, connectionNameSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_NAME_RULE,
  CONNECTION_REFUSALS,
  EGRESS_DENIED,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCredentialOrigin,
  connectionOAuthTargets,
  createConnectionSecretHandle,
  defineAssetKind,
  egressOriginOf,
  egressSettingFor,
  findConnectorTypeIssues,
  findPersonContextAppIssue,
  parseConnectionOperationName,
  endConnectionSignIn,
  type AssetValidationIssue,
  type ConnectionBindingEndReason,
  type ConnectionConfig,
  type ConnectionSignInEnding,
  type ConnectorOAuthEndpoints,
  type JsonObject,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type EgressTarget
} from "@work-shape/catalyst-core";
import { requestConnectionDiscovery } from "../connections/connection-jobs";
import {
  configValuesEqual,
  readDefinitionField,
  type AssetWriteFollowUp,
  type AssetWriteSurface,
  type WorkflowAssetKind
} from "./shared";

export interface ConnectionAssetKindOptions {
  /** The Connector types of this build. A Connection of another type is refused. */
  connectorTypes: ConnectorTypeRegistry;
  /** Asked on a save whether the operator's egress list names the Connection's target. */
  egress: Pick<EgressChecker, "admits">;
  /**
   * Ends a sign-in a write makes useless and tells the provider once the write committed.
   * Left out, where the instance has no Secret Store, the sign-in ends on the instance only.
   */
  signInEnding?: ConnectionSignInEnding;
}

/** Why a write ends the Connection's sign-in, or nothing where the sign-in stays. */
function signInEndOf(
  options: ConnectionAssetKindOptions,
  previous: unknown,
  config: JsonObject | undefined
): ConnectionBindingEndReason | undefined {
  if (config === undefined) return "deleted";
  const parsed = connectionConfigSchema.safeParse(config);
  if (!parsed.success) return undefined;
  if (parsed.data.authScheme !== AUTH_SCHEME_OAUTH) return "scheme_changed";
  return originMoved(options, previous, parsed.data) ? "origin_changed" : undefined;
}

/** The auth scheme that sends no credential, so the Connection holds no secret. */
const AUTH_SCHEME_NONE = "none";
/** The auth scheme of a Connection that signs in with OAuth (CS-4b). */
const AUTH_SCHEME_OAUTH = "oauth";
/** The kind of the assets that carry a Connection's tools. */
const AGENT_ASSET_KIND = "agent";
/** The kind of the assets whose manifest names Connections. */
const APP_ASSET_KIND = "app";

/**
 * The refusal of a write to a Connection that release config defines. It is changed in
 * release config and by a restart, and nowhere in the product.
 */
function readOnlyOrigin(): AppError {
  return new AppError(
    "FORBIDDEN",
    `${CONNECTION_REFUSALS.readOnlyOrigin}: this Connection is defined in release config and is read-only here. Change it in release config`,
    { reason: CONNECTION_REFUSALS.readOnlyOrigin }
  );
}

/**
 * A batch carries no Connection yet: a write of one makes its secret handle and asks for its
 * discovery, which `assets.put` does and a batch does not.
 */
function refuseBatch(surface: AssetWriteSurface): void {
  if (surface !== "sync") return;
  throw new AppError(
    "VALIDATION_FAILED",
    `${CONNECTION_REFUSALS.batchUnavailable}: a Connection is written one at a time, with assets.put. A batch cannot hold one yet`,
    { reason: CONNECTION_REFUSALS.batchUnavailable }
  );
}

/** The Connections the manifest of an App's config names, or none. */
function manifestConnectionsOf(config: unknown): string[] {
  const connections = readDefinitionField(readDefinitionField(config, "manifest"), "connections");
  return Array.isArray(connections)
    ? connections.filter((name): name is string => typeof name === "string")
    : [];
}

/** The tool names of an agent definition, or none. */
function toolNamesOf(agent: unknown): string[] {
  const names = readDefinitionField(agent, "toolNames");
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Where a Connection's type sends its calls, read from the settings as a call reads them, or
 * nothing where that cannot be read.
 */
function targetOf(
  options: ConnectionAssetKindOptions,
  connection: ConnectionConfig
): EgressTarget | undefined {
  const type = options.connectorTypes.get(connection.connectorType);
  const settings = type?.settingsSchema.safeParse(connection.settings);
  if (!type || !settings?.success) return undefined;
  try {
    return type.target(settings.data);
  } catch {
    return undefined;
  }
}

/**
 * The authorization server a Connection names in its settings (CONN-OAUTH-1), or nothing
 * where it names none or its settings cannot be read.
 */
function oauthEndpointsOf(
  options: ConnectionAssetKindOptions,
  connection: ConnectionConfig
): ConnectorOAuthEndpoints | undefined {
  const type = options.connectorTypes.get(connection.connectorType);
  const settings = type?.settingsSchema.safeParse(connection.settings);
  if (!type?.oauthEndpoints || !settings?.success) return undefined;
  try {
    return type.oauthEndpoints(settings.data);
  } catch {
    return undefined;
  }
}

/**
 * What the Connection's own secret and its sign-in are bound to: its target's origin and, where
 * it names its authorization server, that server's full addresses, its issuer and the client id.
 */
function credentialOriginOf(
  options: ConnectionAssetKindOptions,
  connection: ConnectionConfig
): string | undefined {
  const target = targetOf(options, connection);
  if (target === undefined) return undefined;
  return connectionCredentialOrigin(target, oauthEndpointsOf(options, connection));
}

/**
 * Why a Connection's target, or an address of the authorization server it names, is refused
 * on a save, or nothing. Only the operator's list is asked, never DNS: the address is judged
 * again by every test, discovery, sign-in and call.
 */
function egressIssue(
  options: ConnectionAssetKindOptions,
  connection: ConnectionConfig
): AssetValidationIssue | undefined {
  if (!options.connectorTypes.get(connection.connectorType)) return undefined;
  const target = targetOf(options, connection);
  const endpoints = oauthEndpointsOf(options, connection);
  const refused = target
    ? [target, ...(endpoints ? connectionOAuthTargets(endpoints) : [])].find(
        (candidate) => !options.egress.admits(candidate)
      )
    : undefined;
  if (target && refused === undefined) return undefined;
  const place = refused ? ` ${refused.host}:${refused.port}` : "";
  const setting = refused
    ? egressSettingFor(refused)
    : "An operator adds it under 'egress.allow' in release config";
  return {
    message: `${EGRESS_DENIED}: the address${place} is not on this instance's egress list. ${setting}`,
    path: refused && refused !== target ? ["settings", "oauth"] : ["settings"],
    code: EGRESS_DENIED
  };
}

/**
 * Whether a write sends the Connection to another origin than the one its secret was entered
 * for. A secret is for the origin it was entered for: a writer, who never reads it, could
 * otherwise have it sent to a system of their choosing on the egress list.
 */
function originMoved(
  options: ConnectionAssetKindOptions,
  previous: unknown,
  next: ConnectionConfig
): boolean {
  if (previous === undefined) return false;
  const stored = connectionConfigSchema.safeParse(previous);
  const before = stored.success ? targetOf(options, stored.data) : undefined;
  const after = targetOf(options, next);
  return (
    before === undefined ||
    after === undefined ||
    before.protocol !== after.protocol ||
    before.host !== after.host ||
    before.port !== after.port ||
    // A client secret and a sign-in are also bound to the authorization server and the client
    // the Connection names: a writer cannot have them sent to another token address.
    (stored.success ? credentialOriginOf(options, stored.data) : undefined) !==
      credentialOriginOf(options, next)
  );
}

/** The settings and the auth scheme: what decides which system the Connection reaches and how. */
function reachChanged(previous: unknown, next: ConnectionConfig): boolean {
  return (
    !configValuesEqual(readDefinitionField(previous, "settings"), next.settings) ||
    readDefinitionField(previous, "authScheme") !== next.authScheme
  );
}

/**
 * What the server decides of a Connection made here. The owner is who created it and stays
 * so; the handle names the place of its secret and stays with it while it holds one.
 */
function withServerFields(
  current: unknown,
  next: Record<string, unknown>,
  principalId: string | undefined
): Record<string, unknown> {
  // A handle the caller sent names nothing of this Connection's.
  const rest = Object.fromEntries(Object.entries(next).filter(([key]) => key !== "secretHandle"));
  const storedOwner = readDefinitionField(current, "ownerPrincipalId");
  const storedHandle = readDefinitionField(current, "secretHandle");
  const owner = typeof storedOwner === "string" ? storedOwner : principalId;
  const authenticates = typeof next.authScheme === "string" && next.authScheme !== AUTH_SCHEME_NONE;
  return {
    ...rest,
    ...(owner === undefined ? {} : { ownerPrincipalId: owner }),
    credentialMode: "shared",
    origin: "runtime",
    ...(authenticates
      ? {
          secretHandle:
            typeof storedHandle === "string" ? storedHandle : createConnectionSecretHandle()
        }
      : {})
  };
}

/**
 * The Connection kind: the access to one outside system. Its revision holds settings, accepted
 * operations and a handle of the Secret Store, never a secret. A validated write is live: the
 * kind has no draft. It is no part of the release bundle and offered in no workspace list.
 *
 * A Connection that release config defines is read-only. One made on the instance (`origin:
 * runtime`) is created, changed and deleted through the asset operations: the server writes
 * its origin, its owner and its secret handle, whatever the caller sent.
 */
export function createConnectionAssetKind(options: ConnectionAssetKindOptions): WorkflowAssetKind {
  return {
    ...defineAssetKind({
      kind: CONNECTION_ASSET_KIND,
      plural: "connections",
      schema: connectionConfigSchema,
      nameRule: {
        pattern: CONNECTION_NAME_PATTERN,
        maxLength: CONNECTION_NAME_MAX_LENGTH,
        description: CONNECTION_NAME_RULE,
        schema: connectionNameSchema
      },
      actions: {
        read: CONNECTION_ACTIONS.read,
        use: CONNECTION_ACTIONS.use,
        write: CONNECTION_ACTIONS.write,
        delete: CONNECTION_ACTIONS.delete
      },
      // A Connection refers to no other asset.
      validate: () => [],
      // Asked for the Connections a write adds or changes only: a stored Connection of a type
      // a later release no longer ships never stands in the way of a write to another asset.
      validateWrite(context, connections) {
        return connections
          .filter((connection) => context.changes(CONNECTION_ASSET_KIND, connection.name))
          .flatMap((connection): AssetValidationIssue[] => {
            if (connection.origin !== "runtime") {
              // The release seed writes through the store and never through a validation.
              return [
                {
                  message: `${CONNECTION_REFUSALS.readOnlyOrigin}: only release config defines a Connection of origin 'release'`,
                  path: ["origin"],
                  code: CONNECTION_REFUSALS.readOnlyOrigin
                }
              ];
            }
            const typeIssues = findConnectorTypeIssues(options.connectorTypes, connection);
            if (typeIssues.length > 0) return typeIssues;
            const appIssue = findPersonContextAppIssue(options.connectorTypes, connection);
            if (appIssue) {
              throw new AppError("VALIDATION_FAILED", appIssue.message, {
                reason: CONNECTION_REFUSALS.personContextAppUnavailable
              });
            }
            const egress = egressIssue(options, connection);
            return egress ? [egress] : [];
          });
      },
      summarize: (connection) => ({
        name: connection.name,
        title: connection.displayName,
        ...(connection.description === undefined ? {} : { description: connection.description }),
        attributes: {
          connectorType: connection.connectorType,
          origin: connection.origin,
          enabled: connection.enabled,
          // Only picks the icon a list shows.
          ...(connection.service === undefined ? {} : { service: connection.service }),
          // A Knowledge Base can sync documents through it: its page offers it as a source.
          ...(options.connectorTypes.get(connection.connectorType)?.documentSource === undefined
            ? {}
            : { documentSource: true })
        }
      })
    }),
    references: () => [],
    holdsInstanceDefault: false,
    hasWorkspaceAvailability: true,
    prepareInteractiveUpsert: ({ current, next, principalId }) =>
      withServerFields(current, next, principalId),
    // An earlier revision may name a handle the Connection no longer has: its secret is stored
    // under the one the Connection holds now, and a call resolves the handle of the revision.
    // A revision of release config stays one, and the write refuses it.
    prepareRevert: ({ current, restored, principalId }) =>
      readDefinitionField(restored, "origin") === "release"
        ? restored
        : withServerFields(
            current ?? { ownerPrincipalId: readDefinitionField(restored, "ownerPrincipalId") },
            restored,
            principalId
          ),
    missingUpsertRight: () => undefined,
    // Asked before the definition is read: a seeded Connection answers `read_only_origin`
    // also where this build ships no Connector type for what the caller sent.
    assertStoredWritable({ current }) {
      if (readDefinitionField(current, "origin") === "release") {
        throw readOnlyOrigin();
      }
    },
    assertInteractiveUpsertAllowed: ({ surface }) => refuseBatch(surface),
    assertInteractiveDeleteAllowed: ({ surface }) => refuseBatch(surface),
    // An agent names tools and an App names Connections in its manifest. Neither is checked
    // again when the Connection goes, so a delete asks here: of each, its draft and what it
    // serves now.
    async assertRemovable({ name, assets }) {
      const carrying = (await assets(AGENT_ASSET_KIND)).filter((agent) =>
        [agent.config, agent.publishedConfig].some((config) =>
          toolNamesOf(config).some(
            (toolName) => parseConnectionOperationName(toolName)?.connection === name
          )
        )
      ).length;
      const naming = (await assets(APP_ASSET_KIND)).filter((app) =>
        [app.config, app.publishedConfig].some((config) =>
          manifestConnectionsOf(config).includes(name)
        )
      ).length;
      if (carrying === 0 && naming === 0) return;
      const users = [
        ...(carrying === 0
          ? []
          : [carrying === 1 ? "an agent carries its tools" : `${carrying} agents carry its tools`]),
        ...(naming === 0 ? [] : [naming === 1 ? "an App names it" : `${naming} Apps name it`])
      ];
      throw new AppError(
        "CONFLICT",
        `${CONNECTION_REFUSALS.inUse}: ${users.join(" and ")}. Take it off them first`,
        { reason: CONNECTION_REFUSALS.inUse, agentCount: carrying, appCount: naming }
      );
    },
    // A sign-in made for another server, or kept by a Connection that no longer signs in,
    // ends in the write's transaction: the binding is revoked and its tokens are deleted with
    // the revision, so no call after the commit uses them, and a revert restores none. The
    // provider is asked to revoke the grant once the write committed.
    async withinWrite(input) {
      const { clientInstanceId, assetId, previous, config, stores } = input;
      if (assetId === undefined || previous === undefined) return undefined;
      const next = connectionConfigSchema.safeParse(config);
      const nextType = next.success
        ? options.connectorTypes.get(next.data.connectorType)
        : undefined;
      const target = next.success ? targetOf(options, next.data) : undefined;
      const header = next.success
        ? nextType?.personContextHeaderName?.(next.data.settings)
        : undefined;
      await stores.connections.revokeConnectionPersonContexts({
        clientInstanceId,
        connectionAssetId: assetId,
        ...(target === undefined ? {} : { origin: egressOriginOf(target) }),
        ...(header === undefined ? {} : { header })
      });
      const reason = signInEndOf(options, previous, config);
      let after: AssetWriteFollowUp | undefined;
      if (reason !== undefined) {
        const ending = options.signInEnding;
        if (ending === undefined) {
          await endConnectionSignIn(
            stores.connections,
            { clientInstanceId, connectionAssetId: assetId },
            {
              reason,
              ...(input.actor.userId === undefined ? {} : { changedBy: input.actor.userId })
            }
          );
        } else {
          // Reads the token set and the client secret the provider is told with, then ends.
          const ended = await ending.end(stores, {
            connectionAssetId: assetId,
            connectionName: input.name,
            connectionRevision: input.previousRevision ?? 0,
            config: previous,
            reason,
            actor: input.actor,
            correlationId: input.correlationId
          });
          if (ended !== undefined) {
            after = {
              committed: async () => {
                await ended.revokeAtProvider();
              },
              rolledBack: () => ended.discard()
            };
          }
        }
      }
      // The Connection's own secret, where it no longer sends one or was entered for another
      // origin (the target, the authorization server's addresses, its issuer or the client), is
      // deleted with the revision that left it, in the same transaction as the sign-in's end.
      // No call or refresh after the commit finds it, and a revert brings none back.
      if (next.success) {
        const moved = originMoved(options, previous, next.data);
        if (next.data.authScheme === AUTH_SCHEME_NONE || moved) {
          await stores.connections.deleteSecrets({
            clientInstanceId,
            connectionAssetId: assetId,
            subject: SHARED_CREDENTIAL_SUBJECT
          });
        }
        if (moved) {
          // A client registered for the old server is no client of the new one.
          await stores.connections.putConnectionOAuthClient({
            clientInstanceId,
            connectionAssetId: assetId,
            oauthClient: null
          });
        }
      }
      return after;
    },
    // A change of where or how the Connection reaches its system makes what a test found
    // stale, and every write asks for a discovery, which stores nothing a write did not accept.
    // The key of an origin the Connection left went in the write's transaction (`withinWrite`).
    async afterWrite({ clientInstanceId, name, previous, config, stores }) {
      const parsed = connectionConfigSchema.safeParse(config);
      if (!parsed.success) return;
      const connection = parsed.data;
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: CONNECTION_ASSET_KIND,
        name
      });
      if (!asset) return;
      const connectionAssetId = asset.id;
      const authenticates = connection.authScheme !== AUTH_SCHEME_NONE;
      const origin = credentialOriginOf(options, connection);
      const configured = !authenticates || (await credentialFor(origin));
      /**
       * Whether the Connection holds what calls to `origin` need. One that signs in has a
       * sign-in made for that server; its own secret, where it has one, is the client's.
       * Any other has its own secret, entered for that server.
       */
      async function credentialFor(origin: string | undefined): Promise<boolean> {
        if (origin === undefined) return false;
        if (connection.authScheme === AUTH_SCHEME_OAUTH) {
          const binding = await stores.connections.getConnectionBinding({
            clientInstanceId,
            connectionAssetId,
            subject: SHARED_CREDENTIAL_SUBJECT
          });
          return binding?.state === "connected" && binding.origin === origin;
        }
        const secret = await stores.connections.findSecret({
          clientInstanceId,
          binding: { connectionAssetId, subject: SHARED_CREDENTIAL_SUBJECT }
        });
        return secret?.origin === origin;
      }
      if (previous === undefined || reachChanged(previous, connection)) {
        const settingsChanged = !configValuesEqual(
          readDefinitionField(previous, "settings"),
          connection.settings
        );
        await stores.connections.putConnectionState({
          clientInstanceId,
          connectionAssetId,
          health: configured ? "unknown" : "needs_configuration",
          lastErrorCode: null,
          // What another system listed is not what this one lists.
          ...(settingsChanged ? { catalog: null } : {})
        });
      }
      const discovers = options.connectorTypes.get(connection.connectorType)?.discover;
      if (connection.enabled && discovers && configured) {
        await requestConnectionDiscovery(stores.jobs, { clientInstanceId, connectionName: name });
      }
    },
    // The secret and the runtime state go with the Connection. An asset revert never brings
    // back a secret.
    async onRemove({ clientInstanceId, assetId, stores }) {
      await stores.connections.deleteSecrets({ clientInstanceId, connectionAssetId: assetId });
      await stores.connections.deleteConnectionState({
        clientInstanceId,
        connectionAssetId: assetId
      });
    }
  };
}
