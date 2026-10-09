import { apiOperations } from "@vivd-catalyst/api-contract";
import { ApiError, createApiClient } from "@vivd-catalyst/api-client";

export class ConfigApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly correlationId?: string;

  constructor(status: number, payload: unknown) {
    const error = readApiError(payload);
    super(error.message ?? `Catalyst API request failed with HTTP ${status}`);
    this.name = "ConfigApiError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
    this.correlationId = error.correlationId;
  }
}

export class ApiKeyExchangeError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(error: unknown, apiKey: string) {
    const status = error instanceof ConfigApiError ? error.status : undefined;
    const code = error instanceof ConfigApiError ? error.code : undefined;
    const causeMessage = error instanceof Error ? error.message : String(error);
    const statusLabel = status === undefined ? "" : ` (HTTP ${status})`;
    super(`API key exchange failed${statusLabel}: ${redactSecret(causeMessage, apiKey)}`);
    this.name = "ApiKeyExchangeError";
    this.status = status;
    this.code = code;
  }
}

export interface ConfigApiOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export async function createConfigApi(options: ConfigApiOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  assertSafeApiKeyExchangeUrl(baseUrl);
  const accessToken = await exchangeApiKey(fetchImpl, baseUrl, options.apiKey);
  const client = createApiClient({
    baseUrl,
    getToken: () => accessToken,
    fetchImpl
  });

  return {
    exportAssets: () => asConfigApiRequest(() => client.config_assets.export()),
    replaceAssets: (input: unknown) =>
      asConfigApiRequest(() =>
        client.config_assets.replace({
          body: apiOperations["config_assets.replace"].body.parse(input)
        })
      ),
    validateAssets: (input: unknown) =>
      asConfigApiRequest(() =>
        client.config_assets.validate({
          body: apiOperations["config_assets.validate"].body.parse(input)
        })
      )
  };
}

function assertSafeApiKeyExchangeUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:") {
    if (isLoopbackHostname(parsed.hostname)) {
      return;
    }
    throw new Error(
      `Refusing to send CATALYST_API_KEY over plain HTTP to '${parsed.hostname}'. Use HTTPS; HTTP is allowed only for localhost, 127.0.0.0/8, or ::1.`
    );
  }
  throw new Error(
    `Refusing to send CATALYST_API_KEY using unsupported URL scheme '${parsed.protocol}'. Use HTTPS; HTTP is allowed only for localhost, 127.0.0.0/8, or ::1.`
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

async function exchangeApiKey(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string
): Promise<string> {
  try {
    const issued = await createApiClient({
      baseUrl,
      getToken: () => apiKey,
      fetchImpl
    }).access_tokens.exchange();
    return issued.accessToken;
  } catch (error) {
    throw new ApiKeyExchangeError(toConfigApiError(error), apiKey);
  }
}

async function asConfigApiRequest<Output>(request: () => Promise<Output>): Promise<Output> {
  try {
    return await request();
  } catch (error) {
    throw toConfigApiError(error);
  }
}

function toConfigApiError(error: unknown): unknown {
  if (!(error instanceof ApiError)) {
    return error;
  }
  if (error.status === 0) {
    return error.payload;
  }
  if (error.payload instanceof SyntaxError || typeof error.payload === "string") {
    return new Error(`Catalyst API returned invalid JSON (HTTP ${error.status})`);
  }
  if (error.payload instanceof Error) {
    return new Error(`Catalyst API returned an unexpected response (HTTP ${error.status})`, {
      cause: error.payload
    });
  }
  return new ConfigApiError(error.status, error.payload);
}

function readApiError(payload: unknown): {
  code?: string;
  message?: string;
  details?: unknown;
  correlationId?: string;
} {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return {};
  }
  return {
    ...(typeof payload.error.correlationId === "string"
      ? { correlationId: payload.error.correlationId }
      : {}),
    ...(typeof payload.error.code === "string" ? { code: payload.error.code } : {}),
    ...(typeof payload.error.message === "string" ? { message: payload.error.message } : {}),
    ...(payload.error.details === undefined ? {} : { details: payload.error.details })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[redacted]") : message;
}
