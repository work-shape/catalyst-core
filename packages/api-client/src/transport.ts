import type { z } from "zod";
import { ApiError } from "./errors";
import { createClient as createGeneratedClient } from "./generated/client";

export interface ApiClientOptions {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  /** Only available without a token source; browser navigation cannot send a bearer token. */
  browserManagedDownloads?: boolean;
}

export type OperationRequestInput<Operation> = Operation extends {
  requestSchema: z.ZodType<infer Request>;
}
  ? Request
  : never;

type GeneratedResult<T> =
  | {
      data: T;
      error: undefined;
      request?: Request;
      response?: Response;
    }
  | {
      data: undefined;
      error: unknown;
      request?: Request;
      response?: Response;
    };

export function createApiClientTransport(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const cookieMode = options.getToken === undefined;
  const generatedClient = createGeneratedClient({
    baseUrl,
    credentials: cookieMode ? "include" : "omit",
    fetch: options.fetchImpl
  });

  generatedClient.interceptors.request.use(async (request) => {
    const token = await options.getToken?.();
    if (token) {
      request.headers.set("authorization", `Bearer ${token}`);
    }
    return request;
  });

  return {
    baseUrl,
    browserManagedDownloads: cookieMode && (options.browserManagedDownloads ?? true),
    generatedClient,
    buildUrl: (path: string) => `${baseUrl}${path}`,
    async unwrapJson<T>(
      result: Promise<GeneratedResult<unknown>>,
      schema: z.ZodType<T>
    ): Promise<T> {
      const payload = await result;
      if (payload.error !== undefined) {
        throw apiErrorFromGeneratedResult(payload);
      }
      return schema.parse(payload.data);
    },
    async unwrapBlob(result: Promise<GeneratedResult<Blob | File>>): Promise<Blob> {
      const payload = await result;
      if (payload.error !== undefined) {
        throw apiErrorFromGeneratedResult(payload);
      }
      if (!payload.data) {
        throw new ApiError(payload.response?.status ?? 0, "API request failed", payload.data);
      }
      return payload.data;
    }
  };
}

export type ApiClientTransport = ReturnType<typeof createApiClientTransport>;

export function apiErrorFromGeneratedResult(result: {
  error: unknown;
  response?: Response;
}): ApiError {
  const payload = result.error;
  const status = result.response?.status ?? 0;
  return new ApiError(status, apiErrorMessage(payload), payload);
}

function apiErrorMessage(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return "API request failed";
}
