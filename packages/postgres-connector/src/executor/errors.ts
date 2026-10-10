export type PostgresExecutorErrorKind =
  | "query_rejected"
  | "timeout"
  | "cancelled"
  | "busy"
  | "unavailable"
  | "unauthorized"
  | "network_denied"
  | "tls_failed"
  | "read_only_violation"
  | "failed";

type FixedSentenceKind = Exclude<PostgresExecutorErrorKind, "query_rejected">;

const FIXED_SENTENCES: Record<FixedSentenceKind, string> = {
  timeout: "The query ran longer than the time limit and was cancelled.",
  cancelled: "The query was cancelled.",
  busy: "All connections to this database are in use. Try again shortly.",
  unavailable: "The database could not be reached.",
  unauthorized: "The credential of this connection is missing or the database refused it.",
  network_denied: "The address of this database is not an allowed destination.",
  tls_failed: "A verified TLS connection to the database could not be established.",
  read_only_violation: "The query tried to change data. Queries run in a read-only transaction.",
  failed: "The query failed."
};

/**
 * The one error of the executor. Its text is a fixed sentence for the kind. Only
 * `query_rejected` carries more: a sentence of the executor's own, or the database's message
 * for SQLSTATE class 42 when the caller's own statement raised it on a connection that had
 * finished authentication. That message is the answer to the caller's own query and can quote a
 * value the query read, as `(select note from t)::regclass` does. It is for the caller of this
 * call alone: it must not go to a log or a run record, and the executor writes it nowhere. No
 * error holds a driver error, a host, a user, a credential, query text or a parameter.
 */
export class PostgresExecutorError extends Error {
  readonly kind: PostgresExecutorErrorKind;
  /** The SQLSTATE the database answered with, when it answered. */
  readonly sqlState: string | undefined;

  constructor(kind: FixedSentenceKind, sqlState?: string);
  constructor(kind: "query_rejected", message: string, sqlState?: string);
  constructor(kind: PostgresExecutorErrorKind, second?: string, third?: string) {
    super(kind === "query_rejected" ? second : FIXED_SENTENCES[kind]);
    this.name = "PostgresExecutorError";
    this.kind = kind;
    this.sqlState = kind === "query_rejected" ? third : second;
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/u;

const UNREACHABLE_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT"
]);

/**
 * Turns whatever a call failed with into an executor error. A driver error is read for its
 * code alone, because its text can quote a connection target or a row value, and the driver
 * hangs the query text and the parameters on the errors it passes through. So even an
 * executor error is rebuilt and never handed on as the object the driver touched.
 *
 * The server's message is passed on for class 42 only, and only when `fromCallerStatement`
 * says the caller's statement raised it. While a connection is made, an endpoint could put
 * anything it was sent into such a message, so those failures get the fixed sentence.
 */
export function toPostgresExecutorError(
  error: unknown,
  fromCallerStatement = false
): PostgresExecutorError {
  if (error instanceof PostgresExecutorError) {
    return error.kind === "query_rejected"
      ? new PostgresExecutorError("query_rejected", error.message, error.sqlState)
      : new PostgresExecutorError(error.kind, error.sqlState);
  }
  const code = stringField(error, "code");
  if (code === undefined) return new PostgresExecutorError("failed");
  if (!SQLSTATE.test(code)) {
    return new PostgresExecutorError(UNREACHABLE_CODES.has(code) ? "unavailable" : "failed");
  }
  if (code.startsWith("42") && fromCallerStatement) {
    return new PostgresExecutorError("query_rejected", rejectionText(error), code);
  }
  return new PostgresExecutorError(kindOfSqlState(code), code);
}

function kindOfSqlState(code: string): FixedSentenceKind {
  if (code === "25006") return "read_only_violation";
  if (code === "57014") return "timeout";
  if (code.startsWith("28")) return "unauthorized";
  // Connection exceptions, too many connections, a server that is shutting down or starting,
  // and a database that does not exist.
  if (code.startsWith("08") || code.startsWith("53") || code.startsWith("57P") || code === "3D000")
    return "unavailable";
  return "failed";
}

function rejectionText(error: unknown): string {
  const message = stringField(error, "message") ?? "the query is not valid";
  const position = stringField(error, "position");
  return position !== undefined && /^\d+$/u.test(position)
    ? `Query rejected: ${message} (at character ${position} of the query)`
    : `Query rejected: ${message}`;
}

function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, name);
  return typeof field === "string" ? field : undefined;
}
