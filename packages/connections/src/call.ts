import {
  AppError,
  CONNECTION_CALL_REASONS,
  CREDENTIAL_REFUSALS,
  EGRESS_UNRESOLVED,
  connectionCallError,
  connectionCallFailure,
  connectionCallReasonOf,
  isAppError,
  type ConnectionCallReason,
  type ConnectionCredentialResolver,
  type ConnectionHealth,
  type ConnectionOperationEffect,
  type ConnectorContext,
  type ConnectorOperationDescriptor,
  type ConnectorTypeDefinition,
  type JsonValue,
  type OperationExecutionContext
} from "@vivd-catalyst/core";
import { connectionOperationStatus, describedByOutsideSystem } from "./catalog";
import {
  readConnection,
  type ConnectionOperationSourceDeps,
  type StoredConnection
} from "./connection-reads";
import { openConnectorContext } from "./connector-context";
import { compileJsonSchema } from "./json-schema";
import { jsonOfCheckedValue, outsideSchemaChecker } from "./schema-check";

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

/**
 * How long a failed call waits for the write of the Connection's health. The call holds its
 * slot while it waits, so a store that does not answer costs a slot this long and no longer.
 */
export const CONNECTION_HEALTH_WRITE_TIMEOUT_MS = 2_000;

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
   * of the slot and whether the call waited for it. Throws `connection_busy` when the wait
   * ends without one: after `slotWaitMs`, or when the caller stops the call, which takes its
   * place in the line away at once.
   */
  async acquire(
    connectionAssetId: string,
    limits: { maxParallelCalls: number; slotWaitMs: number },
    signal?: AbortSignal
  ): Promise<{ release: () => void; waited: boolean }> {
    if (signal?.aborted) throw connectionCallError("connection_busy");
    let entry = this.byConnection.get(connectionAssetId);
    if (!entry) {
      entry = { active: 0, waiting: [] };
      this.byConnection.set(connectionAssetId, entry);
    }
    const held = entry;
    if (held.active < limits.maxParallelCalls) {
      held.active += 1;
      return { release: this.releaseOf(connectionAssetId, held), waited: false };
    }
    if (held.waiting.length >= CONNECTION_MAX_WAITING_CALLS) {
      // A Connection without a slot to give, such as one whose bound is zero, keeps no entry.
      if (held.active === 0 && held.waiting.length === 0) {
        this.byConnection.delete(connectionAssetId);
      }
      throw connectionCallError("connection_busy");
    }
    await new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", leave);
        const position = held.waiting.indexOf(waiter);
        if (position >= 0) held.waiting.splice(position, 1);
        if (held.active === 0 && held.waiting.length === 0) {
          this.byConnection.delete(connectionAssetId);
        }
        reject(connectionCallError("connection_busy"));
      };
      const waiter: Waiter = {
        grant() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", leave);
          resolve();
        }
      };
      const timer = setTimeout(leave, limits.slotWaitMs);
      signal?.addEventListener("abort", leave, { once: true });
      held.waiting.push(waiter);
    });
    // The slot was handed over by the call that ended: `active` stayed as it was.
    return { release: this.releaseOf(connectionAssetId, held), waited: true };
  }

  /** The calls of a Connection that wait for a slot now. */
  waiting(connectionAssetId: string): number {
    return this.byConnection.get(connectionAssetId)?.waiting.length ?? 0;
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

/** Host and port of a target the egress checker refused, where they may be repeated. */
function refusedTargetOf(
  details: unknown,
  secret: string | undefined
): { host: string; port: number; unresolved?: true } | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  if (!("host" in details && "port" in details)) return undefined;
  const { host, port } = details;
  if (
    typeof host !== "string" ||
    !HOST_PATTERN.test(host) ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    namesSecret(`${host}:${port}`, secret)
  ) {
    return undefined;
  }
  const unresolved = "reason" in details && details.reason === EGRESS_UNRESOLVED;
  return unresolved ? { host, port, unresolved } : { host, port };
}

/**
 * The error a failed call leaves with. Only a reason passes: the sentence is this module's
 * own, so no text an outside system sent and no text a Connector type composed reaches a run,
 * an audit row, a log or a caller. A refused target keeps its host and port, which the egress
 * checker names, unless they hold the credential of the call: a Connector type may have asked
 * for a target it built from the secret. Any other error becomes an internal failure that
 * says nothing.
 */
function safeCallError(
  error: unknown,
  reason: ConnectionCallReason | undefined,
  secret: string | undefined
): AppError {
  if (reason === undefined) {
    return new AppError("INTERNAL", "The connector failed");
  }
  const target = isAppError(error) ? refusedTargetOf(error.details, secret) : undefined;
  if (reason === "egress_denied" && target) {
    return new AppError(
      "FORBIDDEN",
      `${reason}: ${target.host}:${target.port} is not allowed by the instance's egress list`,
      { reason, ...target }
    );
  }
  // The checker's own reason for a listed host without an address. The list is not the cause.
  if (reason === "connection_unavailable" && target?.unresolved === true) {
    return new AppError(
      CONNECTION_CALL_REASONS[reason],
      `${reason}: the host ${target.host}:${target.port} did not resolve to an address`,
      { reason, cause: EGRESS_UNRESOLVED, host: target.host, port: target.port },
      { exposeMessage: true }
    );
  }
  return connectionCallError(reason);
}

/** The health a failed call leaves behind, for the reasons that say the Connection is broken. */
const HEALTH_OF_FAILURE: Partial<Record<ConnectionCallReason, ConnectionHealth>> = {
  upstream_unauthorized: "failed",
  connection_unavailable: "failed",
  secret_unreadable: "secret_unreadable"
};

/**
 * Writes what a failed call says about the Connection. A row that says it already is left
 * alone, so an outage costs one write and not one per call. A write that fails, or one that
 * is not answered within `CONNECTION_HEALTH_WRITE_TIMEOUT_MS`, changes nothing about how the
 * call ends.
 */
async function recordFailedHealth(
  deps: ConnectionOperationSourceDeps,
  connection: StoredConnection,
  reason: ConnectionCallReason | undefined
): Promise<void> {
  const health = reason === undefined ? undefined : HEALTH_OF_FAILURE[reason];
  if (health === undefined || reason === undefined) return;
  if (connection.state?.health === health && connection.state.lastErrorCode === reason) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const writing = deps.stores.connections.putConnectionState({
      clientInstanceId: deps.clientInstanceId,
      connectionAssetId: connection.assetId,
      health,
      lastErrorCode: reason
    });
    // The write may still fail after nobody waits for it.
    writing.catch(() => undefined);
    await Promise.race([
      writing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The write took too long")),
          CONNECTION_HEALTH_WRITE_TIMEOUT_MS
        );
      })
    ]);
  } catch {
    deps.logger.warn(
      { connection: connection.config.name, reason },
      "The health of a Connection could not be written after a failed call"
    );
  } finally {
    clearTimeout(timer);
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
 * or several times over, in base64 of either alphabet, in hex or percent-encoded. A discovery
 * searches what it was answered with it too.
 */
export function holdsSecret(serialized: string, secret: string): boolean {
  if (secret.length < CONNECTION_SECRET_ECHO_MIN_CHARS) return false;
  // JSON inside a string of the result escapes a quote or a backslash of the secret again.
  const bare = unescaped(secret);
  if (bare.length >= CONNECTION_SECRET_ECHO_MIN_CHARS && unescaped(serialized).includes(bare)) {
    return true;
  }
  return encodedForms(secret).some((form) => serialized.includes(form));
}

/** The credential as it is and in the encodings a result or a host may carry it in. */
function encodedForms(secret: string): string[] {
  const hex = Buffer.from(secret, "utf8").toString("hex");
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    hex,
    hex.toUpperCase(),
    encodeURIComponent(secret),
    ...base64Forms(secret)
  ];
}

/**
 * Whether a host and port hold the credential. A host is written in lower case by whoever
 * checks it, so the search does not depend on case, in any encoding.
 */
function namesSecret(target: string, secret: string | undefined): boolean {
  if (secret === undefined || secret.length < CONNECTION_SECRET_ECHO_MIN_CHARS) return false;
  const lowered = target.toLowerCase();
  return (
    holdsSecret(target, secret) ||
    encodedForms(secret).some((form) => lowered.includes(form.toLowerCase()))
  );
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

/** What a call found when it read its Connection. */
interface Callable {
  connection: StoredConnection;
  type: ConnectorTypeDefinition;
  descriptor: ConnectorOperationDescriptor;
}

/**
 * A check by a schema an outside system wrote, in a worker thread. One that gives no answer
 * is logged by the names of the Connection and the operation, never with what was checked,
 * and leaves with its reason: `schema_check_timeout` or `schema_check_unavailable`.
 */
async function outsideCheck<Answer>(
  deps: ConnectionOperationSourceDeps,
  found: Callable,
  checked: "input" | "output",
  check: () => Promise<Answer>
): Promise<Answer> {
  try {
    return await check();
  } catch (error) {
    deps.logger.warn(
      {
        connection: found.connection.config.name,
        operation: found.descriptor.name,
        checked,
        reason: connectionCallReasonOf(error)
      },
      "A check by the schema of a Connection operation gave no answer"
    );
    throw error;
  }
}

/**
 * Refuses an input that does not fit the operation's schema. For an operation an outside
 * system described, the output schema is compiled here too, before anything is sent: a call
 * whose answer could not be checked is not made.
 */
async function checkInput(
  deps: ConnectionOperationSourceDeps,
  found: Callable,
  input: unknown
): Promise<void> {
  const { descriptor, type } = found;
  if (!describedByOutsideSystem(type)) {
    const compiled = compileJsonSchema(descriptor.inputSchema);
    if (!compiled.ok || compiled.validate(input).length > 0) {
      throw connectionCallError("input_invalid");
    }
    return;
  }
  const serialized = jsonOfCheckedValue(input);
  if (serialized === undefined) throw connectionCallError("input_invalid");
  const checker = deps.schemaChecker ?? outsideSchemaChecker();
  const { outputSchema } = descriptor;
  const issues = await outsideCheck(deps, found, "input", async () => {
    const fits = await checker.check(descriptor.inputSchema, serialized);
    if (fits === "uncompilable") return fits;
    if (outputSchema !== undefined && (await checker.check(outputSchema)) === "uncompilable") {
      return "uncompilable";
    }
    return fits;
  });
  // A stored schema no thread compiles is no operation, as one the catalog never took.
  if (issues === "uncompilable") throw connectionCallError("operation_unknown");
  if (issues.length > 0) throw connectionCallError("input_invalid");
}

/** Refuses a result that does not fit the operation's output schema. */
async function checkOutput(
  deps: ConnectionOperationSourceDeps,
  found: Callable,
  result: JsonValue,
  serialized: string
): Promise<void> {
  const { outputSchema } = found.descriptor;
  if (outputSchema === undefined) return;
  if (!describedByOutsideSystem(found.type)) {
    const compiled = compileJsonSchema(outputSchema);
    if (!compiled.ok || compiled.validate(result).length > 0) {
      throw connectionCallError("output_invalid");
    }
    return;
  }
  const checker = deps.schemaChecker ?? outsideSchemaChecker();
  const issues = await outsideCheck(deps, found, "output", () =>
    checker.check(outputSchema, serialized)
  );
  if (issues === "uncompilable" || issues.length > 0) throw connectionCallError("output_invalid");
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
): Callable {
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
  const { status, descriptor, schemaRefusal } = connectionOperationStatus({
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
      throw connectionCallError("operation_unknown");
    case "unknown":
      // A stored schema over a bound is said by the bound, not as an operation that is gone.
      throw connectionCallError(schemaRefusal ?? "operation_unknown");
    case "ready":
      if (!descriptor) throw connectionCallError("operation_unknown");
      return { connection, type: connection.type, descriptor };
  }
}

/** What a sentence says of the Connection and the operation a call was authorized on. */
interface Named {
  displayName?: string;
  /** The effect of the operation, which decides whether a call that timed out is repeated. */
  effect?: ConnectionOperationEffect;
}

/**
 * The error as the caller reads it: the sentence of its reason, which names the Connection by
 * its display name, and the reason as `details.reason`. The host and the port of a refused
 * target stay in the details, where `safeCallError` put them, and never enter the sentence.
 * An error without a reason leaves as it is.
 */
function inSentence(error: unknown, named: Named): unknown {
  const reason = connectionCallReasonOf(error);
  if (reason === undefined || !isAppError(error)) return error;
  const details: unknown = error.details;
  const refused =
    typeof details === "object" && details !== null && "host" in details && "port" in details
      ? details
      : undefined;
  // A listed host without an address keeps its cause beside the reason it is told as.
  const unresolved =
    typeof details === "object" &&
    details !== null &&
    "cause" in details &&
    details.cause === EGRESS_UNRESOLVED;
  return connectionCallFailure(
    reason,
    named.displayName,
    {
      ...(typeof refused?.host === "string" && typeof refused.port === "number"
        ? { host: refused.host, port: refused.port }
        : {}),
      ...(unresolved ? { cause: EGRESS_UNRESOLVED } : {})
    },
    named.effect
  );
}

/**
 * Executes one call. The caller is `runOperation`, which has authorized the actor on the
 * Connection, resolved the policy and written the run. Answers the result of the Connector
 * type once it passed the size bound, the search for the credential and the output schema.
 * A call that fails for a reason ends with the sentence of that reason.
 */
export async function callConnectionOperation(
  deps: ConnectionOperationSourceDeps,
  slots: ConnectionCallSlots,
  target: ConnectionCallTarget,
  input: unknown,
  context: Pick<OperationExecutionContext, "runtime">
): Promise<JsonValue> {
  const named: Named = {};
  try {
    return await call(deps, slots, target, input, context, named);
  } catch (error) {
    throw inSentence(error, named);
  }
}

async function call(
  deps: ConnectionOperationSourceDeps,
  slots: ConnectionCallSlots,
  target: ConnectionCallTarget,
  input: unknown,
  context: Pick<OperationExecutionContext, "runtime">,
  /** Receives what a sentence says of the Connection the call was authorized on, once read. */
  named: Named
): Promise<JsonValue> {
  // Refused without a wait where the Connection or the input says so already.
  const read = async () => {
    const stored = await readConnection(deps, target.connectionName);
    // Only the asset and the revision the caller was authorized on lend their name to a
    // refusal. A Connection that took the same name since is not the caller's to learn of.
    if (stored?.assetId === target.assetId && stored.revision === target.revision) {
      named.displayName = stored.config.displayName;
      named.effect = stored.config.operations.find(
        (candidate) => candidate.name === target.operationName
      )?.effect;
    }
    const found = callable(stored, target);
    await checkInput(deps, found, input);
    return found;
  };
  const first = await read();
  const jsonInput = toJsonInput(input);
  const limits = connectionCallLimits(first.type);

  const { release } = await slots.acquire(first.connection.assetId, limits, context.runtime.signal);
  const deadline = callSignal(limits.callTimeoutMs, context.runtime.signal);
  const aborted = untilAborted(deadline.signal);
  try {
    // The Connection is read again now that the call has its slot, so it runs on the revision
    // and the state of that moment whether it waited or not. The read is inside the deadline
    // of the call: a store that does not answer costs the slot that long and no longer.
    const found = await current(read(), aborted.promise, deadline.signal);
    const { connection, type } = found;
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
      const executing = type.execute(target.operationName, jsonInput, connectorContext);
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
      throw safeCallError(error, reason, secret);
    }

    const serialized = serializedOrUndefined(result);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.resultMaxBytes) {
      throw connectionCallError("output_invalid");
    }
    if (secret !== undefined && holdsSecret(serialized, secret)) {
      throw connectionCallError("output_rejected");
    }
    await checkOutput(deps, found, result, serialized);
    return result;
  } finally {
    aborted.stop();
    deadline.stop();
    release();
  }
}

/**
 * The value as JSON text, or nothing where it has none: a value that is no JSON, one nested
 * too deeply for the stack, one that refers to itself. None of those is an internal error.
 */
function serializedOrUndefined(value: unknown): string | undefined {
  try {
    const serialized: string | undefined = JSON.stringify(value);
    return serialized;
  } catch {
    return undefined;
  }
}

/**
 * What the read of the Connection answers, unless the call ends first. A refusal of the read
 * leaves as it is: it says nothing about the outside system, so no health is written for it.
 */
async function current<Found>(
  reading: Promise<Found>,
  ended: Promise<never>,
  signal: AbortSignal
): Promise<Found> {
  // The read may still fail after nobody waits for it.
  reading.catch(() => undefined);
  try {
    return await Promise.race([reading, ended]);
  } catch (error) {
    throw signal.aborted ? connectionCallError("upstream_timeout") : error;
  }
}

/** The validated input as the JSON a Connector type is handed. */
function toJsonInput(input: unknown): JsonValue {
  if (input === undefined) return null;
  const serialized = serializedOrUndefined(input);
  if (serialized === undefined) throw connectionCallError("input_invalid");
  const value: JsonValue = JSON.parse(serialized);
  return value;
}
