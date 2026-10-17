import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  CONNECTION_EXPOSURE_ACTION_PREFIX,
  connectionOperationName,
  exposureOfOrigin,
  parseConnectionOperationName,
  type ConnectionOperationConfig,
  type ConnectorOperationDescriptor,
  type DataToolDescriptor,
  type DataToolSource,
  type JsonValue,
  connectionUseDeniedSentence,
  type OperationAuthorization,
  type OperationAuthorizeContext,
  type OperationDefinition,
  type OperationOrigin,
  type OperationResource,
  type OperationSource
} from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  CONNECTION_CALL_TIMEOUT_MS,
  CONNECTION_SLOT_WAIT_MS,
  ConnectionCallSlots,
  callConnectionOperation,
  connectionCallLimits
} from "./call";
import {
  connectionOperationStatus,
  describedByOutsideSystem,
  type ConnectionOperationState
} from "./catalog";
import {
  readConnection,
  readConnections,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { jsonSchemaAsZod, outsideJsonSchemaAsZod, outsideSchemaChecker } from "./schema-check";

export type { ConnectionOperationSourceDeps } from "./connection-reads";

// A Connection's accepted operations as operations of the platform. Each one is called
// through `runOperation` like every other operation: this file says who may call it and what
// the policy starts from, and `call.ts` executes it. A tool an agent carries is a projection
// of the same definition and has no second way to run.

/** The module a Connection's operations belong to. */
const CONNECTIONS_MODULE = "connections";

/**
 * How much longer than its slot wait and its call a run may stay `running` before it counts
 * as interrupted, in milliseconds. It covers the reads around the call.
 */
const CONNECTION_RUN_GRACE_MS = 30_000;

/** How long the description of a tool is at most as a model is sent it. */
export const CONNECTION_TOOL_DESCRIPTION_MAX_CHARS = 4_000;

function resourceOf(connection: StoredConnection): OperationResource {
  return {
    kind: CONNECTION_ASSET_KIND,
    id: connection.assetId,
    assetId: connection.assetId,
    name: connection.config.name
  };
}

/**
 * Whether the operation is exposed to the surface the call came through. An agent needs
 * `agent`, an App `bridge`, a Workflow `workflow`, the CLI and an MCP client `outside`. An
 * operation exposed to nobody is callable by nobody, and a person outside an App and a
 * schedule by none.
 */
export function connectionExposureDenial(
  operation: Pick<ConnectionOperationConfig, "exposure">,
  origin: OperationOrigin
): Extract<OperationAuthorization, { allowed: false }> | undefined {
  const needed = exposureOfOrigin(origin);
  return needed !== undefined && operation.exposure.includes(needed)
    ? undefined
    : {
        allowed: false,
        action: `${CONNECTION_EXPOSURE_ACTION_PREFIX}${needed ?? origin.kind}`,
        reason: "no_grant"
      };
}

/**
 * The operation's own check of the caller. The exposure is asked first, so an operation that
 * is not exposed to the caller's surface never reaches the policy and files no approval. Then
 * the right `connection.use` on the Connection. A refusal names the right in its denial and
 * says in a sentence that it is a refusal, not a fault of the Connection.
 */
function authorizeCall(
  connection: StoredConnection,
  operation: ConnectionOperationConfig,
  context: OperationAuthorizeContext
): OperationAuthorization {
  const unexposed = connectionExposureDenial(operation, context.origin);
  if (unexposed) return unexposed;
  const decision = context.access.authorize(CONNECTION_ACTIONS.use, resourceOf(connection));
  if (decision.allowed) return { allowed: true };
  return {
    allowed: false,
    action: CONNECTION_ACTIONS.use,
    reason: decision.reason,
    // An agent that carries the tool was given it by name in its config, so the person in
    // its chat reads the Connection's label there. Any other caller is told no label: the
    // refusal must not show a Connection to somebody who may not see it.
    message: connectionUseDeniedSentence(
      context.origin.kind === "agent" ? connection.config.displayName : undefined
    )
  };
}

function stateOf(
  connection: StoredConnection,
  operation: ConnectionOperationConfig
): ConnectionOperationState {
  if (!connection.type) return { status: "unknown" };
  return connectionOperationStatus({
    type: connection.type,
    operation,
    catalog: connection.catalog
  });
}

/** Whether a call of the operation can reach the outside system now. */
function isCallable(connection: StoredConnection, state: ConnectionOperationState): boolean {
  return (
    connection.config.enabled &&
    connection.type !== undefined &&
    connection.state?.health !== "secret_unreadable" &&
    state.status === "ready"
  );
}

/**
 * The definition of one accepted operation. An operation that is not callable now still has
 * one, so that its call is authorized, recorded and refused with the reason. Such a
 * definition reads any input: a schema nobody accepted is never used to validate and never
 * told to a caller. `execute` refuses it before anything else happens.
 *
 * The input schema of an operation an outside system described is checked in a worker thread,
 * so the definition's `inputSchema` is parsed with `safeParseAsync`. A check that is cut off
 * rejects the parse with its reason and is logged here by the names of the Connection and the
 * operation, never with the input.
 */
function definitionOf(
  deps: ConnectionOperationSourceDeps,
  slots: ConnectionCallSlots,
  connection: StoredConnection,
  operation: ConnectionOperationConfig
): OperationDefinition<unknown, JsonValue> {
  const state = stateOf(connection, operation);
  const descriptor = isCallable(connection, state) ? state.descriptor : undefined;
  const limits = connection.type
    ? connectionCallLimits(connection.type)
    : { callTimeoutMs: CONNECTION_CALL_TIMEOUT_MS, slotWaitMs: CONNECTION_SLOT_WAIT_MS };
  const resource = resourceOf(connection);
  const target = {
    connectionName: connection.config.name,
    operationName: operation.name,
    assetId: connection.assetId,
    revision: connection.revision
  };
  return {
    name: connectionOperationName(connection.config.name, operation.name),
    effect: operation.effect,
    // A read of a customer's system is recorded, every time.
    ...(operation.effect === "reading" ? { recordsEveryCall: true as const } : {}),
    ...(operation.policy === undefined ? {} : { defaultPolicy: operation.policy }),
    // The outside system is handed the key of the call and carries out one call per key.
    ...(operation.effect === "changing" &&
    operation.idempotencyKeyHeader !== undefined &&
    connection.type?.carriesIdempotencyKey === true
      ? { repeatsUnderKey: true as const }
      : {}),
    action: null,
    authorize: (_input, context) => authorizeCall(connection, operation, context),
    scope: null,
    auth: "principal",
    inputSchema: inputSchemaOf(deps, connection, operation, descriptor),
    // The result is checked inside the call, where a failure has a reason of its own.
    outputSchema: z.unknown(),
    // What the outside system, or the type, described: for whoever shows the operation.
    ...(descriptor ? { inputJsonSchema: descriptor.inputSchema } : {}),
    ...(descriptor?.outputSchema ? { outputJsonSchema: descriptor.outputSchema } : {}),
    resource: () => resource,
    module: CONNECTIONS_MODULE,
    timeoutMs: limits.slotWaitMs + limits.callTimeoutMs + CONNECTION_RUN_GRACE_MS,
    execute: (input, context) => callConnectionOperation(deps, slots, target, input, context)
  };
}

function inputSchemaOf(
  deps: ConnectionOperationSourceDeps,
  connection: StoredConnection,
  operation: ConnectionOperationConfig,
  descriptor: ConnectorOperationDescriptor | undefined
): z.ZodType {
  if (!descriptor) return z.unknown();
  if (!connection.type || !describedByOutsideSystem(connection.type)) {
    return jsonSchemaAsZod(descriptor.inputSchema);
  }
  return outsideJsonSchemaAsZod(
    descriptor.inputSchema,
    deps.schemaChecker ?? outsideSchemaChecker(),
    (reason) => {
      deps.logger.warn(
        { connection: connection.config.name, operation: operation.name, checked: "input", reason },
        "A check by the schema of a Connection operation gave no answer"
      );
    }
  );
}

/**
 * The source of every Connection's operations. `resolve` reads the one Connection a name
 * stands for, and `resolveMany` each Connection its names belong to once. `list` reads all of
 * them in two reads. Neither contacts an outside system.
 */
export function createConnectionOperationSource(
  deps: ConnectionOperationSourceDeps,
  sharedSlots?: ConnectionCallSlots
): OperationSource {
  const slots = sharedSlots ?? new ConnectionCallSlots();
  return {
    async resolve(name) {
      const parsed = parseConnectionOperationName(name);
      if (!parsed) return undefined;
      const connection = await readConnection(deps, parsed.connection);
      const operation = connection?.config.operations.find(
        (candidate) => candidate.name === parsed.operation
      );
      if (!connection || !operation) return undefined;
      return definitionOf(deps, slots, connection, operation);
    },
    async resolveMany(names) {
      const wanted = names.flatMap((name) => parseConnectionOperationName(name) ?? []);
      // One read of each Connection the names belong to, whatever the number of names.
      const connections = await Promise.all(
        [...new Set(wanted.map((entry) => entry.connection))].map((name) =>
          readConnection(deps, name)
        )
      );
      const byName = new Map(
        connections.flatMap((connection) =>
          connection ? [[connection.config.name, connection] as const] : []
        )
      );
      return wanted.flatMap((entry) => {
        const connection = byName.get(entry.connection);
        const operation = connection?.config.operations.find(
          (candidate) => candidate.name === entry.operation
        );
        return connection && operation ? [definitionOf(deps, slots, connection, operation)] : [];
      });
    },
    async list() {
      const definitions: OperationDefinition[] = [];
      for (const connection of await readConnections(deps)) {
        for (const operation of connection.config.operations) {
          if (!isCallable(connection, stateOf(connection, operation))) continue;
          definitions.push(definitionOf(deps, slots, connection, operation));
        }
      }
      return { operations: definitions, truncated: [] };
    }
  };
}

/**
 * What an agent's tool list reads. Of the names an agent lists, it describes those that are
 * callable now and exposed to agents, with the description and the input schema of the
 * accepted descriptor. A list without a Connection's name costs no read.
 */
export function createConnectionToolSource(deps: ConnectionOperationSourceDeps): DataToolSource {
  return {
    async describe(toolNames) {
      const wanted = toolNames.flatMap((name) => {
        const parsed = parseConnectionOperationName(name);
        return parsed ? [{ name, ...parsed }] : [];
      });
      if (wanted.length === 0) return [];
      const byName = new Map(
        (await readConnections(deps)).map((connection) => [connection.config.name, connection])
      );
      const tools: DataToolDescriptor[] = [];
      for (const { name, connection: connectionName, operation: operationName } of wanted) {
        const connection = byName.get(connectionName);
        const operation = connection?.config.operations.find(
          (candidate) => candidate.name === operationName
        );
        if (!connection || !operation || !operation.exposure.includes("agent")) continue;
        const state = stateOf(connection, operation);
        if (!isCallable(connection, state) || !state.descriptor) continue;
        tools.push({
          name,
          description: state.descriptor.description.slice(0, CONNECTION_TOOL_DESCRIPTION_MAX_CHARS),
          inputJsonSchema: state.descriptor.inputSchema,
          effect: operation.effect
        });
      }
      return tools;
    }
  };
}
