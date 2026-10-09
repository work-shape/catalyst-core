import type { ToolExecutionContext, ToolExecutionRequest } from "@vivd-catalyst/core";

/** What the log keeps of a database error: its own fields, without statement or parameters. */
interface ToolFailureDatabaseError {
  sqlState: string;
  message: string;
  constraint?: string;
  table?: string;
}

interface ToolFailureLogRecord {
  correlationId: string;
  toolName: string;
  toolCallId: string;
  agentName: string;
  conversationId: string;
  errorName: string;
  stack?: string;
  database?: ToolFailureDatabaseError;
}

/**
 * The log record of a handler failure the model only sees as a reference. A query builder
 * wraps a database error in one whose message holds the statement and its parameter values,
 * and parameters hold user content. The record therefore takes no message from the thrown
 * error: its name, the frames of its stack and, where a database error is in its cause chain,
 * that error's SQLSTATE code, constraint, table and short message.
 */
export function toolFailureLogRecord(
  error: unknown,
  request: ToolExecutionRequest,
  context: ToolExecutionContext
): ToolFailureLogRecord {
  return {
    correlationId: context.correlationId,
    toolName: request.toolName,
    toolCallId: request.toolCallId,
    agentName: request.agentName,
    conversationId: request.conversationId,
    ...failureLogFields(error)
  };
}

/** What a log may keep of any thrown error, by the rule above. */
export function failureLogFields(
  error: unknown
): Pick<ToolFailureLogRecord, "errorName" | "stack" | "database"> {
  const stack = error instanceof Error ? stackFrames(error.stack) : undefined;
  const database = findDatabaseError(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(stack ? { stack } : {}),
    ...(database ? { database } : {})
  };
}

/** The frames of a stack without its first lines, which repeat the error's message. */
function stackFrames(stack: string | undefined): string | undefined {
  const frames = (stack ?? "").split("\n").filter((line) => /^\s+at /u.test(line));
  return frames.length > 0 ? frames.join("\n") : undefined;
}

function findDatabaseError(error: unknown): ToolFailureDatabaseError | undefined {
  const seen = new Set<unknown>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    const sqlState = stringField(current, "code");
    // A system error such as EPIPE has a five-character code too; only the database sends a severity.
    if (sqlState && /^[0-9A-Z]{5}$/u.test(sqlState) && stringField(current, "severity")) {
      const constraint = stringField(current, "constraint_name");
      const table = stringField(current, "table_name");
      return {
        sqlState,
        message: current.message,
        ...(constraint ? { constraint } : {}),
        ...(table ? { table } : {})
      };
    }
  }
  return undefined;
}

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}
