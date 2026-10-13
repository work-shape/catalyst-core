import { APP_ERROR_STATUS_CODES, type AppErrorCode } from "@vivd-catalyst/asset-schemas";

export { APP_ERROR_STATUS_CODES, type AppErrorCode };

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly exposeMessage: boolean;
  /**
   * Set by the implementation of a changing operation that failed and knows that nothing of
   * it stayed: everything it did was one transaction that rolled back. Such a call is run
   * again under its idempotency key, like one that failed before its implementation started.
   * An implementation that cannot know leaves it unset.
   */
  readonly changedNothing: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    details?: unknown,
    options?: { exposeMessage?: boolean; changedNothing?: boolean }
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = APP_ERROR_STATUS_CODES[code];
    this.details = details;
    this.exposeMessage = options?.exposeMessage ?? this.statusCode < 500;
    this.changedNothing = options?.changedNothing ?? false;
  }
}

/**
 * A model call that a usage limit of the instance refused before it was sent. A caller that
 * answers for the refusal can say that the limit is the cause.
 */
export class ModelUsageLimitReachedError extends AppError {
  constructor(message: string) {
    super("FORBIDDEN", message);
  }
}

export function isModelUsageLimitReached(error: unknown): error is ModelUsageLimitReachedError {
  return error instanceof ModelUsageLimitReachedError;
}

/**
 * The code a run fails with when its model has no price on the customer rate card while a spend
 * budget is set. A client reads it to say what to do in the reader's language.
 */
export const MODEL_NOT_PRICED_CODE = "MODEL_NOT_PRICED";

/**
 * A model call refused before it was sent because nothing bounds what it costs: a spend budget
 * is set and the rate card has no price for the model.
 */
export class ModelNotPricedError extends AppError {
  constructor() {
    super(
      "FORBIDDEN",
      "The model has no price on the rate card; the spend budget cannot be evaluated safely",
      { reason: MODEL_NOT_PRICED_CODE }
    );
  }
}

/**
 * The code a failed run carries for an error: the error's own, or the narrower one of a
 * refusal a client words itself.
 */
export function runFailureCodeOf(error: AppError): string {
  return error instanceof ModelNotPricedError ? MODEL_NOT_PRICED_CODE : error.code;
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
