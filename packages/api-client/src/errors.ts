import { appErrorCodeSchema, type ApiErrorCode } from "@vivd-catalyst/api-contract";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: ApiErrorCode;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = readApiErrorCode(payload);
    this.payload = payload;
  }
}

function readApiErrorCode(payload: unknown): ApiErrorCode | undefined {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return undefined;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const parsed = appErrorCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}
