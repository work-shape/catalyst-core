import { apiOperations } from "@vivd-catalyst/api-contract";

interface SchemaParser<Output> {
  parse(input: unknown): Output;
}

export class ConfigApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, payload: unknown) {
    const error = readApiError(payload);
    super(error.message ?? `Catalyst API request failed with HTTP ${status}`);
    this.name = "ConfigApiError";
    this.status = status;
    this.code = error.code;
    this.details = error.details;
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
  apiKey?: string;
  serverCredential?: string;
  fetchImpl?: typeof fetch;
}

export async function createConfigApi(options: ConfigApiOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.apiKey) {
    assertSafeApiKeyExchangeUrl(baseUrl);
  }
  const authorization = options.apiKey
    ? await exchangeApiKey(fetchImpl, baseUrl, options.apiKey)
    : await issueLegacySessionToken(fetchImpl, baseUrl, requireServerCredential(options));

  return {
    exportAssets: () =>
      requestJson(
        fetchImpl,
        `${baseUrl}${apiOperations.exportConfigAssets.buildPath()}`,
        apiOperations.exportConfigAssets.responseSchema,
        { headers: { authorization } }
      ),
    replaceAssets: (input: unknown) => {
      const body = apiOperations.replaceConfigAssets.requestSchema.parse(input);
      return requestJson(
        fetchImpl,
        `${baseUrl}${apiOperations.replaceConfigAssets.buildPath()}`,
        apiOperations.replaceConfigAssets.responseSchema,
        {
          method: apiOperations.replaceConfigAssets.method,
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      );
    },
    validateAssets: (input: unknown) => {
      const body = apiOperations.validateConfigAssets.requestSchema.parse(input);
      return requestJson(
        fetchImpl,
        `${baseUrl}${apiOperations.validateConfigAssets.buildPath()}`,
        apiOperations.validateConfigAssets.responseSchema,
        {
          method: apiOperations.validateConfigAssets.method,
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      );
    }
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
    const issued = await requestJson(
      fetchImpl,
      `${baseUrl}${apiOperations.exchangeApiKey.buildPath()}`,
      apiOperations.exchangeApiKey.responseSchema,
      {
        method: apiOperations.exchangeApiKey.method,
        headers: { authorization: `Bearer ${apiKey}` }
      }
    );
    return `Bearer ${issued.accessToken}`;
  } catch (error) {
    throw new ApiKeyExchangeError(error, apiKey);
  }
}

async function issueLegacySessionToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  serverCredential: string
): Promise<string> {
  const sessionRequest = apiOperations.issueSessionToken.requestSchema.parse({
    externalUserId: "catalyst-cli",
    displayLabel: "Catalyst CLI",
    scopes: ["config_assets:read", "config_assets:release"],
    permissions: ["config_assets.read", "config_assets.release"],
    delegatedActor: {
      kind: "service_principal",
      id: "catalyst-cli",
      authSource: "catalyst-cli"
    }
  });
  const issued = await requestJson(
    fetchImpl,
    `${baseUrl}${apiOperations.issueSessionToken.buildPath()}`,
    apiOperations.issueSessionToken.responseSchema,
    {
      method: apiOperations.issueSessionToken.method,
      headers: {
        "content-type": "application/json",
        "x-server-credential": serverCredential
      },
      body: JSON.stringify(sessionRequest)
    }
  );
  return `Bearer ${issued.chatSessionToken}`;
}

function requireServerCredential(options: ConfigApiOptions): string {
  if (!options.serverCredential) {
    throw new Error("Config API authentication was not configured");
  }
  return options.serverCredential;
}

async function requestJson<Output>(
  fetchImpl: typeof fetch,
  url: string,
  schema: SchemaParser<Output>,
  init: RequestInit = {}
): Promise<Output> {
  const response = await fetchImpl(url, init);
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new ConfigApiError(response.status, payload);
  }
  return schema.parse(payload);
}

async function readJsonPayload(response: Response): Promise<unknown> {
  const contents = await response.text();
  if (!contents) {
    return undefined;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`Catalyst API returned invalid JSON (HTTP ${response.status})`);
  }
}

function readApiError(payload: unknown): {
  code?: string;
  message?: string;
  details?: unknown;
} {
  if (!isRecord(payload) || !isRecord(payload.error)) {
    return {};
  }
  return {
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
