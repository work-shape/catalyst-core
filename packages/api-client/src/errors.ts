import { appErrorCodeSchema, type ApiErrorCode } from "@vivd-catalyst/api-contract";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: ApiErrorCode;
  readonly payload: unknown;
  readonly correlationId?: string;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = readApiErrorCode(payload);
    this.payload = payload;
    this.correlationId = readCorrelationId(payload);
  }
}

function readApiErrorCode(payload: unknown): ApiErrorCode | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const parsed = appErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

function readCorrelationId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = payload.error;
  return error &&
    typeof error === "object" &&
    "correlationId" in error &&
    typeof error.correlationId === "string"
    ? error.correlationId
    : undefined;
}
