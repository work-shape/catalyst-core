import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  type ActorAccess,
  type OperationAuthorization,
  type OperationResource
} from "@work-shape/catalyst-core";
import { accessResource, decide } from "../asset-access";
import { requestConnectionDiscovery } from "../connection-jobs";
import type { ConnectionManagementPort } from "../connection-management-port";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The kind of the assets that carry a Connection's tools. */
const AGENT_ASSET_KIND = "agent";
/** The module these operations belong to. */
const CONNECTIONS_MODULE = "connections";
/** What the run of a secret write keeps in the value's place. */
const SECRET_MARK = "[secret]";

/**
 * What a Connection's page and the agent editor read beyond the asset, and the test. Each is
 * an operation of the registry. The right is the Connection's own and is decided on the
 * Connection the call names, so every operation brings its check. Every field these routes
 * read is declared: `name` is the one path field, and none takes a body or a query.
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

  route.operation(apiOperations["connections.get"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.read, input.name),
    resource: connectionResource,
    module: CONNECTIONS_MODULE,
    execute: async (input, context) =>
      required().get(input.name, await readableAgents(context.access))
  });

  route.operation(apiOperations["connections.test"], {
    authorize: (input, { access }) => authorizeOn(access, CONNECTION_ACTIONS.write, input.name),
    resource: connectionResource,
    // A test changes nothing outside. It writes the health, which the next test overwrites.
    changeClass: "reversible",
    module: CONNECTIONS_MODULE,
    execute: (input, context) => required().test(input.name, context.runtime.signal)
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
        expectedVersion: input.expectedVersion
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
}

/** What the call touches, as its run and its events name it. */
function connectionResource(input: { name: string }): OperationResource {
  return { kind: CONNECTION_ASSET_KIND, id: input.name, name: input.name };
}
