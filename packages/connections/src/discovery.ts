import {
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  CREDENTIAL_REFUSALS,
  checkStorableTexts,
  connectionCallError,
  connectionCallReasonOf,
  isStorableText,
  type ClientInstanceId,
  type ConnectionCallReason,
  type ConnectionCatalog,
  type ConnectionCredentialResolver,
  type ConnectionHealth,
  type ConnectorOperationDescriptor,
  type ConnectorTypeRegistry,
  type EgressChecker,
  type JsonObject,
  type JsonValue,
  type Logger,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { holdsSecret } from "./call";
import { buildConnectionCatalog } from "./catalog";
import { readConnection, type StoredConnection } from "./connection-reads";
import { NO_CREDENTIALS, openConnectorContext } from "./connector-context";
import {
  outsideSchemaChecker,
  type OutsideSchemaChecker,
  type OutsideSchemaRefusal
} from "./schema-check";

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
 * The largest answer one discovery takes, in the bytes of the JSON its operations are stored
 * as, counted over every listed operation before any schema is compiled. It bounds the `catalog` value
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

/**
 * The error code a discovery leaves that stored its catalog and left out an operation whose
 * name, description or schema held the Connection's credential. It is the reason of a call
 * whose result holds it. Nothing of the operation is recorded with it.
 */
export const CONNECTION_DISCOVERY_REJECTED_CODE = "output_rejected" satisfies ConnectionCallReason;

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
  /** How many of those were left out because they held the credential. Only with `discovered`. */
  rejectedCount?: number;
  /**
   * How many of those were left out because a schema of theirs was refused: over a bound of
   * size, depth, `$ref` or pattern count, not compilable, or not compiled within the deadline
   * of a check. Only with `discovered`.
   */
  schemaRefusedCount?: number;
  /** Why the first of those was refused. Only where `schemaRefusedCount` is over zero. */
  schemaRefusal?: OutsideSchemaRefusal;
  /**
   * With `skipped`: the Connection changed while it was discovered. What was read belongs to
   * a revision that is no longer the Connection's, so nothing was written. The caller sees to
   * a discovery of the revision that is.
   */
  superseded?: true;
  /**
   * With `failed`: the caller stopped the discovery. Nothing was found out about the
   * Connection and nothing was written.
   */
  stopped?: true;
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
  /**
   * What every write of the discovery goes through. A job hands in the transaction of its
   * attempt, which refuses once the attempt lost its lease, so a discovery that was taken
   * over writes nothing over what the newer attempt stored. Left out, a transaction of
   * `stores`.
   */
  transaction?<Result>(write: (stores: PlatformStores) => Promise<Result>): Promise<Result>;
  logger?: Logger;
  /** Instead of the checker of the process (`outsideSchemaChecker`). */
  schemaChecker?: OutsideSchemaChecker;
  now?: () => Date;
  /** Instead of `CONNECTION_DISCOVERY_TIMEOUT_MS`. For tests. */
  timeoutMs?: number;
}

/**
 * Why a listed schema is not taken, or nothing. It is measured against the bounds of a schema
 * of an outside system first and compiled only then, in a worker thread with a deadline. A
 * schema whose text cannot be stored is refused as one that does not compile.
 */
async function schemaRefusalOf(
  schema: JsonObject,
  checker: OutsideSchemaChecker,
  deadline: DiscoveryDeadline
): Promise<OutsideSchemaRefusal | undefined> {
  const checking = checker.refusalOf(schema);
  checking.catch(() => undefined);
  const refusal = await Promise.race([checking, deadline.passed]);
  if (refusal) return refusal;
  // The validator measured the schema, so the walk is within its bounds of depth and nodes.
  return checkStorableTexts(schema, Number.POSITIVE_INFINITY) === "storable"
    ? undefined
    : "schema_uncompilable";
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

/** The bytes of a text or key as JSON writes it, or more than `room` where it is longer. */
function jsonTextBytes(text: string, room: number): number {
  // Every character is at least a byte, so a text longer than the room is never serialized.
  return text.length > room ? room + 1 : Buffer.byteLength(JSON.stringify(text), "utf8");
}

/**
 * The bytes of a value as `JSON.stringify` writes it, counted until they pass `budget`:
 * escapes, numbers, commas and colons included, so it is the size of what is stored. It walks
 * without recursion and stops at the budget, so it costs no more than the budget allows
 * whatever it is handed, and a value nested too deeply to serialize is measured like any
 * other. Past the budget the count only says so.
 */
function jsonBytesWithin(value: JsonValue, budget: number): number {
  let bytes = 0;
  const pending: JsonValue[] = [value];
  while (pending.length > 0 && bytes <= budget) {
    const next = pending.pop();
    if (next === undefined) {
      // A hole in a list, which JSON writes as `null`.
      bytes += 4;
    } else if (typeof next === "string") {
      bytes += jsonTextBytes(next, budget - bytes);
    } else if (typeof next !== "object" || next === null) {
      bytes += JSON.stringify(next).length;
    } else if (Array.isArray(next)) {
      // The brackets and the commas. A list longer than the room is over without a walk.
      bytes += next.length > budget - bytes ? budget + 1 : 2 + Math.max(0, next.length - 1);
      if (bytes > budget) break;
      for (const child of next) pending.push(child);
    } else {
      bytes += 2;
      let members = 0;
      for (const key in next) {
        if (!Object.hasOwn(next, key)) continue;
        const child = next[key];
        if (child === undefined) continue;
        members += 1;
        // The key, its colon, and the comma before every member but the first.
        bytes += jsonTextBytes(key, budget - bytes) + (members > 1 ? 2 : 1);
        if (bytes > budget) break;
        pending.push(child);
      }
    }
  }
  return bytes;
}

/** A listed operation as the catalog would hold it: its fields, and the description cut. */
function asStored(descriptor: ConnectorOperationDescriptor): ConnectorOperationDescriptor {
  const { name, inputSchema, outputSchema, proposedEffect } = descriptor;
  return {
    name,
    description: boundedDescription(descriptor.description),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    proposedEffect
  };
}

/**
 * The operations of an answer that the catalog takes. The order is fixed. First the count.
 * Then the size of the whole answer: every listed operation as it would be stored, in the
 * bytes of its JSON. Only after that is the first schema handed to the validator, which bounds
 * and compiles it. So nothing is compiled or fingerprinted of an answer that is over a bound,
 * an answer over the bound of count or of bytes throws `output_invalid` whatever its schemas
 * are and however long they would take, and what is stored of an answer is never more than
 * the bound. An operation whose name
 * cannot end an operation name, whose text cannot be stored or whose schema the validator
 * refuses is left out and the others stay. So is one that holds the Connection's credential,
 * by the search a call makes of its result: it would be stored in the clear and sent to a
 * model.
 *
 * No schema is compiled where requests are served: each is handed to a worker thread, which is
 * stopped where compiling one passes the deadline of a check, and that operation is left out
 * as `schema_check_timeout`. The deadline of the discovery and the caller's signal are asked
 * before each operation, so a discovery that was stopped ends at the next one. A discovery no
 * thread could check for fails with `schema_check_unavailable` and the stored catalog stays.
 *
 * This bounds what is processed and stored. The answer is in memory when it arrives here:
 * bounding what is received from the outside system is the Connector type's transport.
 */
async function boundedOperations(
  discovered: readonly ConnectorOperationDescriptor[],
  secret: string | undefined,
  deadline: DiscoveryDeadline,
  checker: OutsideSchemaChecker
): Promise<{
  operations: ConnectorOperationDescriptor[];
  leftOut: number;
  rejected: number;
  schemaRefused: number;
  schemaRefusal: OutsideSchemaRefusal | undefined;
}> {
  if (discovered.length > CONNECTION_DISCOVERY_MAX_OPERATIONS) {
    throw connectionCallError("output_invalid");
  }
  const listed: ConnectorOperationDescriptor[] = [];
  // The brackets of the list and the commas between its operations.
  let bytes = 2 + Math.max(0, discovered.length - 1);
  for (const descriptor of discovered) {
    deadline.check();
    const stored = asStored(descriptor);
    bytes += jsonBytesWithin({ ...stored }, CONNECTION_DISCOVERY_MAX_BYTES - bytes);
    if (bytes > CONNECTION_DISCOVERY_MAX_BYTES) throw connectionCallError("output_invalid");
    listed.push(stored);
  }
  const operations: ConnectorOperationDescriptor[] = [];
  const names = new Set<string>();
  let rejected = 0;
  let schemaRefused = 0;
  let schemaRefusal: OutsideSchemaRefusal | undefined;
  for (const operation of listed) {
    deadline.check();
    const { name, description, inputSchema, outputSchema } = operation;
    if (
      name.length > CONNECTION_OPERATION_NAME_MAX_LENGTH ||
      !CONNECTION_OPERATION_NAME_PATTERN.test(name) ||
      names.has(name) ||
      !isStorableText(description)
    ) {
      continue;
    }
    const refusal =
      (await schemaRefusalOf(inputSchema, checker, deadline)) ??
      (outputSchema === undefined
        ? undefined
        : await schemaRefusalOf(outputSchema, checker, deadline));
    if (refusal) {
      schemaRefused += 1;
      schemaRefusal ??= refusal;
      continue;
    }
    // Both schemas are within the validator's bounds, so this serializes without surprise.
    if (secret !== undefined && holdsSecret(JSON.stringify(operation), secret)) {
      rejected += 1;
      continue;
    }
    names.add(name);
    operations.push(operation);
  }
  return {
    operations,
    leftOut: discovered.length - operations.length,
    rejected,
    schemaRefused,
    schemaRefusal
  };
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
    case CREDENTIAL_REFUSALS.notConnected:
      return "needs_configuration";
    case "upstream_unauthorized":
    case "connection_unavailable":
    case CREDENTIAL_REFUSALS.needsReconnect:
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
): Promise<{ discovered: readonly ConnectorOperationDescriptor[]; secret: string | undefined }> {
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
  return {
    discovered: await Promise.race([discovering, deadline.passed]),
    secret: context.credentialFor(context.target)?.secret
  };
}

/**
 * Discovers one Connection and stores what was read as its catalog. A Connection that does
 * not exist, is off, or whose type has a static catalog or is not part of this build is
 * `skipped` and nothing is contacted. A failure writes its reason as `last_error_code` and
 * leaves the stored catalog as it is, so nothing that was accepted changes. The Connection is
 * read once, and before a write its revision is read again and held for the write: where it
 * changed meanwhile, nothing is written and the answer says `superseded`. A discovery its
 * caller stopped writes nothing at all. Never throws for anything the type or the outside
 * system did.
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
  const write = <Result>(fn: (tx: PlatformStores) => Promise<Result>): Promise<Result> =>
    input.transaction ? input.transaction(fn) : stores.transaction(fn);
  // One deadline for the whole discovery: the wait for the answer, and bounding, compiling
  // and fingerprinting it.
  const deadline = openDeadline(input.signal, input.timeoutMs ?? CONNECTION_DISCOVERY_TIMEOUT_MS);
  let found:
    | {
        catalog: ConnectionCatalog;
        leftOut: number;
        rejected: number;
        schemaRefused: number;
        schemaRefusal: OutsideSchemaRefusal | undefined;
      }
    | undefined;
  let reason: ConnectionCallReason | undefined;
  try {
    const answer = await discoverOperations(input, connection, discover, type, deadline);
    const { operations, ...counts } = await boundedOperations(
      answer.discovered,
      answer.secret,
      deadline,
      input.schemaChecker ?? outsideSchemaChecker()
    );
    const catalog = buildConnectionCatalog({
      discovered: operations,
      accepted: connection.config.operations,
      previous: connection.catalog,
      now: (input.now?.() ?? new Date()).toISOString()
    });
    deadline.check();
    found = { catalog, ...counts };
  } catch (error) {
    // Only the reason is read. The text of the error is the type's or the outside system's.
    reason = connectionCallReasonOf(error);
  } finally {
    deadline.close();
  }
  // A discovery its caller stopped says nothing about the Connection: no failure is written.
  if (input.signal.aborted) return { status: "failed", stopped: true };

  /**
   * Writes the state where the Connection still is the revision that was discovered. The
   * target, the credential and the accepted list are the revision's: what was read under
   * another one is not this Connection's catalog, and its failure not this Connection's.
   */
  const writeState = (
    state: Pick<
      Parameters<PlatformStores["connections"]["putConnectionState"]>[0],
      "health" | "lastErrorCode" | "catalog"
    >
  ): Promise<boolean> =>
    write(async (tx) => {
      // Held at this revision until the write is committed: an edit of the Connection waits,
      // so it comes after this discovery and not between the check and the write.
      const current = await readConnection({ ...input, stores: tx }, connectionName, {
        held: true
      });
      if (current?.assetId !== connection.assetId || current.revision !== connection.revision) {
        return false;
      }
      await tx.connections.putConnectionState({
        clientInstanceId,
        connectionAssetId: connection.assetId,
        ...state
      });
      return true;
    });

  // An error of a write is the store's or the job's and leaves as it is.
  if (!found) {
    const written = await writeState({
      health: healthOfFailure(reason, connection.state?.health),
      lastErrorCode: reason ?? CONNECTION_DISCOVERY_FAILED_CODE
    });
    if (!written) return { status: "skipped", superseded: true };
    return { status: "failed", ...(reason === undefined ? {} : { reason }) };
  }
  const { catalog, leftOut, rejected, schemaRefused, schemaRefusal } = found;
  // A discovery that listed its tools reached the system with the credential. The code names
  // why an operation was left out: for the credential first, else for its schema.
  const written = await writeState({
    health: "ok",
    lastErrorCode: rejected > 0 ? CONNECTION_DISCOVERY_REJECTED_CODE : (schemaRefusal ?? null),
    catalog: {
      version: catalog.version,
      discoveredAt: catalog.discoveredAt,
      entries: catalog.entries.map((entry) => ({ ...entry })),
      pinned: catalog.pinned
    }
  });
  if (!written) return { status: "skipped", superseded: true };
  if (leftOut > 0) {
    input.logger?.warn(
      { connection: connectionName, leftOut, rejected, schemaRefused, schemaRefusal },
      "A discovery listed operations that the catalog does not take"
    );
  }
  return {
    status: "discovered",
    operationCount: catalog.entries.length,
    leftOutCount: leftOut,
    ...(rejected > 0 ? { rejectedCount: rejected } : {}),
    ...(schemaRefusal === undefined ? {} : { schemaRefusedCount: schemaRefused, schemaRefusal })
  };
}
