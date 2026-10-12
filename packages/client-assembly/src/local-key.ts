import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  completedOutput,
  createApiClient,
  listAll,
  signInForSessionFetch,
  type ApiClientOptions
} from "@vivd-catalyst/api-client";
import { loadClientInstanceConfigFromFile } from "@vivd-catalyst/config-schema";
import { createEnvironmentSecretResolver, resolveOptionalSecret } from "@vivd-catalyst/core";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";

/** The variable the `catalyst` command line tool reads its key from. */
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
  const secrets = createEnvironmentSecretResolver({
    env,
    readSecretFile: (path) => readFile(path, "utf8")
  });
  const password =
    (await resolveOptionalSecret(secrets, superadmin.passwordEnvName)) ??
    superadmin.developmentPassword;
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
  });
  const principals = await listAll((paging) => client.service_principals.list({ query: paging }));
  const existing = principals.find(
    (detail) =>
      detail.principal.displayLabel === PRINCIPAL_LABEL && detail.principal.status === "active"
  );
  const { principal } =
    existing ??
    completedOutput(
      await client.service_principals.create({
        body: { displayLabel: PRINCIPAL_LABEL, permissions: [...PERMISSIONS] }
      })
    );
  const credential = await client.api_credentials.create({
    params: { servicePrincipalId: principal.id },
    body: { name: "local development", scopes: [...SCOPES] }
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

export interface LocalKeyCliRuntime {
  cwd?: string;
  fetchImpl?: ApiClientOptions["fetchImpl"];
  env?: ClientInstanceEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const helpText = `Usage: catalyst-local-key --instance <url> [options]

Create an API key on a local development instance and write it to an env file.
Refuses any host other than this machine. The key is never printed.

Options:
  --instance <url>       The local instance, such as http://127.0.0.1:4100
  --config <app-config>  Client instance config (default: config/app.yaml)
  --write-env <file>     Env file that receives the key (default: .env)
  --env-name <variable>  Variable written (default: ${API_KEY_ENV_NAME})
  --help                 Show this help
`;

/** Runs `catalyst-local-key`. Returns the exit code: 0 written, 1 failed, 2 wrong usage. */
export async function runLocalKeyCli(
  argv: string[],
  runtime: LocalKeyCliRuntime = {}
): Promise<number> {
  const stdout = runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = runtime.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = runtime.cwd ?? process.cwd();
  let values: {
    instance?: string;
    config?: string;
    "write-env"?: string;
    "env-name"?: string;
    help: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        instance: { type: "string" },
        config: { type: "string" },
        "write-env": { type: "string" },
        "env-name": { type: "string" },
        help: { type: "boolean", short: "h", default: false }
      },
      strict: true
    }));
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n\n${helpText}`);
    return 2;
  }
  if (values.help) {
    stdout(helpText);
    return 0;
  }
  if (!values.instance || !URL.canParse(values.instance)) {
    stderr(`--instance must be the URL of the local instance.\n\n${helpText}`);
    return 2;
  }
  try {
    const apiKey = await createLocalApiKey({
      baseUrl: values.instance,
      configPath: resolve(cwd, values.config ?? "config/app.yaml"),
      env: readClientInstanceEnv(runtime.env),
      ...(runtime.fetchImpl === undefined ? {} : { fetchImpl: runtime.fetchImpl })
    });
    const envName = values["env-name"] ?? API_KEY_ENV_NAME;
    const file = await writeApiKeyToEnvFile(
      resolve(cwd, values["write-env"] ?? ".env"),
      envName,
      apiKey
    );
    stdout(`Created a key for ${values.instance} and wrote ${envName} to ${file}.\n`);
    return 0;
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
