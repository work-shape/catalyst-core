import { CONNECTION_OPERATION_STATUSES } from "@work-shape/catalyst-asset-schemas";
import {
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  EGRESS_UNRESOLVED,
  type ConnectionExposure,
  type ConnectionOperationEffect,
  type ConnectorOperationDescriptor
} from "./connections";
import { AppError, isAppError, type AppErrorCode } from "./errors";
import type { OperationOrigin } from "./operations";

// What an accepted operation of a Connection is called, who may reach it from where, what a
// discovery leaves behind, and why a call of one is refused. The Connection itself, its
// Connector type, the egress check and the credential are in `connections.ts`.

/**
 * The prefix of every operation that comes from a Connection: `connection.<name>.<operation>`.
 * It is singular. Operations that manage Connections use the plural `connections.`.
 */
export const CONNECTION_OPERATION_PREFIX = "connection.";

/** The operation name an agent, an App and a Workflow hold for one accepted operation. */
export function connectionOperationName(connection: string, operation: string): string {
  return `${CONNECTION_OPERATION_PREFIX}${connection}.${operation}`;
}

/**
 * The Connection and the operation a name stands for, or nothing where the name is not one of
 * a Connection. Neither part holds a dot, so the name splits in one way only.
 */
export function parseConnectionOperationName(
  name: string
): { connection: string; operation: string } | undefined {
  if (!name.startsWith(CONNECTION_OPERATION_PREFIX)) return undefined;
  const rest = name.slice(CONNECTION_OPERATION_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) return undefined;
  const connection = rest.slice(0, dot);
  const operation = rest.slice(dot + 1);
  if (
    connection.length > CONNECTION_NAME_MAX_LENGTH ||
    !CONNECTION_NAME_PATTERN.test(connection) ||
    operation.length > CONNECTION_OPERATION_NAME_MAX_LENGTH ||
    !CONNECTION_OPERATION_NAME_PATTERN.test(operation)
  ) {
    return undefined;
  }
  return { connection, operation };
}

/**
 * The action a refusal names when an operation is not exposed to the surface that called it:
 * `connection_exposure:<exposure>`. No grant carries it. It exists so the refusal says what
 * was asked, as `agent_tool:<name>` does for a tool an agent does not list.
 */
export const CONNECTION_EXPOSURE_ACTION_PREFIX = "connection_exposure:";

/**
 * The exposure an operation needs to be called from an origin. An agent needs `agent`, an App
 * `bridge`, a Workflow `workflow`, the CLI and an MCP client `outside`. Nothing is answered for
 * an origin no exposure admits, which is refused: a person in the browser outside an App and a
 * schedule reach a Connection's operation only through an agent, an App or a Workflow.
 */
export function exposureOfOrigin(origin: OperationOrigin): ConnectionExposure | undefined {
  switch (origin.kind) {
    case "agent":
      return "agent";
    case "app":
      return "bridge";
    case "workflow":
      return "workflow";
    case "cli":
    case "mcp":
      return "outside";
    case "user":
    case "schedule":
      return undefined;
  }
}

/**
 * The mode of a Connection's credential: `shared`, one credential for everyone who may use it,
 * or `user`, a personal connection on which each person acts with their own account (CS-9).
 */
export type ConnectionCredentialMode = "shared" | "user";

/** The only exposure a personal connection accepts: its owner's token is used in an agent run. */
const PERSONAL_CONNECTION_EXPOSURE: ConnectionExposure = "agent";

/**
 * Why a Connection of the mode may not list the exposure, or nothing where it may. A personal
 * connection accepts `agent` only, so its data never reaches an App, a Workflow or a tool
 * outside the instance.
 */
export function connectionExposureRefusal(
  credentialMode: ConnectionCredentialMode,
  exposure: ConnectionExposure
): string | undefined {
  if (credentialMode !== "user" || exposure === PERSONAL_CONNECTION_EXPOSURE) return undefined;
  return exposure === "outside"
    ? "A personal connection cannot be exposed to outside clients (CLI, MCP): it accepts only the exposure 'agent'"
    : `A personal connection accepts only the exposure 'agent', not '${exposure}'`;
}

/** One tool as the last discovery read it. Untrusted data. */
export interface ConnectionCatalogEntry extends ConnectorOperationDescriptor {
  /**
   * sha256, hex, over the canonical JSON of name, description, inputSchema, outputSchema and
   * proposedEffect.
   */
  fingerprint: string;
}

/** What `connection_state.catalog` holds. A stored value of another shape is read as none. */
export interface ConnectionCatalog {
  version: 1;
  discoveredAt: string;
  entries: ConnectionCatalogEntry[];
  /**
   * The fingerprint each accepted operation was pinned to at its first discovery, by operation
   * name. A later discovery never changes a pin.
   */
  pinned: Record<string, string>;
}

/** Whether an accepted operation can be called now, and if not, why. Only `ready` is callable. */
export type ConnectionOperationStatus =
  (typeof CONNECTION_OPERATION_STATUSES)[number];

/**
 * Why a call of a Connection is refused or fails, each with the error code it travels under.
 * The reason is the `details.reason` of the `AppError`. It is also the first word of the
 * message where the platform speaks to an administrator (a test, a discovery). The error a
 * call of an operation ends with says `CONNECTION_CALL_SENTENCES` instead.
 */
export const CONNECTION_CALL_REASONS = {
  /** The Connection is disabled, cannot be reached, or its secret cannot be read. */
  connection_unavailable: "CONFLICT",
  connection_not_configured: "CONFLICT",
  secret_unreadable: "CONFLICT",
  operation_unknown: "NOT_FOUND",
  operation_disabled: "CONFLICT",
  operation_needs_review: "CONFLICT",
  egress_denied: "FORBIDDEN",
  input_invalid: "VALIDATION_FAILED",
  /** The result is larger than the type allows or does not fit the output schema. */
  output_invalid: "CONFLICT",
  /** The result holds the credential the call injected. */
  output_rejected: "CONFLICT",
  upstream_unauthorized: "CONFLICT",
  upstream_rate_limited: "RATE_LIMITED",
  upstream_timeout: "TIMEOUT",
  /** The outside system reported a failure. Its text is not passed on. */
  upstream_error: "CONFLICT",
  /**
   * The outside system answered 409: what the call would change conflicts with what is there,
   * or with another call under the same key. The same call again is answered the same.
   */
  upstream_conflict: "CONFLICT",
  /** Every slot of the Connection stayed taken for as long as a call waits for one. */
  connection_busy: "CONFLICT",
  /**
   * Checking the input or the result by the schema the outside system gave the operation took
   * longer than a check may. The check was stopped.
   */
  schema_check_timeout: "TIMEOUT",
  /** No check by the outside system's schema could be made: none was free, or its thread ended. */
  schema_check_unavailable: "CONFLICT",
  /**
   * The stored schema of the operation is over a bound of a schema an outside system may
   * give: its size, its depth, its `$ref`, its regular expressions or the length of one. The
   * operation is not called until the outside system lists a schema within the bounds.
   */
  schema_too_large: "CONFLICT",
  schema_too_deep: "CONFLICT",
  schema_too_many_refs: "CONFLICT",
  schema_too_many_patterns: "CONFLICT",
  schema_pattern_too_long: "CONFLICT"
} as const satisfies Record<string, AppErrorCode>;

export type ConnectionCallReason = keyof typeof CONNECTION_CALL_REASONS;

/**
 * The reasons a call may fail for today and not tomorrow: the outside system was not there,
 * was busy, reported a failure of its own or did not answer in time. A changing call that
 * carried its key to the outside system and failed for one of them is made again under the
 * key. A conflict, a refused credential and everything the platform refuses itself are none.
 */
export const CONNECTION_TRANSIENT_CALL_REASONS: ReadonlySet<ConnectionCallReason> = new Set([
  "connection_unavailable",
  "connection_busy",
  "upstream_error",
  "upstream_timeout",
  "upstream_rate_limited"
]);

/** What each reason says where the caller adds nothing. No sentence holds a value of a call. */
const CONNECTION_CALL_MESSAGES: Record<ConnectionCallReason, string> = {
  connection_unavailable: "the Connection cannot be used now",
  connection_not_configured: "the Connection has no usable credential or settings",
  secret_unreadable: "the stored secret of the Connection cannot be read",
  operation_unknown: "the Connection has no such operation now",
  operation_disabled: "the operation is disabled",
  operation_needs_review: "the outside system changed the operation and the change is not accepted",
  egress_denied: "the target is not allowed by the instance's egress list",
  input_invalid: "the input does not fit the operation's schema",
  output_invalid: "the result is too large or does not fit the operation's schema",
  output_rejected: "the result holds the Connection's credential and was discarded",
  upstream_unauthorized: "the outside system refused the Connection's credential",
  upstream_rate_limited: "the outside system limits the rate of calls",
  upstream_timeout: "the outside system did not answer in time",
  upstream_error: "the outside system reported a failure",
  upstream_conflict: "the outside system answered 409 Conflict",
  connection_busy: "too many calls of the Connection are running",
  schema_check_timeout: "the check against the operation's schema took too long and was stopped",
  schema_check_unavailable: "the check against the operation's schema could not be made now",
  schema_too_large: "the operation's schema is larger than the platform takes",
  schema_too_deep: "the operation's schema is nested deeper than the platform takes",
  schema_too_many_refs: "the operation's schema holds more references than the platform takes",
  schema_too_many_patterns:
    "the operation's schema holds more regular expressions than the platform takes",
  schema_pattern_too_long:
    "a regular expression of the operation's schema is longer than the platform takes"
};

/**
 * The error of a refused or failed Connection call. It carries the reason and nothing else:
 * no upstream body, no address, no header and no setting. `message` is a sentence of the
 * platform's own code, never text an outside system sent.
 */
export function connectionCallError(reason: ConnectionCallReason, message?: string): AppError {
  return new AppError(
    CONNECTION_CALL_REASONS[reason],
    `${reason}: ${message ?? CONNECTION_CALL_MESSAGES[reason]}`,
    { reason }
  );
}

function isConnectionCallReason(value: unknown): value is ConnectionCallReason {
  return typeof value === "string" && Object.hasOwn(CONNECTION_CALL_REASONS, value);
}

/** Where an administrator looks after a Connection, as the sentences name it. */
const WHERE = "Studio > Connections";

/** Where an administrator gives a right, as the sentence of a missing right names it. */
const WHERE_RIGHTS = "Settings > Instance > Access";

/** The longest display name a sentence repeats. A longer one is cut. */
export const CONNECTION_NAME_IN_SENTENCE_MAX_LENGTH = 80;

/**
 * What a failed call of a Connection operation tells the caller, one entry per reason. The
 * reader is an agent's model that words the answer for a person, or the person. Each entry
 * says what happened, whether trying again makes sense and who can act. `c` is the Connection
 * by its display name ("the connection Sample business"). `effect` is the effect of the
 * operation where the call knows it. No entry holds a host, a port, a reason code, the value
 * of a credential or text an outside system sent.
 */
/**
 * The sentence of an operation whose stored description is over a limit. The limits are those
 * of `connections/src/json-schema.ts`; a test holds the two together.
 */
const overLimit =
  (limit: string) =>
  (c: string): string =>
    `This action of ${c} cannot be used because its description is over a limit of the platform: ${limit}. Trying again will not help until the outside system describes the action within the limit. An administrator can check the action under ${WHERE}.`;

const CONNECTION_CALL_SENTENCES: Record<
  ConnectionCallReason,
  (c: string, effect: ConnectionOperationEffect | undefined) => string
> = {
  connection_unavailable: (c) =>
    `${c} cannot be used right now. Trying again later may work. If it keeps failing, an administrator can check it under ${WHERE}.`,
  connection_not_configured: (c) =>
    `${c} is not set up completely, so it cannot be used. Trying again will not help. An administrator can see what is missing under ${WHERE}.`,
  secret_unreadable: (c) =>
    `${c} cannot be used because its stored credential cannot be read. Trying again will not help. An administrator can see what to do under ${WHERE}.`,
  operation_unknown: (c) =>
    `${c} does not offer this action at the moment. Trying again will not help. An administrator can check the actions of the connection under ${WHERE}.`,
  operation_disabled: (c) =>
    `This action of ${c} is switched off. Trying again will not help. An administrator can check it under ${WHERE}.`,
  operation_needs_review: (c) =>
    `This action of ${c} changed in the outside system and waits for a review. Trying again will not help until an administrator has accepted the change. The details are under ${WHERE}.`,
  egress_denied: (c) =>
    `The network path from this instance to the outside system of ${c} has not been allowed yet. The connection itself is switched on. Trying again will not help until an administrator allows the path. The state is shown under ${WHERE}.`,
  input_invalid: (c) =>
    `${c} did not run this action because the input does not fit what the action expects. Correct the input and try again.`,
  output_invalid: (c) =>
    `The answer of ${c} was too large or not in the expected form and was discarded. Asking for less may work. If it keeps failing, an administrator can check it under ${WHERE}.`,
  output_rejected: (c) =>
    `The answer of ${c} was discarded because it contained the connection's credential. Trying again will not help. An administrator can check it under ${WHERE}.`,
  upstream_unauthorized: (c) =>
    `The outside system refused the credential of ${c}. Trying again will not help. An administrator can see what to do under ${WHERE}.`,
  upstream_rate_limited: (c) =>
    `The outside system behind ${c} accepts no more calls for the moment. Wait a little before trying again.`,
  // Only a call known to read is safe to repeat. Any other may have changed something.
  upstream_timeout: (c, effect) =>
    effect === "reading"
      ? `${c} did not answer in time. This action only reads, so trying again is safe. If it keeps failing, an administrator can check it under ${WHERE}.`
      : `${c} did not answer in time. If the action changes something, it is not known whether the change happened, so check before trying again. If it keeps failing, an administrator can check it under ${WHERE}.`,
  upstream_error: (c) =>
    `The outside system behind ${c} reported an error. Trying again later may work. If it keeps failing, an administrator can check it under ${WHERE}.`,
  upstream_conflict: (c) =>
    `The outside system behind ${c} refused the call with a conflict (HTTP 409): what it would change does not fit what is there. Trying again will not help.`,
  connection_busy: (c) => `Too many calls of ${c} are waiting right now. Try again in a moment.`,
  // The check of the input stops a call before it is sent, the check of the answer after.
  schema_check_timeout: (c, effect) =>
    effect === "reading"
      ? `Checking this action of ${c} against its description took too long, so the call was stopped. Trying again will not help for now. An administrator can check the action under ${WHERE}.`
      : `Checking this action of ${c} against its description took too long, so the call was stopped. If the action changes something, the change may have happened, so check before trying again. An administrator can check the action under ${WHERE}.`,
  schema_check_unavailable: (c, effect) =>
    effect === "reading"
      ? `This action of ${c} could not be checked against its description right now. Try again in a moment.`
      : `This action of ${c} could not be checked against its description right now. If the action changes something, the change may have happened, so check before trying again.`,
  schema_too_large: overLimit("it may take at most 256 KiB and 20,000 parts"),
  schema_too_deep: overLimit("it may be nested at most 64 levels deep"),
  schema_too_many_refs: overLimit("it may hold at most 200 references"),
  schema_too_many_patterns: overLimit("it may hold at most 100 text patterns"),
  schema_pattern_too_long: overLimit("a text pattern may have at most 1,000 characters")
};

/** The display name as one word group of a sentence: one line, no control character, bounded. */
function nameInSentence(displayName: string | undefined): string | undefined {
  const plain = (displayName ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim()
    .slice(0, CONNECTION_NAME_IN_SENTENCE_MAX_LENGTH)
    .trim();
  return plain === "" ? undefined : plain;
}

/** The Connection as a sentence names it. A caller that may not learn its name reads none. */
function connectionInSentence(displayName: string | undefined): string {
  const name = nameInSentence(displayName);
  return name === undefined ? "this connection" : `the connection ${name}`;
}

/**
 * The sentence of a reason for the Connection of that display name. A call that found no
 * Connection names none, and a call that does not know its effect is told as a changing one.
 */
export function connectionCallSentence(
  reason: ConnectionCallReason,
  displayName: string | undefined,
  effect?: ConnectionOperationEffect
): string {
  const sentence = CONNECTION_CALL_SENTENCES[reason](connectionInSentence(displayName), effect);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/**
 * What a caller without the right `connection.use` is told. It is a refusal and reads as
 * one: nothing is broken and nothing is switched off, so no word of an outage is in it. The
 * right and the action stay in the denial beside this text.
 */
export function connectionUseDeniedSentence(displayName: string | undefined): string {
  return `The person making this request does not hold the right to use ${connectionInSentence(displayName)}. Nothing is wrong with the connection, and trying again will not help. An administrator can give the right under ${WHERE_RIGHTS}.`;
}

/**
 * The error a call of a Connection operation ends with: the code of the reason, the sentence
 * as its message and the reason as `details.reason`. The message reaches the caller whatever
 * the status, since it is the platform's own.
 */
export function connectionCallFailure(
  reason: ConnectionCallReason,
  displayName: string | undefined,
  details: Record<string, string | number> = {},
  effect?: ConnectionOperationEffect
): AppError {
  return new AppError(
    CONNECTION_CALL_REASONS[reason],
    connectionCallSentence(reason, displayName, effect),
    { ...details, reason },
    { exposeMessage: true }
  );
}

/**
 * The reason an error of a Connection call carries, or nothing for any other error. A listed
 * target that did not resolve (`egress_unresolved`) is `connection_unavailable` to a caller,
 * as a target is that resolves and does not answer.
 */
export function connectionCallReasonOf(error: unknown): ConnectionCallReason | undefined {
  if (!isAppError(error)) return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) return undefined;
  if (details.reason === EGRESS_UNRESOLVED) return "connection_unavailable";
  return isConnectionCallReason(details.reason) ? details.reason : undefined;
}
