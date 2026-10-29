import { apiOperations, connectionNameParamsSchema } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_EXPOSURE_ACTION_PREFIX,
  auditActorFromIdentity,
  connectionAdminConsentReturnOf,
  connectionCallReasonOf,
  connectionOAuthError,
  personalConnectionBrowserError,
  connectionOAuthReasonOf,
  isAppError,
  isAuthenticatedServicePrincipal,
  isOutsideCall,
  type ActorAccess,
  type AuthenticatedIdentity,
  type OperationAuthorization,
  type OperationExecutionContext,
  type OperationResource
} from "@work-shape/catalyst-core";
import { accessResource, decide } from "../assets/asset-access";
import { readConnectionAccess } from "../connections/connection-access";
import { requestConnectionDiscovery } from "../connections/connection-jobs";
import type { ConnectionManagementPort } from "../connections/connection-management-port";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The kind of the assets that carry a Connection's tools. */
const AGENT_ASSET_KIND = "agent";
/** The module these operations belong to. */
const CONNECTIONS_MODULE = "connections";
/** Bounds the published-consumer scan; the page offers retry after a timed-out read. */
const CONNECTION_DETAIL_TIMEOUT_MS = 15_000;
/** What the run of a secret write keeps in the value's place. */
const SECRET_MARK = "[secret]";

/**
 * What a Connection's page and the agent editor read beyond the asset, and the test. Each is
 * an operation of the registry. The right is the Connection's own and is decided on the
 * Connection the call names, so every operation brings its check. Every field these routes
 * read is declared: `name` is the one path field, and only the source folders take a query.
 */
export function registerConnectionRoutes(route: Route, options: ChatServerOptions): void {
  const { connections } = options;

  /** Decided on the stored Connection, or on the name alone where none carries it. */
  async function authorizeOn(
    access: ActorAccess,
    action: string,
    name: string
  ): Promise<OperationAuthorization> {
    const resource = (await connections?.resource(name)) ?? {
      kind: CONNECTION_ASSET_KIND,
      name
    };
    return decide(access, action, resource);
  }

  function requestDiscovery(connectionName: string): Promise<void> {
    return requestConnectionDiscovery(options.stores.jobs, {
      clientInstanceId: options.clientInstanceId,
      connectionName
    });
  }

  function required(): ConnectionManagementPort {
    if (!connections) {
      throw new AppError("NOT_FOUND", "This instance has no Connections");
    }
    return connections;
  }

  /** The agents the caller may read, with the tools each lists. One read of the agents. */
  async function readableAgents(access: ActorAccess) {
    const kind = options.configAssets.kinds.get(AGENT_ASSET_KIND);
    if (!kind) return [];
    const agents = await options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId,
      kind: AGENT_ASSET_KIND
    });
    return agents.flatMap((agent) => {
      const resource = accessResource(agent.kind, agent.name, agent.scope, agent.id);
      if (!access.authorize(kind.actions.read, resource).allowed) return [];
      const toolNames = agent.config?.toolNames;
      const listed = Array.isArray(toolNames)
        ? toolNames.filter((toolName): toolName is string => typeof toolName === "string")
        : [];
      let title = agent.name;
      try {
        title = kind.summarize(agent.config).title;
      } catch {
        // A stored agent this build does not read keeps its name as its title.
      }
      return [{ name: agent.name, title, toolNames: listed }];
    });
  }

  async function authorizeSignIn(access: ActorAccess, name: string) {
    return authorizeOn(
      access,
      (await required().credentialMode(name)) === "user"
        ? CONNECTION_ACTIONS.use
        : CONNECTION_ACTIONS.write,
      name
    );
  }
  route.operation(apiOperations["connections.mine"], {
    authorize: () => ({ allowed: true }),
    module: CONNECTIONS_MODULE,
    execute: (_input, context) =>
      required().myConnections(
        context.actor.id,
        (resource) => context.access.authorize(CONNECTION_ACTIONS.use, resource).allowed
      )
  });
  route.operation(apiOperations["connections.people"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: (input) => required().connectionPeople(input.name)
  });
  route.operation(apiOperations["connections.revoke_person"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: (input, context) =>
      required().revokePerson(input.name, input.userId, {
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId
      })
  });

  route.operation(apiOperations["connections.person_context"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: (input) => required().getPersonContext(input.name, input)
  });
  route.operation(apiOperations["connections.set_person_context"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    changeClass: "reversible",
    inputWithoutSecrets: (input) => ({ ...input, value: null }),
    execute: (input, context) =>
      required().setPersonContext(input.name, input, {
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId
      })
  });

  route.operation(apiOperations["connections.get"], {
    timeoutMs: CONNECTION_DETAIL_TIMEOUT_MS,
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.read, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: async (input, context) =>
      required().get(input.name, await readableAgents(context.access), (resource) => {
        const kind = options.configAssets.kinds.get(resource.kind ?? "");
        return (
          kind !== undefined &&
          options.modules.offModuleOf("kind", kind.kind) === undefined &&
          [kind.actions.read, kind.actions.use].some(
            (right) => right !== undefined && context.access.authorize(right, resource).allowed
          )
        );
      })
  });

  // Who may use the Connection, under the right that reads its page.
  route.operation(apiOperations["connections.access"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.read, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => {
      const { actor, access } = context;
      if (isAuthenticatedServicePrincipal(actor)) {
        throw new AppError("FORBIDDEN", "A service principal reads no holders of a Connection");
      }
      const assetId = (await required().resource(input.name))?.assetId;
      if (assetId === undefined) {
        throw new AppError("NOT_FOUND", "Connection not found");
      }
      return readConnectionAccess(options, { actor, access }, assetId);
    }
  });

  route.operation(apiOperations["connections.test"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    // A test changes nothing outside. It writes the health, which the next test overwrites.
    changeClass: "reversible",
    module: CONNECTIONS_MODULE,
    execute: (input, context) => required().test(input.name, context.runtime.signal, context.actor)
  });

  // Who may use the Connection may choose its folders: the right a source's publish needs.
  route.operation(apiOperations["connections.source_folders"], {
    authorize: (input, { access, actor, origin }) =>
      // Folder names are data of the outside system, and listing them is no operation with an
      // exposure: nothing exposes them to `outside`, so an API credential is refused as a call
      // of an operation not exposed to it is.
      isOutsideCall(actor, origin)
        ? {
            allowed: false,
            action: `${CONNECTION_EXPOSURE_ACTION_PREFIX}outside`,
            reason: "no_grant"
          }
        : authorizeOn(access, CONNECTION_ACTIONS.use, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => {
      const port = required();
      if (!(await port.resource(input.name))) {
        throw new AppError("NOT_FOUND", `Connection '${input.name}' does not exist`);
      }
      if (!port.sourceFolders) {
        throw new AppError("CONFLICT", "This instance offers no folder choice");
      }
      return port.sourceFolders(
        input.name,
        {
          ...(input.parent === undefined ? {} : { parentId: input.parent }),
          ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken })
        },
        context.runtime.signal ?? new AbortController().signal
      );
    }
  });

  route.operation(apiOperations["connections.set_secret"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    // A secret that was replaced cannot be brought back.
    inputWithoutSecrets: (input) => ({ ...input, value: SECRET_MARK }),
    module: CONNECTIONS_MODULE,
    execute: async (input) => {
      const secret = await required().setSecret(input.name, {
        value: input.value,
        expectedVersion: input.expectedVersion,
        expectedRevision: input.expectedRevision
      });
      // What the system offers may depend on whose key asks. A Connection with nothing to
      // discover ends that discovery at once.
      await requestDiscovery(input.name);
      return secret;
    }
  });

  route.operation(apiOperations["connections.discover"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    // A discovery stores what the system offers now and accepts nothing.
    changeClass: "reversible",
    module: CONNECTIONS_MODULE,
    execute: async (input) => {
      if (!(await required().resource(input.name))) {
        throw new AppError("NOT_FOUND", `Connection '${input.name}' does not exist`);
      }
      await requestDiscovery(input.name);
      return { status: "queued" as const };
    }
  });

  route.operation(apiOperations["connections.oauth_start"], {
    authorize: (input, { access }) => authorizeSignIn(access, input.name),
    resource: connectionResource,
    // A start keeps a sign-in session that ends by itself, and registers a client where the
    // provider has none for the instance. Nothing is connected before the callback.
    changeClass: "reversible",
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => {
      const starter = signInStarter(context.actor);
      if (
        (await required().credentialMode(input.name)) === "user" &&
        starter.authSessionId.startsWith("key:")
      ) {
        throw personalConnectionBrowserError();
      }
      return required().oauthStart(input.name, {
        starter,
        audit: signInAudit(context),
        signal: context.runtime.signal
      });
    }
  });

  route.operation(apiOperations["connections.oauth_sign_in"], {
    authorize: (input, { access }) => authorizeSignIn(access, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => ({
      state: (await required().oauthWaiting(input.name, {
        signInId: input.signInId,
        userId: context.actor.id
      }))
        ? ("waiting" as const)
        : ("ended" as const)
    })
  });

  route.operation(apiOperations["connections.oauth_complete"], {
    // Whose sign-in it is and the right on the Connection are checked once the state is read;
    // the state must name the Connection of the path.
    authorize: () => ({ allowed: true }),
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => {
      const { actor } = context;
      const firstParty =
        !isAuthenticatedServicePrincipal(actor) &&
        actor.authenticationMethod === "session-cookie" &&
        actor.delegatedActor === undefined;
      const { name, ...query } = input;
      // An administrator back from the admin-consent link: nothing to complete, the landing
      // says the app is approved. People sign in afterwards as before.
      const returned = connectionAdminConsentReturnOf(query);
      const approved =
        returned === undefined ? undefined : required().oauthLandingUrl(returned, name);
      if (approved !== undefined) return { location: approved };
      const completed = await required().oauthComplete({
        connectionName: name,
        query,
        completer: isAuthenticatedServicePrincipal(actor)
          ? undefined
          : {
              userId: actor.id,
              firstPartySessionId: firstParty ? actor.sessionId : undefined
            },
        mayUse: (resource) => context.access.authorize(CONNECTION_ACTIONS.use, resource).allowed,
        mayWrite: (resource) =>
          context.access.authorize(CONNECTION_ACTIONS.write, resource).allowed,
        audit: signInAudit(context),
        signal: context.runtime.signal
      });
      // What the outside system offers may depend on the account that signed in.
      if ((await required().credentialMode(completed.connectionName)) === "shared")
        await requestDiscovery(completed.connectionName);
      return { location: completed.location };
    },
    // The administrator who approved has no session on the instance as a rule: the return is
    // told by its query before the call was let in.
    redirectOnError: (error, request) =>
      connections?.oauthLandingUrl(...(adminConsentReturnOf(request) ?? signInOutcomeOf(error)))
  });

  route.operation(apiOperations["connections.disconnect"], {
    authorize: (input, { access }) => authorizeSignIn(access, input.name),
    resource: connectionResource,
    // The tokens are deleted and the grant revoked at the provider: a new sign-in is the way
    // back, never a revert.
    module: CONNECTIONS_MODULE,
    execute: async (input, context) => {
      if ((await required().credentialMode(input.name)) === "user") {
        const starter = signInStarter(context.actor);
        if (starter.authSessionId.startsWith("key:")) throw personalConnectionBrowserError();
      }
      return required().disconnect(input.name, {
        actor: auditActorFromIdentity(context.actor),
        correlationId: context.correlationId
      });
    }
  });

  route.operation(apiOperations["connections.list_tools"], {
    // The list decides the right per Connection. A caller without one receives an empty list.
    authorize: () => ({ allowed: true }),
    module: CONNECTIONS_MODULE,
    execute: (_input, context) =>
      connections
        ? connections.listTools(
            (resource) => context.access.authorize(CONNECTION_ACTIONS.read, resource).allowed
          )
        : { connections: [] }
  });

  route.operation(apiOperations["connections.connector_types"], {
    // What a Connection can be made of, for whoever may make one or change one: a writer of a
    // single Connection reads its type's form on the Connection's page. The list names the
    // build's types and the catalogue's entries, nothing of any Connection.
    authorize: (_input, { access }) =>
      access.holdsGrantAt(CONNECTION_ACTIONS.write, ["asset"])
        ? { allowed: true }
        : decide(access, CONNECTION_ACTIONS.write, { kind: CONNECTION_ASSET_KIND }),
    module: CONNECTIONS_MODULE,
    execute: () => (connections ? connections.connectorTypes() : { types: [] })
  });
}

/** What the call touches, as its run and its events name it. */
function connectionResource(input: { name: string }): OperationResource {
  return { kind: CONNECTION_ASSET_KIND, id: input.name, name: input.name };
}

/**
 * Who starts a sign-in: a person in their first-party session, or through their personal API
 * key. A service principal, a Workflow Run and an embedding host's session token are refused:
 * the account a Connection signs in to is chosen by a person in a browser.
 */
function signInStarter(actor: AuthenticatedIdentity): { userId: string; authSessionId: string } {
  if (!isAuthenticatedServicePrincipal(actor)) {
    if (actor.delegatedActor?.kind === "api_key") {
      return { userId: actor.id, authSessionId: `key:${actor.delegatedActor.id}` };
    }
    if (
      actor.delegatedActor === undefined &&
      actor.authenticationMethod === "session-cookie" &&
      actor.sessionId !== undefined
    ) {
      return { userId: actor.id, authSessionId: actor.sessionId };
    }
  }
  throw connectionOAuthError("oauth_requires_person");
}

function signInAudit(context: OperationExecutionContext) {
  return {
    auditRecorder: context.audit,
    actor: auditActorFromIdentity(context.actor),
    correlationId: context.correlationId
  };
}

/**
 * The outcome a refused callback lands with: its reason, never the text of an error, and the
 * Connection's name where the refusal knows it.
 */
/** The landing of a return from the admin-consent link, read from the unchecked request. */
function adminConsentReturnOf(request: {
  query: unknown;
  params: unknown;
}): [outcome: string, connectionName?: string] | undefined {
  const query =
    typeof request.query === "object" && request.query !== null ? request.query : undefined;
  if (query === undefined) return undefined;
  const returned = connectionAdminConsentReturnOf({
    state: Reflect.get(query, "state"),
    error: Reflect.get(query, "error")
  });
  if (returned === undefined) return undefined;
  const named = connectionNameParamsSchema.safeParse(request.params);
  return named.success ? [returned, named.data.name] : [returned];
}

function signInOutcomeOf(error: unknown): [outcome: string, connectionName?: string] {
  const outcome =
    connectionOAuthReasonOf(error) ??
    connectionCallReasonOf(error) ??
    (!isAppError(error)
      ? "failed"
      : error.code === "UNAUTHENTICATED"
        ? "oauth_requires_person"
        : error.code === "FORBIDDEN"
          ? "forbidden"
          : "failed");
  const details = isAppError(error) ? error.details : undefined;
  const named =
    typeof details === "object" && details !== null && "connection" in details
      ? connectionNameParamsSchema.shape.name.safeParse(details.connection)
      : undefined;
  return named?.success ? [outcome, named.data] : [outcome];
}
