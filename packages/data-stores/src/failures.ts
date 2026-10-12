import { PostgresExecutorError } from "@vivd-catalyst/postgres-connector";
import { AppError, type AppErrorCode } from "@vivd-catalyst/core";

// What a failure of a store's database is told as. The database's own message can quote a row
// value, so none is passed on: a failure is a fixed sentence for its SQLSTATE, with the code.

const SQLSTATE_SENTENCES: Readonly<Record<string, string>> = {
  "0A000": "asks for something the database does not support",
  "25001": "holds a statement that cannot run inside a transaction",
  "2D000": "tried to end the transaction it runs in",
  "23502": "leaves a column empty that must hold a value",
  "23503": "names a row that another table does not hold",
  "23505": "would store a value twice that must be unique",
  "23514": "breaks a check of its table",
  "42501": "needs a privilege its role does not hold",
  "42601": "has a syntax error",
  "42703": "names a column that does not exist",
  "42P01": "names a table or view that does not exist"
};

const SQLSTATE_CLASS_SENTENCES: Readonly<Record<string, string>> = {
  // What a function or a trigger of the store raises itself, under whatever code it chose.
  "28": "was refused by the store's own code",
  P0: "was refused by the store's own code",
  "22": "holds a value that does not fit the type of its column",
  "23": "breaks a constraint of its table",
  "42": "is refused by the database as written"
};

export interface DatabaseFailure {
  /** A fixed sentence. It names no value, no host and no role. */
  sentence: string;
  sqlState?: string;
  /** Whether trying again can end differently: the server was busy or away. */
  retryable: boolean;
  /** The error a caller of an operation is answered with. */
  code: AppErrorCode;
}

/** Reads what a call of the executor failed with. Anything else is an unnamed failure. */
export function describeDatabaseFailure(error: unknown, subject: string): DatabaseFailure {
  if (!(error instanceof PostgresExecutorError)) {
    return { sentence: `${subject} failed.`, retryable: false, code: "INTERNAL" };
  }
  const { kind, sqlState } = error;
  if (kind === "query_rejected" && sqlState === undefined) {
    // A sentence of the executor's own screening, which quotes nothing.
    return { sentence: error.message, retryable: false, code: "VALIDATION_FAILED" };
  }
  if (sqlState !== undefined && (kind === "query_rejected" || kind === "failed")) {
    const known = SQLSTATE_SENTENCES[sqlState] ?? SQLSTATE_CLASS_SENTENCES[sqlState.slice(0, 2)];
    return {
      sentence: `${subject} ${known ?? "failed in the database"} (SQLSTATE ${sqlState}).`,
      sqlState,
      retryable: false,
      code: known === undefined ? "INTERNAL" : "VALIDATION_FAILED"
    };
  }
  const base = { sentence: error.message, ...(sqlState === undefined ? {} : { sqlState }) };
  switch (kind) {
    case "timeout":
      return { ...base, retryable: false, code: "TIMEOUT" };
    case "read_only_violation":
      return { ...base, retryable: false, code: "VALIDATION_FAILED" };
    case "busy":
    case "cancelled":
      return { ...base, retryable: true, code: "CONFLICT" };
    case "unavailable":
      return { ...base, retryable: true, code: "INTERNAL" };
    default:
      return { ...base, retryable: false, code: "INTERNAL" };
  }
}

/** The failure of a store's database as the error of an operation. */
export function databaseFailureError(error: unknown, subject: string): AppError {
  const failure = describeDatabaseFailure(error, subject);
  return new AppError(
    failure.code,
    failure.sentence,
    // An answer of status 500 carries no details.
    failure.sqlState === undefined || failure.code === "INTERNAL"
      ? undefined
      : { sqlState: failure.sqlState },
    { exposeMessage: true }
  );
}
