import {
  AppError,
  CREDENTIAL_REFUSALS,
  connectionCallError,
  connectionCallReasonOf,
  isAppError,
  type ConnectionCallReason,
  type ConnectionCredentialResolver,
  type ConnectionHealth,
  type ConnectorContext,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type JsonValue,
  type OperationExecutionContext
} from "@vivd-catalyst/core";
import { connectionOperationStatus } from "./catalog";
import {
  readConnection,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { openConnectorContext } from "./connector-context";
import { compileJsonSchema } from "./json-schema";

// One call of one accepted operation of a Connection, from the point where the operations
// layer has authorized it, resolved its policy and written its run. The order below is fixed:
// read the Connection again, take a slot, check egress, resolve the credential, call the
// Connector type, check the result. A refusal before the type is called contacts no outside
// system, and a refusal before the egress check passed resolves no credential.

/**
 * The longest one call of a Connection may take, in milliseconds, from the egress check to
 * the result. A Connector type may set a shorter time and never a longer one. A call that
 * takes longer is stopped and answers `upstream_timeout`.
 */
export const CONNECTION_CALL_TIMEOUT_MS = 30_000;

/**
 * The largest result of one call, in bytes of its JSON. A Connector type may set a smaller
 * bound and never a larger one. A larger result answers `output_invalid`.
 */
export const CONNECTION_RESULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How many calls of one Connection run side by side in one process. It protects the outside
 * system, which sees one account. A Connector type may set fewer and never more. A further
 * call waits for a slot.
 */
export const CONNECTION_MAX_PARALLEL_CALLS = 8;

/**
 * How long a call waits for a slot of its Connection, in milliseconds, and never longer than
 * the call itself may take. After it the call answers `connection_busy`.
 */
export const CONNECTION_SLOT_WAIT_MS = 10_000;

/**
 * How many calls of one Connection wait for a slot in one process. It bounds what a slow
 * outside system can pile up here. A further call answers `connection_busy` at once.
 */
export const CONNECTION_MAX_WAITING_CALLS = 64;

/**
 * The shortest credential a result is searched for. A shorter one, such as a four-digit
 * code, would be found in ordinary data.
 */
export const CONNECTION_SECRET_ECHO_MIN_CHARS = 8;

/** The bounds of a call of one type: the type's own, never beyond the platform's. */
export function connectionCallLimits(type: Pick<ConnectorTypeDefinition, "limits">): {
  callTimeoutMs: number;
  resultMaxBytes: number;
  maxParallelCalls: number;
  slotWaitMs: number;
} {
  const callTimeoutMs = Math.min(type.limits.callTimeoutMs, CONNECTION_CALL_TIMEOUT_MS);
  return {
    callTimeoutMs,
    resultMaxBytes: Math.min(type.limits.resultMaxBytes, CONNECTION_RESULT_MAX_BYTES),
    maxParallelCalls: Math.max(
      1,
      Math.min(type.limits.maxParallelCalls, CONNECTION_MAX_PARALLEL_CALLS)
    ),
    slotWaitMs: Math.min(CONNECTION_SLOT_WAIT_MS, callTimeoutMs)
  };
}

interface Waiter {
  grant(): void;
}

/**
 * The slots of every Connection of this process. It holds one entry per Connection that has
 * a call running or waiting and none for any other, so it grows with the Connections in use
 * and never with the calls made.
 */
export class ConnectionCallSlots {
  private readonly byConnection = new Map<string, { active: number; waiting: Waiter[] }>();

  /**
   * Takes a slot of the Connection, waiting for one where all are taken. Answers the release
   * of the slot. Throws `connection_busy` when the wait ends without one.
   */
  async acquire(
    connectionAssetId: string,
    limits: { maxParallelCalls: number; slotWaitMs: number }
  ): Promise<() => void> {
    let entry = this.byConnection.get(connectionAssetId);
    if (!entry) {
      entry = { active: 0, waiting: [] };
      this.byConnection.set(connectionAssetId, entry);
    }
    const held = entry;
    if (held.active < limits.maxParallelCalls) {
      held.active += 1;
      return this.releaseOf(connectionAssetId, held);
    }
    if (held.waiting.length >= CONNECTION_MAX_WAITING_CALLS) {
      throw connectionCallError("connection_busy");
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant() {
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        held.waiting.splice(held.waiting.indexOf(waiter), 1);
        reject(connectionCallError("connection_busy"));
      }, limits.slotWaitMs);
      held.waiting.push(waiter);
    });
    // The slot was handed over by the call that ended: `active` stayed as it was.
    return this.releaseOf(connectionAssetId, held);
  }

  private releaseOf(
    connectionAssetId: string,
    entry: { active: number; waiting: Waiter[] }
  ): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = entry.waiting.shift();
      if (next) {
        next.grant();
        return;
      }
      entry.active -= 1;
      if (entry.active === 0) this.byConnection.delete(connectionAssetId);
    };
  }
}

/** A resolver for a process without Secret Store keys: it has no credential to hand out. */
const NO_CREDENTIALS: ConnectionCredentialResolver = {
  resolve: () => Promise.reject(connectionCallError(CREDENTIAL_REFUSALS.notConfigured))
};

/** A host as DNS writes one, or an address. Anything else is not repeated in an error. */
const HOST_PATTERN = /^[A-Za-z0-9.:_[\]-]{1,255}$/u;

/**
 * The error a failed call leaves with. Only a reason passes: the sentence is this module's
 * own, so no text an outside system sent and no text a Connector type composed reaches a run,
 * an audit row, a log or a caller. A refused target keeps its host and port, which the egress
 * checker names. Any other error becomes an internal failure that says nothing.
 */
function safeCallError(error: unknown, reason: ConnectionCallReason | undefined): AppError {
  if (reason === undefined) {
    return new AppError("INTERNAL", "The connector failed");
  }
  if (reason === "egress_denied" && isAppError(error)) {
    const details: unknown = error.details;
    if (typeof details === "object" && details !== null && "host" in details && "port" in details) {
      const { host, port } = details;
      if (typeof host === "string" && HOST_PATTERN.test(host) && typeof port === "number") {
        return new AppError(
          "FORBIDDEN",
          `${reason}: ${host}:${port} is not allowed by the instance's egress list`,
          { reason, host, port }
        );
      }
    }
  }
  return exposed(connectionCallError(reason));
}

/**
 * The same error with a message that reaches the caller whatever its status. The sentence is
 * the platform's own, and its first word is the reason: without this an `upstream_timeout`
 * would arrive as an internal error that names nothing.
 */
function exposed(error: AppError): AppError {
  return new AppError(error.code, error.message, error.details, { exposeMessage: true });
}

/** The health a failed call leaves behind, for the reasons that say the Connection is broken. */
const HEALTH_OF_FAILURE: Partial<Record<ConnectionCallReason, ConnectionHealth>> = {
  upstream_unauthorized: "failed",
  connection_unavailable: "failed",
  secret_unreadable: "secret_unreadable"
};

/**
 * Writes what a failed call says about the Connection. A row that says it already is left
 * alone, so an outage costs one write and not one per call. A write that fails changes
 * nothing about how the call ends.
 */
async function recordFailedHealth(
  deps: ConnectionOperationSourceDeps,
  connection: StoredConnection,
  reason: ConnectionCallReason | undefined
): Promise<void> {
  const health = reason === undefined ? undefined : HEALTH_OF_FAILURE[reason];
  if (health === undefined || reason === undefined) return;
  if (connection.state?.health === health && connection.state.lastErrorCode === reason) return;
  try {
    await deps.stores.connections.putConnectionState({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: connection.assetId,
      health,
      lastErrorCode: reason
    });
  } catch {
    deps.logger.warn(
      { connection: connection.config.name, reason },
      "The health of a Connection could not be written after a failed call"
    );
  }
}

function base64Forms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const forms: string[] = [];
  // A value inside a longer text is encoded at one of three byte offsets. The characters that
  // also depend on the text before and after it are cut off.
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + bytes.length) * 8) / 6);
    const form = encoded.slice(start, end);
    if (form.length >= CONNECTION_SECRET_ECHO_MIN_CHARS) {
      forms.push(form, form.replaceAll("+", "-").replaceAll("/", "_"));
    }
  }
  return forms;
}

/** A text without its backslashes, which is the same however often it was escaped as JSON. */
function unescaped(text: string): string {
  return text.replaceAll("\\", "");
}

/**
 * Whether the result's JSON holds the credential of the call: as it is, escaped as JSON once
 * or several times over, in base64 of either alphabet, in hex or percent-encoded.
 */
function holdsSecret(serialized: string, secret: string): boolean {
  if (secret.length < CONNECTION_SECRET_ECHO_MIN_CHARS) return false;
  // JSON inside a string of the result escapes a quote or a backslash of the secret again.
  const bare = unescaped(secret);
  if (bare.length >= CONNECTION_SECRET_ECHO_MIN_CHARS && unescaped(serialized).includes(bare)) {
    return true;
  }
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const forms = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    hex,
    hex.toUpperCase(),
    encodeURIComponent(secret),
    ...base64Forms(secret)
  ];
  return forms.some((form) => serialized.includes(form));
}

/** Ends when the deadline passes or the caller stops the call, whichever is first. */
function callSignal(
  timeoutMs: number,
  outer: AbortSignal | undefined
): { signal: AbortSignal; timedOut(): boolean; stop(): void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    stop() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  };
}

/** Rejects when the signal ends, so a type that ignores it does not hold the call open. */
function untilAborted(signal: AbortSignal): { promise: Promise<never>; stop(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(connectionCallError("upstream_timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // The race may be over before this rejects.
  promise.catch(() => undefined);
  return {
    promise,
    stop: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
}

function issuesOf(descriptor: ConnectorOperationDescriptor, value: unknown): "input" | undefined {
  const compiled = compileJsonSchema(descriptor.inputSchema);
  return compiled.ok && compiled.validate(value).length === 0 ? undefined : "input";
}

/** The Connection and the operation of a call as the source resolved them. */
export interface ConnectionCallTarget {
  connectionName: string;
  operationName: string;
  /** The asset and the revision the caller was authorized on. */
  assetId: string;
  revision: number;
}

/**
 * What the operation is now, read again inside the call. The rights and the policy were
 * decided on the revision the source resolved: a Connection that changed since is refused,
 * so nothing is called under an exposure, an effect or a policy that was not the one checked.
 */
function callable(
  connection: StoredConnection | undefined,
  target: ConnectionCallTarget
): {
  connection: StoredConnection;
  type: ConnectorTypeDefinition;
  descriptor: ConnectorOperationDescriptor;
} {
  if (
    !connection ||
    connection.assetId !== target.assetId ||
    connection.revision !== target.revision ||
    !connection.config.enabled ||
    !connection.type ||
    connection.state?.health === "secret_unreadable"
  ) {
    throw connectionCallError("connection_unavailable");
  }
  const operation = connection.config.operations.find(
    (candidate) => candidate.name === target.operationName
  );
  if (!operation) throw connectionCallError("operation_unknown");
  const { status, descriptor } = connectionOperationStatus({
    type: connection.type,
    operation,
    catalog: connection.catalog
  });
  switch (status) {
    case "disabled":
      throw connectionCallError("operation_disabled");
    case "needs_review":
      throw connectionCallError("operation_needs_review");
    case "awaiting_discovery":
    case "unknown":
      throw connectionCallError("operation_unknown");
    case "ready":
      if (!descriptor) throw connectionCallError("operation_unknown");
      return { connection, type: connection.type, descriptor };
  }
}

/**
 * Executes one call. The caller is `runOperation`, which has authorized the actor on the
 * Connection, resolved the policy and written the run. Answers the result of the Connector
 * type once it passed the size bound, the search for the credential and the output schema.
 */
export async function callConnectionOperation(
  deps: ConnectionOperationSourceDeps,
  slots: ConnectionCallSlots,
  target: ConnectionCallTarget,
  input: unknown,
  context: Pick<OperationExecutionContext, "runtime">
): Promise<JsonValue> {
  const { connection, type, descriptor } = callable(
    await readConnection(deps, target.connectionName),
    target
  );
  if (issuesOf(descriptor, input)) throw connectionCallError("input_invalid");
  const limits = connectionCallLimits(type);

  const release = await slots.acquire(connection.assetId, limits);
  const deadline = callSignal(limits.callTimeoutMs, context.runtime.signal);
  const aborted = untilAborted(deadline.signal);
  try {
    let result: JsonValue;
    let secret: string | undefined;
    try {
      // Egress first, then the credential: `openConnectorContext` keeps that order.
      const opening = openConnectorContext({
        type,
        connection: {
          id: connection.assetId,
          revision: connection.revision,
          config: connection.config
        },
        egress: deps.egress,
        credentials: deps.credentials ?? NO_CREDENTIALS,
        signal: deadline.signal
      });
      opening.catch(() => undefined);
      const connectorContext: ConnectorContext = await Promise.race([opening, aborted.promise]);
      secret = connectorContext.credentialFor(connectorContext.target)?.secret;
      const executing = type.execute(target.operationName, toJsonInput(input), connectorContext);
      executing.catch(() => undefined);
      result = await Promise.race([executing, aborted.promise]);
    } catch (error) {
      const reason = deadline.signal.aborted ? "upstream_timeout" : connectionCallReasonOf(error);
      await recordFailedHealth(deps, connection, reason);
      if (reason === undefined) {
        // Nothing of the error is logged: its text may be the outside system's.
        deps.logger.error(
          { connection: connection.config.name, operation: target.operationName },
          "A connector failed without a reason"
        );
      }
      throw safeCallError(error, reason);
    }

    const serialized: string | undefined = JSON.stringify(result);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.resultMaxBytes) {
      throw connectionCallError("output_invalid");
    }
    if (secret !== undefined && holdsSecret(serialized, secret)) {
      throw connectionCallError("output_rejected");
    }
    if (descriptor.outputSchema !== undefined) {
      const compiled = compileJsonSchema(descriptor.outputSchema);
      if (!compiled.ok || compiled.validate(result).length > 0) {
        throw connectionCallError("output_invalid");
      }
    }
    return result;
  } finally {
    aborted.stop();
    deadline.stop();
    release();
  }
}

/** The validated input as the JSON a Connector type is handed. */
function toJsonInput(input: unknown): JsonValue {
  const serialized: string | undefined = JSON.stringify(input);
  if (serialized === undefined) return null;
  const value: JsonValue = JSON.parse(serialized);
  return value;
}
