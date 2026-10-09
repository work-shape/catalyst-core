import pino from "pino";
import type { Logger } from "@vivd-catalyst/core";

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_STRING_LENGTH = 4000;
const MAX_DEPTH = 8;
// Normalize separators before matching a whole key or a suffix, never a substring, so usage
// counters such as inputTokens stay visible.
const SECRET_KEY_PATTERN =
  /(authorization|cookies?|password(hash)?|passphrase|secrets?|secret(access)?key|privatekey|accesskeyid|token(hash)?|apikey|signature|(?<!allow)credentials?)$/u;
// scheme://user:password@ anywhere in a string; every part is bounded and stops at whitespace.
const URL_PASSWORD_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/?#@]{0,256}):[^\s/?#]{1,512}@/giu;
let processLogger: Logger | undefined;

/** One stdout logger per process; no transport or secret-resolver state. */
export function createLogger(): Logger {
  processLogger ??= wrap(
    pino(
      {
        level: "info",
        serializers: {
          err: (value: unknown) => sanitize(value, 0, new WeakSet<object>()),
          msg: (value: unknown) => sanitize(value, 0, new WeakSet<object>())
        },
        formatters: {
          log: (fields) =>
            sanitizeFields(
              {
                ...fields,
                ...(fields.req === undefined ? {} : { req: serializeRequest(fields.req) }),
                ...(fields.res === undefined ? {} : { res: serializeResponse(fields.res) })
              },
              0,
              new WeakSet<object>()
            )
        }
      },
      process.stdout
    )
  );
  return processLogger;
}

function wrap(backend: pino.Logger): Logger {
  function write(
    level: "debug" | "info" | "warn" | "error",
    input: unknown,
    message?: string
  ): void {
    if (typeof input === "string") {
      backend[level](sanitizeString(input));
    } else {
      backend[level](
        input,
        message === undefined
          ? input instanceof Error
            ? sanitizeString(input.message)
            : undefined
          : sanitizeString(message)
      );
    }
  }
  return {
    debug: (input, message) => write("debug", input, message),
    info: (input, message) => write("info", input, message),
    warn: (input, message) => write("warn", input, message),
    error: (input, message) => write("error", input, message),
    child: (bindings) => wrap(backend.child(sanitizeFields(bindings, 0, new WeakSet<object>())))
  };
}

function sanitizeFields(
  fields: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = SECRET_KEY_PATTERN.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""))
      ? REDACTED
      : sanitize(value, depth, seen);
  }
  return output;
}

/** Depth counts containers below the log record; a container at MAX_DEPTH is cut. */
function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof URL) return sanitizeString(value.href);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[Binary ${value.byteLength} bytes]`;
  }
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return sanitizeFields(
      {
        ...Object.fromEntries(Object.entries(value)),
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(value.cause === undefined ? {} : { cause: value.cause })
      },
      depth + 1,
      seen
    );
  }
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1, seen));
  return sanitizeFields(Object.fromEntries(Object.entries(value)), depth + 1, seen);
}

function sanitizeString(value: string): string {
  const redacted = value
    .replace(URL_PASSWORD_PATTERN, `$1:${REDACTED}@`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/giu, REDACTED);
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
    : redacted;
}

/** The fields Fastify's own request serializer wrote; never headers. */
function serializeRequest(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "method" in value &&
    "url" in value &&
    typeof value.method === "string" &&
    typeof value.url === "string"
  ) {
    return {
      method: value.method,
      url: value.url,
      ...("host" in value && typeof value.host === "string" ? { host: value.host } : {}),
      ...("ip" in value && typeof value.ip === "string" ? { remoteAddress: value.ip } : {})
    };
  }
  return value;
}

/** Reads the status from the reply itself, which is set before the headers are sent. */
function serializeResponse(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "statusCode" in value &&
    typeof value.statusCode === "number"
  ) {
    return { statusCode: value.statusCode };
  }
  return value;
}
