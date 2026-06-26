import type { LocalAgentRuntimeOptions } from "@vivd-catalyst/agent-runtime";
import { AppError } from "@vivd-catalyst/core";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_LOG_STRING_LENGTH = 4000;
const MAX_REDACTION_DEPTH = 8;
const SECRET_KEY_PATTERN = /(authorization|cookie|credential|password|secret|session|token|api[_-]?key)/iu;

export function createRuntimeFailureReporter(): NonNullable<LocalAgentRuntimeOptions["runFailureReporter"]> {
  return (report) => {
    const payload = {
      type: "agent_runtime.run_failed",
      runId: report.runId,
      conversationId: report.input.conversationId,
      agentName: report.input.agentName,
      clientInstanceId: report.context.clientInstanceId,
      correlationId: report.context.correlationId,
      failure: report.failure,
      error: serializeError(report.error)
    };

    console.error(JSON.stringify(payload));
  };
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: sanitizeString(error.message)
    };

    if (error.stack) {
      serialized.stack = sanitizeString(error.stack);
    }

    if (error instanceof AppError) {
      serialized.code = error.code;
      serialized.statusCode = error.statusCode;
      if (error.details !== undefined) {
        serialized.details = redactValue(error.details);
      }
    }

    for (const [key, value] of Object.entries(error)) {
      if (key in serialized) {
        continue;
      }
      serialized[key] = redactValue(value);
    }

    return serialized;
  }

  return {
    thrown: redactValue(error)
  };
}

function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return TRUNCATED;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(entry, depth + 1, seen);
  }
  return redacted;
}

function sanitizeString(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/giu, REDACTED);

  return redacted.length > MAX_LOG_STRING_LENGTH
    ? `${redacted.slice(0, MAX_LOG_STRING_LENGTH)}${TRUNCATED}`
    : redacted;
}
