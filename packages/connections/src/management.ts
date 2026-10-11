import {
  AppError,
  CONNECTION_ASSET_KIND,
  CREDENTIAL_REFUSALS,
  EGRESS_DENIED,
  SHARED_CREDENTIAL_SUBJECT,
  connectionCallError,
  connectionCallReasonOf,
  connectionOperationName,
  parseConnectionOperationName,
  type AccessResource,
  type ConnectionCallReason,
  type ConnectionExposure,
  type ConnectionHealth,
  type ConnectionOperationEffect,
  type ConnectionOperationStatus,
  type ConnectorTestStatus,
  type OperationResource,
  type SecretState
} from "@vivd-catalyst/core";
import { connectionCallLimits } from "./call";
import { connectionOperationStatus, type ConnectionOperationState } from "./catalog";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { openConnectorContext } from "./connector-context";

// What the Connection's page and the agent editor read beyond the asset, and the test of a
// Connection. Nothing here answers a secret, a handle of one or data of the outside system.

/** How long a description is at most as these answers carry it. */
export const CONNECTION_DESCRIPTION_MAX_CHARS = 4_000;

export interface ConnectionOperationView {
  name: string;
  toolName: string;
  effect: ConnectionOperationEffect;
  exposure: ConnectionExposure[];
  enabled: boolean;
  status: ConnectionOperationStatus;
  description?: string;
  discoveredFingerprint?: string;
}

export interface ConnectionView {
  name: string;
  health: ConnectionHealth;
  lastTestedAt?: string;
  lastErrorCode?: string;
  secret: { state: SecretState; version?: number };
  sharedCredential: boolean;
  operations: ConnectionOperationView[];
  usedBy: { agentName: string; title: string; toolNames: string[] }[];
  discoveredAt?: string;
}

export interface ConnectionTestView {
  status: ConnectorTestStatus;
  testedAt: string;
}

export interface ConnectionToolsView {
  connections: {
    name: string;
    title: string;
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

export interface ConnectionManagement {
  /** What a right on the Connection is decided on. Nothing where no such Connection exists. */
  resource(name: string): Promise<OperationResource | undefined>;
  /** `agents` are the agents the caller may read: `usedBy` names no other. */
  get(name: string, agents: readonly AgentToolListing[]): Promise<ConnectionView>;
  /** The type's bounded test. Writes the health and answers no data of the outside system. */
  test(name: string, signal?: AbortSignal): Promise<ConnectionTestView>;
  /** The tools an agent can carry, of the Connections `readable` admits. */
  listTools(readable: (resource: AccessResource) => boolean): Promise<ConnectionToolsView>;
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
      enabled: operation.enabled,
      status: state.status,
      ...(description === undefined
        ? {}
        : { description: description.slice(0, CONNECTION_DESCRIPTION_MAX_CHARS) }),
      ...(fingerprint === undefined ? {} : { discoveredFingerprint: fingerprint })
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
  return "failed";
}

export function createConnectionManagement(
  deps: ConnectionOperationSourceDeps & { now?: () => Date }
): ConnectionManagement {
  const now = deps.now ?? (() => new Date());

  async function secretOf(connection: StoredConnection): Promise<ConnectionView["secret"]> {
    const record = await deps.stores.connections.findSecret({
      clientInstanceId: deps.clientInstanceId,
      binding: { connectionAssetId: connection.assetId, subject: SHARED_CREDENTIAL_SUBJECT }
    });
    if (!record) return { state: "not_set" };
    // Whether the keys open it is what the seed, a test and a call found out and wrote down.
    const unreadable = connection.state?.health === "secret_unreadable";
    return { state: unreadable ? "unreadable" : "set", version: record.version };
  }

  return {
    async resource(name) {
      const connection = await readConnection(deps, name);
      return connection ? resourceOf(connection) : undefined;
    },

    async get(name, agents) {
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
      const { state, catalog } = connection;
      return {
        name: connection.config.name,
        health: state?.health ?? "unknown",
        ...(state?.lastTestedAt === undefined ? {} : { lastTestedAt: state.lastTestedAt }),
        ...(state?.lastErrorCode === undefined ? {} : { lastErrorCode: state.lastErrorCode }),
        secret: await secretOf(connection),
        sharedCredential: connection.config.credentialMode === "shared",
        operations: operationsOf(connection),
        usedBy,
        ...(catalog ? { discoveredAt: catalog.discoveredAt } : {})
      };
    },

    async test(name, outer) {
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
          credentials: deps.credentials ?? {
            resolve: () => Promise.reject(connectionCallError(CREDENTIAL_REFUSALS.notConfigured))
          },
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
          return tools.length > 0
            ? [{ name: connection.config.name, title: connection.config.displayName, tools }]
            : [];
        })
      };
    }
  };
}
