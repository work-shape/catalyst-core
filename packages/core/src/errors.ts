import {
  APP_ERROR_STATUS_CODES,
  type AppErrorCode,
  type ModelUsageRefusal
} from "@work-shape/catalyst-asset-schemas";

export { APP_ERROR_STATUS_CODES, type AppErrorCode, type ModelUsageRefusal };

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
 * The code a run fails with when a usage limit refused its model call: a safeguard of a person
 * or of the calls the product makes, or a spend budget of the instance. A client reads it to
 * say what happened in the reader's language.
 */
export const MODEL_USAGE_LIMIT_REACHED_CODE = "MODEL_USAGE_LIMIT_REACHED";

/**
 * A model call that a usage limit refused before it was sent. Its details name the limit, so
 * a caller words the refusal without reading the message.
 */
export class ModelUsageLimitReachedError extends AppError {
  readonly refusal: ModelUsageRefusal;

  constructor(message: string, refusal: ModelUsageRefusal) {
    super("FORBIDDEN", message, { reason: MODEL_USAGE_LIMIT_REACHED_CODE, ...refusal });
    this.refusal = refusal;
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
 * What a failed run carries of an error besides its message: the error's own code, or the
 * narrower one of a refusal a client words itself, and for a usage limit which limit it was.
 */
export function runFailureOf(error: AppError): {
  code: string;
  tool?: string;
  usageLimit?: ModelUsageRefusal;
} {
  const code = runFailureCodeOf(error);
  if (error instanceof ConfirmationUnattendedError) return { code, tool: error.operation };
  if (error instanceof ModelUsageLimitReachedError) {
    const { period, metric, scope } = error.refusal;
    return { code, usageLimit: { period, metric, scope } };
  }
  return { code };
}

export class WorkflowAgentOutputInvalidError extends AppError {
  constructor(path: string) {
    super("VALIDATION_FAILED", `Agent output is invalid at ${path}`);
  }
}

/** A Workflow agent step's call that needs a confirmation: nobody is present to give it. */
export class ConfirmationUnattendedError extends AppError {
  constructor(readonly operation: string) {
    super(
      "POLICY_DENIED",
      `The operation '${operation}' needs a confirmation, and a Workflow agent step has nobody to give it`
    );
  }
}

/** The stable code of a run failure, without its optional refusal details. */
export function runFailureCodeOf(error: AppError): string {
  if (error instanceof WorkflowAgentOutputInvalidError) return "output_invalid";
  if (error instanceof ConfirmationUnattendedError) return "confirmation_unattended";
  if (error instanceof ModelNotPricedError) return MODEL_NOT_PRICED_CODE;
  if (error instanceof ModelUsageLimitReachedError) return MODEL_USAGE_LIMIT_REACHED_CODE;
  return error.code;
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

export const INTERNAL_ERROR_MESSAGE = "Internal server error";

export function assertNever(value: never): never {
  throw new AppError("INTERNAL", `Unhandled value: ${String(value)}`);
}
