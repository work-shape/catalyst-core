import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createApiClient,
  signInForSessionFetch,
  type ApiClientOptions
} from "@vivd-catalyst/api-client";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";

/** The variable `catalyst config` reads its key from. */
export const API_KEY_ENV_NAME = "CATALYST_API_KEY";

const PRINCIPAL_LABEL = "Local config CLI";
const PERMISSIONS = ["config_assets.read", "config_assets.release"] as const;
const SCOPES = ["config_assets:read", "config_assets:release"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface LocalApiKeyOptions {
  /** The local development instance. Any host other than this machine is refused. */
  baseUrl: string;
  /** The client instance config whose development seed superadmin signs in. */
  configPath: string;
  env: Env;
  fetchImpl?: ApiClientOptions["fetchImpl"];
}

/**
 * What an operator does by hand under Administration, API Access, done for a local development
 * instance: the seeded superadmin creates a service principal for the CLI, or reuses the one
 * an earlier call created, and a key limited to the two config scopes. Returns the key.
 */
export async function createLocalApiKey(options: LocalApiKeyOptions): Promise<string> {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const hostname = new URL(baseUrl).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new Error(
      `Refusing to create a local API key on '${hostname}'. This command signs in with a development password and only runs against localhost, 127.0.0.1 or ::1.`
    );
  }
  const { env } = options;
  const config = await loadClientInstanceConfigFromFile(options.configPath);
  const standalone = config.auth.standalone;
  const superadmin = standalone?.seedUsers.find((user) => user.roles.includes("superadmin"));
  if (config.clientInstance.environment !== "development" || !standalone || !superadmin) {
    throw new Error(
      `${options.configPath} is not a development config with a seeded superadmin. Create the key under Administration, API Access instead.`
    );
  }
  const password = env[superadmin.passwordEnvName] ?? superadmin.developmentPassword;
  const origin = env.CHAT_UI_ORIGIN ?? standalone.trustedOrigins[0];
  if (!password || !origin) {
    throw new Error(
      `${options.configPath} names no development password or trusted origin for the seeded superadmin.`
    );
  }

  const client = createApiClient({
    baseUrl,
    fetchImpl: await signInForSessionFetch({
      apiBaseUrl: baseUrl,
      origin,
      email: (superadmin.emailEnvName && env[superadmin.emailEnvName]) || superadmin.email,
      password,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    })
  }).apiAccess;
  const existing = (await client.listServicePrincipals()).find(
    (detail) =>
      detail.principal.displayLabel === PRINCIPAL_LABEL && detail.principal.status === "active"
  );
  const { principal } =
    existing ??
    (await client.createServicePrincipal({
      displayLabel: PRINCIPAL_LABEL,
      permissions: [...PERMISSIONS]
    }));
  const credential = await client.createCredential(principal.id, {
    name: "local development",
    scopes: [...SCOPES]
  });
  return credential.secret;
}

/** Sets the key under a variable in an env file, keeping every other line, and returns the file's path. */
export async function writeApiKeyToEnvFile(
  path: string,
  envName: string,
  apiKey: string
): Promise<string> {
  const file = resolve(path);
  const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
  const line = `${envName}=${apiKey}`;
  const index = lines.findIndex((existing) => existing.startsWith(`${envName}=`));
  if (index === -1) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(line, "");
  } else {
    lines[index] = line;
  }
  await writeFile(file, lines.join("\n"), { mode: 0o600 });
  return file;
}
