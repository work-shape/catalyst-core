export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TIMEOUT"
  | "VALIDATION_FAILED"
  | "INTERNAL";

const statusByCode: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TIMEOUT: 504,
  VALIDATION_FAILED: 422,
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
    this.statusCode = statusByCode[code];
    this.details = details;
    this.exposeMessage = options?.exposeMessage ?? this.statusCode < 500;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function assertNever(value: never): never {
  throw new AppError("INTERNAL", `Unhandled value: ${String(value)}`);
}
