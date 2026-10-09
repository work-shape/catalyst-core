import { AppError, type AppErrorCode } from "@vivd-catalyst/core";

// Protects logs from a provider's error body, which can repeat what a user sent: the provider's
// message is kept up to this length, for the log only. Nobody sees it in the product.
export const MODEL_PROVIDER_MESSAGE_MAX_CHARS = 300;

/**
 * Why a model call failed, as the product names it. The gateway decides from this and from
 * `retryable` whether a call is sent again, never from an error's text.
 */
export type ModelProviderErrorKind =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "context_length_exceeded"
  | "continuation_rejected"
  | "invalid_request"
  | "invalid_response";

export interface ModelProviderErrorInput {
  kind: ModelProviderErrorKind;
  /** A fixed sentence of the product. Never text a provider sent. */
  message: string;
  /** The HTTP status, where the failure had one. */
  status?: number;
  /** Defaults to what the kind says: rate limits, server errors, timeouts and lost connections. */
  retryable?: boolean;
  providerCode?: string | number;
  providerRequestId?: string;
  /** The pause the provider asked for with its refusal. */
  retryAfterMs?: number;
  /** What the provider wrote. Cut to the limit above and readable only through the getter. */
  providerMessage?: string;
  /** Bounded identifiers for diagnostics, as `AppError.details`. */
  details?: Record<string, unknown>;
}

const RETRYABLE_KINDS: ReadonlySet<ModelProviderErrorKind> = new Set([
  "rate_limit",
  "server_error",
  "timeout",
  "network"
]);

/**
 * What a model adapter throws. Its message is a fixed sentence; the provider's own words stay in
 * a private field that no serializer reads, so they reach a log only where the gateway writes them.
 */
export class ModelProviderError extends AppError {
  readonly kind: ModelProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly providerCode?: string | number;
  readonly providerRequestId?: string;
  readonly retryAfterMs?: number;
  readonly #providerMessage: string | undefined;

  constructor(input: ModelProviderErrorInput) {
    super(appErrorCodeFor(input.kind), input.message, input.details);
    this.name = "ModelProviderError";
    this.kind = input.kind;
    this.retryable = input.retryable ?? RETRYABLE_KINDS.has(input.kind);
    if (input.status !== undefined) this.status = input.status;
    if (input.providerCode !== undefined) this.providerCode = input.providerCode;
    if (input.providerRequestId !== undefined) this.providerRequestId = input.providerRequestId;
    if (input.retryAfterMs !== undefined) this.retryAfterMs = input.retryAfterMs;
    this.#providerMessage = boundProviderMessage(input.providerMessage);
  }

  /** For the gateway's log line only. Never part of a message, a response or `details`. */
  get providerMessage(): string | undefined {
    return this.#providerMessage;
  }
}

/** Which kind an HTTP status of a provider means. */
export function modelProviderErrorKindForStatus(status: number): ModelProviderErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 408) return "timeout";
  if (status >= 500) return "server_error";
  return "invalid_request";
}

/**
 * Whether a provider error says the continuation sent with the request can never be used. The
 * caller drops that continuation and sends the request again from the conversation's history.
 */
export function isModelProviderContinuationRejected(error: unknown): boolean {
  return error instanceof ModelProviderError && error.kind === "continuation_rejected";
}

/** Cuts a provider's message to the limit and to one line. */
export function boundProviderMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length > 0 ? oneLine.slice(0, MODEL_PROVIDER_MESSAGE_MAX_CHARS) : undefined;
}

// Error codes Node and its HTTP client put on a connection that failed or was cut.
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET"
]);

/**
 * An adapter reports a failed request or a cut response body with this: the connection failed,
 * so the call may be sent again. An abort and an error the product already typed pass unchanged.
 */
export function toModelTransportFailure(error: unknown): unknown {
  if (error instanceof AppError || isAbortError(error)) {
    return error;
  }
  return new ModelProviderError({
    kind: "network",
    message: "Model provider connection failed"
  });
}

/**
 * What the gateway decides on. An adapter throws `ModelProviderError`; an error that reaches the
 * gateway untyped is read by its code alone: a timeout of the product and a failed connection
 * become typed errors, anything else stays what it is and is not sent again.
 */
export function normalizeModelAdapterError(error: unknown): unknown {
  if (error instanceof ModelProviderError) {
    return error;
  }
  if (error instanceof AppError) {
    return error.code === "TIMEOUT"
      ? new ModelProviderError({ kind: "timeout", message: error.message })
      : error;
  }
  if (isAbortError(error)) {
    return error;
  }
  return hasConnectionErrorCode(error)
    ? new ModelProviderError({ kind: "network", message: "Model provider connection failed" })
    : error;
}

function hasConnectionErrorCode(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4 && isRecord(candidate); depth += 1) {
    if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appErrorCodeFor(kind: ModelProviderErrorKind): AppErrorCode {
  if (kind === "context_length_exceeded") return "VALIDATION_FAILED";
  if (kind === "timeout") return "TIMEOUT";
  return "INTERNAL";
}
