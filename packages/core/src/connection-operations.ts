import {
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_NAME_PATTERN,
  CONNECTION_OPERATION_NAME_MAX_LENGTH,
  CONNECTION_OPERATION_NAME_PATTERN,
  EGRESS_UNRESOLVED,
  type ConnectionExposure,
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
 * `bridge`, a Workflow `workflow`. A person, the CLI and an MCP client need any one of them:
 * `any`. Nothing is answered for an origin no exposure admits, which is refused.
 */
export function exposureOfOrigin(origin: OperationOrigin): ConnectionExposure | "any" | undefined {
  switch (origin.kind) {
    case "agent":
      return "agent";
    case "app":
      return "bridge";
    case "workflow":
      return "workflow";
    case "user":
    case "cli":
    case "mcp":
      return "any";
    case "schedule":
      return undefined;
  }
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
  | "ready"
  /** Accepted, a discovering type, and no discovery has pinned it yet. */
  | "awaiting_discovery"
  /** The catalog's fingerprint differs from the accepted one. */
  | "needs_review"
  /** Accepted, and the last discovery did not list it or listed a schema nothing can check. */
  | "unknown"
  | "disabled";

/**
 * Why a call of a Connection is refused or fails, each with the error code it travels under.
 * The reason is the `details.reason` and the first word of the message of the `AppError`.
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
  /** Every slot of the Connection stayed taken for as long as a call waits for one. */
  connection_busy: "CONFLICT"
} as const satisfies Record<string, AppErrorCode>;

export type ConnectionCallReason = keyof typeof CONNECTION_CALL_REASONS;

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
  connection_busy: "too many calls of the Connection are running"
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
