import {
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  CREDENTIAL_REFUSALS,
  connectionCallError,
  connectionCallReasonOf,
  type ClientInstanceId,
  type ConnectionCallReason,
  type ConnectionCredentialResolver,
  type ConnectionHealth,
  type ConnectorOperationDescriptor,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type JsonObject,
  type JsonValue,
  type Logger,
  type PlatformStores
} from "@vivd-catalyst/core";
import { buildConnectionCatalog } from "./catalog";
import { readConnection, type StoredConnection } from "./connection-reads";
import { openConnectorContext } from "./connector-context";
import { compileJsonSchema } from "./json-schema";

// One discovery of one Connection: ask the Connector type what the outside system offers,
// bound the answer, and store it as the Connection's catalog. The answer is data of a system
// this instance does not operate. Nothing in it makes an operation callable: that is decided
// by the accepted list and its fingerprint in `catalog.ts`, which this file only calls.

/**
 * How long one discovery may take: opening the context, the type's answer, and bounding,
 * compiling and fingerprinting what was answered. A type bounds its own listing below this.
 * After it the discovery fails with `upstream_timeout` and the stored catalog stays.
 */
export const CONNECTION_DISCOVERY_TIMEOUT_MS = 60_000;

/**
 * How many operations one discovery may list. An answer with more fails the discovery with
 * `output_invalid` and the stored catalog stays: a cut list would make accepted operations
 * `unknown` by where the cut fell.
 */
export const CONNECTION_DISCOVERY_MAX_OPERATIONS = 500;

/**
 * The largest answer one discovery takes, in bytes of the JSON of its operations, counted
 * over every listed operation before any schema is compiled. It bounds the `catalog` value
 * of one `connection_state` row, which every read of an agent's Connection tools loads: the
 * row adds a fingerprint of 64 characters per operation and one per pin, at most 64 KiB more.
 * An answer over it fails the discovery with `output_invalid`.
 */
export const CONNECTION_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long a description is at most as the catalog holds it. A longer one is cut here, before
 * it is fingerprinted, so what is pinned is what is stored and what a model reads.
 */
export const CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS = 4_000;

/** The error code a discovery leaves that failed for no reason of a Connection call. */
export const CONNECTION_DISCOVERY_FAILED_CODE = "discovery_failed";

export interface ConnectionDiscoveryResult {
  status: "discovered" | "skipped" | "failed";
  /** Why it failed, where the failure carries a reason of a Connection call. */
  reason?: ConnectionCallReason;
  /** How many operations the stored catalog lists. Only with `discovered`. */
  operationCount?: number;
  /** How many listed operations were left out of the catalog. Only with `discovered`. */
  leftOutCount?: number;
}

export interface DiscoverConnectionInput {
  clientInstanceId: ClientInstanceId;
  connectionName: string;
  stores: PlatformStores;
  connectorTypes: ConnectorTypeRegistry;
  egress: EgressChecker;
  /** Missing while release config names no Connection: no credential can be resolved then. */
  credentials: ConnectionCredentialResolver | undefined;
  signal: AbortSignal;
  logger?: Logger;
  now?: () => Date;
  /** Instead of `CONNECTION_DISCOVERY_TIMEOUT_MS`. For tests. */
  timeoutMs?: number;
}

/** A resolver for a process without Secret Store keys: it has no credential to hand out. */
const NO_CREDENTIALS: ConnectionCredentialResolver = {
  resolve: () => Promise.reject(connectionCallError(CREDENTIAL_REFUSALS.notConfigured))
};

/** Half of a surrogate pair. With a NUL it is text the Platform Store does not hold as JSON. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function storableText(text: string): boolean {
  return !text.includes("\u0000") && !LONE_SURROGATE.test(text);
}

/**
 * Whether every key and every text of a value can be stored. Only called for a schema the
 * validator has measured, so the walk is within its bounds of depth and node count.
 */
function storable(value: JsonValue): boolean {
  if (typeof value === "string") return storableText(value);
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every(storable);
  return Object.entries(value).every(([key, child]) => storableText(key) && storable(child));
}

/** Whether the validator can check the schema: it is within its bounds and it compiles. */
function checkable(schema: JsonObject): boolean {
  return compileJsonSchema(schema).ok && storable(schema);
}

/** The description as the catalog holds it. A cut never leaves half of a surrogate pair. */
function boundedDescription(description: string): string {
  if (description.length <= CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS) return description;
  const cut = description.slice(0, CONNECTION_DISCOVERY_DESCRIPTION_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The moment after which a discovery has taken too long, and the signal that says so. */
interface DiscoveryDeadline {
  readonly signal: AbortSignal;
  /** Rejects when the deadline passes or the caller stops the discovery. */
  readonly passed: Promise<never>;
  /**
   * Throws `upstream_timeout` once the deadline passed. It reads the clock, so work that
   * does not give the timer a turn, such as compiling schemas, is ended by it too.
   */
  check(): void;
  close(): void;
}

function openDeadline(outer: AbortSignal, timeoutMs: number): DiscoveryDeadline {
  const controller = new AbortController();
  const endsAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer.aborted) controller.abort();
  else outer.addEventListener("abort", onOuterAbort, { once: true });
  const passed = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(connectionCallError("upstream_timeout"));
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener("abort", stop, { once: true });
  });
  passed.catch(() => undefined);
  return {
    signal: controller.signal,
    passed,
    check() {
      if (controller.signal.aborted || performance.now() > endsAt) {
        throw connectionCallError("upstream_timeout");
      }
    },
    close() {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuterAbort);
      // Whatever the type still has open for this discovery is told to stop.
      controller.abort();
    }
  };
}

/**
 * The size of a value as JSON, counted until it passes `budget`: the bytes of its keys and
 * texts and at least one byte for everything else. It walks without recursion and stops at
 * the budget, so it costs no more than the budget allows whatever it is handed, and a value
 * nested too deeply to serialize is measured like any other.
 */
function jsonBytesWithin(value: JsonValue, budget: number): number {
  let bytes = 0;
  const pending: JsonValue[] = [value];
  while (pending.length > 0 && bytes <= budget) {
    const next = pending.pop();
    if (next === undefined) break;
    if (typeof next === "string") {
      bytes += Buffer.byteLength(next, "utf8") + 2;
    } else if (typeof next !== "object" || next === null) {
      bytes += 4;
    } else if (Array.isArray(next)) {
      bytes += 2;
      for (const child of next) {
        bytes += 1;
        if (bytes > budget) break;
        pending.push(child);
      }
    } else {
      bytes += 2;
      for (const key in next) {
        if (!Object.hasOwn(next, key)) continue;
        bytes += Buffer.byteLength(key, "utf8") + 4;
        if (bytes > budget) break;
        const child = next[key];
        if (child !== undefined) pending.push(child);
      }
    }
  }
  return bytes;
}

/**
 * The operations of an answer that the catalog takes. The order is fixed: first the count,
 * then the size of each operation against what is left of the bound of bytes, and only then
 * is a schema handed to the validator, which bounds and compiles it. So nothing is compiled
 * or fingerprinted of an answer that is over a bound, and an answer over the bound of count
 * or of bytes throws `output_invalid` whatever its schemas are. An operation whose name
 * cannot end an operation name, whose text cannot be stored or whose schema the validator
 * refuses is left out and the others stay. The deadline is asked before each operation.
 *
 * This bounds what is processed and stored. The answer is in memory when it arrives here:
 * bounding what is received from the outside system is the Connector type's transport.
 */
function boundedOperations(
  discovered: readonly ConnectorOperationDescriptor[],
  deadline: DiscoveryDeadline
): {
  operations: ConnectorOperationDescriptor[];
  leftOut: number;
} {
  if (discovered.length > CONNECTION_DISCOVERY_MAX_OPERATIONS) {
    throw connectionCallError("output_invalid");
  }
  const operations: ConnectorOperationDescriptor[] = [];
  const names = new Set<string>();
  let bytes = 0;
  for (const descriptor of discovered) {
    deadline.check();
    const { name, inputSchema, outputSchema, proposedEffect } = descriptor;
    const description = boundedDescription(descriptor.description);
    for (const part of [name, description, inputSchema, outputSchema]) {
      if (part === undefined) continue;
      bytes += jsonBytesWithin(part, CONNECTION_DISCOVERY_MAX_BYTES - bytes);
      if (bytes > CONNECTION_DISCOVERY_MAX_BYTES) throw connectionCallError("output_invalid");
    }
    if (
      name.length > CONNECTION_OPERATION_NAME_MAX_LENGTH ||
      !CONNECTION_OPERATION_NAME_PATTERN.test(name) ||
      names.has(name) ||
      !storableText(description) ||
      !checkable(inputSchema) ||
      (outputSchema !== undefined && !checkable(outputSchema))
    ) {
      continue;
    }
    names.add(name);
    operations.push({
      name,
      description,
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      proposedEffect
    });
  }
  return { operations, leftOut: discovered.length - operations.length };
}

/** The health a failed discovery leaves, for the reasons that say the Connection is broken. */
function healthOfFailure(
  reason: ConnectionCallReason | undefined,
  previous: ConnectionHealth | undefined
): ConnectionHealth {
  switch (reason) {
    case CREDENTIAL_REFUSALS.unreadable:
      return "secret_unreadable";
    case CREDENTIAL_REFUSALS.notConfigured:
      return "needs_configuration";
    case "upstream_unauthorized":
    case "connection_unavailable":
      return "failed";
    default:
      return previous ?? "unknown";
  }
}

/**
 * Asks the type, under the deadline and the caller's signal. A type that ignores the signal
 * does not hold the discovery open: the wait ends and its late answer is dropped. What such
 * a type still holds open or in memory after that is the type's to bound.
 */
async function discoverOperations(
  input: DiscoverConnectionInput,
  connection: StoredConnection,
  discover: NonNullable<NonNullable<StoredConnection["type"]>["discover"]>,
  type: NonNullable<StoredConnection["type"]>,
  deadline: DiscoveryDeadline
): Promise<readonly ConnectorOperationDescriptor[]> {
  // The one way to a context: settings, then egress, then the credential.
  const opening = openConnectorContext({
    type,
    connection: {
      id: connection.assetId,
      revision: connection.revision,
      config: connection.config
    },
    egress: input.egress,
    credentials: input.credentials ?? NO_CREDENTIALS,
    signal: deadline.signal
  });
  opening.catch(() => undefined);
  const context = await Promise.race([opening, deadline.passed]);
  const discovering = discover(context);
  discovering.catch(() => undefined);
  return await Promise.race([discovering, deadline.passed]);
}

/**
 * Discovers one Connection and stores what was read as its catalog. A Connection that does
 * not exist, is off, or whose type has a static catalog or is not part of this build is
 * `skipped` and nothing is contacted. A failure writes its reason as `last_error_code` and
 * leaves the stored catalog as it is, so nothing that was accepted changes. Never throws for
 * anything the type or the outside system did.
 */
export async function discoverConnection(
  input: DiscoverConnectionInput
): Promise<ConnectionDiscoveryResult> {
  const { clientInstanceId, connectionName, stores } = input;
  const connection = await readConnection(input, connectionName);
  const type = connection?.type;
  if (!connection || !type || !type.discover || !connection.config.enabled) {
    return { status: "skipped" };
  }
  const discover = type.discover.bind(type);
  // One deadline for the whole discovery: the wait for the answer, and bounding, compiling
  // and fingerprinting it.
  const deadline = openDeadline(input.signal, input.timeoutMs ?? CONNECTION_DISCOVERY_TIMEOUT_MS);
  try {
    const { operations, leftOut } = boundedOperations(
      await discoverOperations(input, connection, discover, type, deadline),
      deadline
    );
    const catalog = buildConnectionCatalog({
      discovered: operations,
      accepted: connection.config.operations,
      previous: connection.catalog,
      now: (input.now?.() ?? new Date()).toISOString()
    });
    deadline.check();
    // A discovery that listed its tools reached the system with the credential.
    await stores.connections.putConnectionState({
      clientInstanceId,
      connectionAssetId: connection.assetId,
      health: "ok",
      lastErrorCode: null,
      catalog: {
        version: catalog.version,
        discoveredAt: catalog.discoveredAt,
        entries: catalog.entries.map((entry) => ({ ...entry })),
        pinned: catalog.pinned
      }
    });
    if (leftOut > 0) {
      input.logger?.warn(
        { connection: connectionName, leftOut },
        "A discovery listed operations that the catalog does not take"
      );
    }
    return {
      status: "discovered",
      operationCount: catalog.entries.length,
      leftOutCount: leftOut
    };
  } catch (error) {
    // Only the reason is read. The text of the error is the type's or the outside system's.
    const reason = connectionCallReasonOf(error);
    await stores.connections.putConnectionState({
      clientInstanceId,
      connectionAssetId: connection.assetId,
      health: healthOfFailure(reason, connection.state?.health),
      lastErrorCode: reason ?? CONNECTION_DISCOVERY_FAILED_CODE
    });
    return { status: "failed", ...(reason === undefined ? {} : { reason }) };
  } finally {
    deadline.close();
  }
}
