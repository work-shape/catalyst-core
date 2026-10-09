export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "POLICY_DENIED"
  | "GUARDRAIL_BLOCKED"
  | "DECLINED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "OPERATION_IN_PROGRESS"
  | "OPERATION_EXPIRED"
  | "OUTPUT_NOT_RETAINED"
  | "INTERNAL";

/** The HTTP status every error code answers with. */
export const APP_ERROR_STATUS_CODES: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 504,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  POLICY_DENIED: 403,
  GUARDRAIL_BLOCKED: 403,
  DECLINED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  OPERATION_IN_PROGRESS: 409,
  OPERATION_EXPIRED: 409,
  OUTPUT_NOT_RETAINED: 409,
  INTERNAL: 500
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly exposeMessage: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    details?: unknown,
    options?: { exposeMessage?: boolean }
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = APP_ERROR_STATUS_CODES[code];
    this.details = details;
    this.exposeMessage = options?.exposeMessage ?? this.statusCode < 500;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function isAppErrorCode(code: string): code is AppErrorCode {
  return Object.hasOwn(APP_ERROR_STATUS_CODES, code);
}

export interface ErrorEnvelope {
  statusCode: number;
  error: {
    code: AppErrorCode;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}

/**
 * The one rule for what an error may tell a caller. INTERNAL never exposes a message;
 * other messages require exposeMessage, and details leave only below status 500. An unknown error is an
 * internal error without message or details.
 */
export function toErrorEnvelope(error: unknown, correlationId: string): ErrorEnvelope {
  if (!isAppError(error)) {
    return {
      statusCode: 500,
      error: { code: "INTERNAL", message: INTERNAL_ERROR_MESSAGE, correlationId }
    };
  }
  return {
    statusCode: error.statusCode,
    error: {
      code: error.code,
      correlationId,
      message:
        error.code !== "INTERNAL" && error.exposeMessage ? error.message : INTERNAL_ERROR_MESSAGE,
      ...(error.statusCode < 500 ? { details: error.details } : {})
    }
  };
}

const INTERNAL_ERROR_MESSAGE = "Internal server error";

export function assertNever(value: never): never {
  throw new AppError("INTERNAL", `Unhandled value: ${String(value)}`);
}
