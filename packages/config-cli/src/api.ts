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

export interface ConfigApiOptions {
  baseUrl: string;
  serverCredential: string;
  fetchImpl?: typeof fetch;
}

export async function createConfigApi(options: ConfigApiOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sessionRequest = apiOperations.issueSessionToken.requestSchema.parse({
    externalUserId: "catalyst-cli",
    displayLabel: "Catalyst CLI",
    scopes: ["config_assets:read", "config_assets:write"],
    permissions: ["config_assets.read", "config_assets.write"],
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
        "x-server-credential": options.serverCredential
      },
      body: JSON.stringify(sessionRequest)
    }
  );
  const authorization = `Bearer ${issued.chatSessionToken}`;

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
