import { readFile } from "node:fs/promises";
import { z } from "zod";
import { InfrastructureWorkflow, type InfrastructureEntry } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createEnvironmentSecretResolver,
  createProvider,
  defineProvider,
  ProviderRegistry,
  readDatabaseReadiness,
  runProviderCheck,
  type Logger,
  type ObjectStorage,
  type PlatformStores,
  type ProviderCreateContext,
  type ProviderDefinition,
  type ProviderEntry,
  type ProviderPort,
  type RegisteredProviderDefinition,
  type SecretResolver
} from "@vivd-catalyst/core";
import { mailProviderDefinitions } from "@vivd-catalyst/mail";
import { modelProviderDefinitions } from "@vivd-catalyst/model-provider";
import { objectStorageProviderDefinitions } from "@vivd-catalyst/object-storage";
import { sandboxProviderDefinitions } from "@vivd-catalyst/tool-execution";
import type { ClientInstanceEnv } from "./env";

/**
 * Secrets the platform's own code takes from the resolver, by fixed name. Provider credentials
 * are named in the `infrastructure` section instead.
 */
export const PLATFORM_SECRET_NAMES = {
  databaseUrl: "DATABASE_URL",
  standaloneAuthSecret: "BETTER_AUTH_SECRET",
  serviceAccessTokenSecret: "SERVICE_ACCESS_TOKEN_SECRET",
  chatSessionTokenSecret: "CHAT_SESSION_TOKEN_SECRET",
  chatServerCredential: "CHAT_SERVER_CREDENTIAL"
} as const;

/** Builds the instance's secret resolver. It is built first: everything else takes from it. */
export function createEnvironmentSecrets(env: ClientInstanceEnv): SecretResolver {
  return createEnvironmentSecretResolver({
    env,
    readSecretFile: (path) => readFile(path, "utf8")
  });
}

function secretProviderDefinitions(
  env: ClientInstanceEnv
): readonly ProviderDefinition<"secrets", SecretResolver>[] {
  return [
    defineProvider({
      port: "secrets",
      type: "environment",
      configSchema: z.object({}),
      external: false,
      create: () => createEnvironmentSecrets(env),
      // The environment of the process: there is nothing to reach.
      check: async () => ({ ok: true }),
      describe: () => ({})
    })
  ];
}

const SECRETS_PATH = "infrastructure.secrets";
export const WORKSPACE_STORE_PATH = "infrastructure.objectStorage.workspaces";
export const SANDBOX_PATH = "infrastructure.sandbox";

export interface InstanceInfrastructure {
  readonly registry: ProviderRegistry;
  readonly secrets: SecretResolver;
  /** What every provider is created with. */
  readonly context: ProviderCreateContext;
}

/**
 * Registers every provider, validates the `infrastructure` section against the chosen adapters'
 * schemas and builds the secret resolver. Nothing is reached here: a provider's secrets are
 * resolved when the provider is created, which startup does for every provider the process uses.
 */
export async function createInstanceInfrastructure(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  logger: Logger;
  /** Replaces the configured secret provider. For tests. */
  secrets?: SecretResolver;
  /** Providers that capabilities bring, such as their object store. */
  providers?: readonly RegisteredProviderDefinition[];
  /**
   * The entries this process creates providers from, by their path. Absent means the whole
   * section, which is what the chat server validates. A worker names its own entries: it does
   * not load the capabilities, so it cannot know a provider that only a capability registers.
   */
  uses?: readonly string[];
}): Promise<InstanceInfrastructure> {
  const secretDefinitions = secretProviderDefinitions(input.env);
  const registry = new ProviderRegistry([
    ...secretDefinitions,
    ...modelProviderDefinitions,
    ...mailProviderDefinitions,
    ...sandboxProviderDefinitions,
    ...objectStorageProviderDefinitions,
    ...(input.providers ?? [])
  ]);
  for (const { port, entry } of infrastructureEntries(input.config)) {
    if (!input.uses || entry.path === SECRETS_PATH || input.uses.includes(entry.path)) {
      registry.validate(port, entry);
    }
  }
  const secrets =
    input.secrets ??
    (await createProvider(
      secretDefinitions,
      "secrets",
      { path: SECRETS_PATH, entry: input.config.infrastructure.secrets },
      // The secret provider itself takes no secret.
      { secrets: createEnvironmentSecrets({}), logger: input.logger }
    ));
  return { registry, secrets, context: { secrets, logger: input.logger } };
}

/** Every configured entry of the section with its port and its place in the config. */
export function infrastructureEntries(
  config: Pick<ClientInstanceConfig, "infrastructure">
): { port: ProviderPort; entry: ProviderEntry }[] {
  const { secrets, models, mail, objectStorage, sandbox } = config.infrastructure;
  const single: [ProviderPort, string, unknown][] = [
    ["secrets", SECRETS_PATH, secrets],
    ["mail", "infrastructure.mail", mail],
    ["objectStorage", "infrastructure.objectStorage.files", objectStorage.files],
    ["objectStorage", WORKSPACE_STORE_PATH, objectStorage.workspaces],
    ["sandbox", SANDBOX_PATH, sandbox]
  ];
  return [
    ...single.flatMap(([port, path, entry]) =>
      entry === undefined ? [] : [{ port, entry: { path, entry } }]
    ),
    ...Object.entries(models).map(([name, entry]) => ({
      port: "models" as const,
      entry: { path: `infrastructure.models.${name}`, entry }
    }))
  ];
}

/**
 * The `workspaces` object store of an instance that runs execution workspaces. It holds the
 * workspace files, the source files and the preview images.
 */
export async function createWorkspacesStore(
  config: ClientInstanceConfig,
  context: ProviderCreateContext
): Promise<ObjectStorage> {
  return createProvider(
    objectStorageProviderDefinitions,
    "objectStorage",
    { path: WORKSPACE_STORE_PATH, entry: config.infrastructure.objectStorage.workspaces },
    context
  );
}

/** The command sandbox of an instance that runs execution workspaces. */
export async function createSandbox(
  config: ClientInstanceConfig,
  infrastructure: InstanceInfrastructure
) {
  return infrastructure.registry.create(
    "sandbox",
    { path: SANDBOX_PATH, entry: config.infrastructure.sandbox },
    infrastructure.context
  );
}

/**
 * The ports whose providers the API process uses itself, so it can ask them. The sandbox runs
 * in the workspace command worker, which alone reaches the Docker engine: asked from the API
 * it would read as down on an instance where it works.
 */
const PORTS_CHECKED_BY_THE_API: ReadonlySet<ProviderPort> = new Set([
  "secrets",
  "models",
  "mail",
  "objectStorage"
]);

/**
 * What Instance > Infrastructure lists: every configured entry of the section and the
 * database. Of an entry's config it takes the endpoint host and the bucket and nothing else,
 * so a path on the host, a limit or a setting an adapter adds later is not shown by default.
 */
export function infrastructureOverview(input: {
  config: Pick<ClientInstanceConfig, "infrastructure">;
  infrastructure: InstanceInfrastructure;
  stores: PlatformStores;
}): InfrastructureEntry[] {
  const { registry, context } = input.infrastructure;
  const database: InfrastructureEntry = {
    id: "database",
    class: "database",
    type: "postgres",
    origin: "operator",
    // Where the database runs is a deployment choice the product does not know.
    external: false,
    secrets: [{ name: PLATFORM_SECRET_NAMES.databaseUrl }],
    // Whether it answers. A database that answers and is behind its release is the matter of
    // `/ready`, not of this row.
    check: () =>
      runProviderCheck(async () => {
        const readiness = await readDatabaseReadiness(input.stores);
        return readiness.status === "not_ready" && readiness.reason === "database_unreachable"
          ? { ok: false, errorClass: "unreachable" }
          : { ok: true };
      })
  };
  return [
    database,
    ...infrastructureEntries(input.config).map(({ port, entry }) =>
      providerOverview(port, entry, registry, context)
    )
  ];
}

/**
 * What the page may show of a provider's description. A bucket reads as an S3 bucket name and a
 * host as a bare host with an optional port. A description that holds anything else there, such
 * as a signed address or a path, is a mistake in config or in an adapter: the value is withheld.
 */
const BUCKET_NAME = /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const BARE_HOST = new RegExp(
  `^(?:${HOST_LABEL}(?:\\.${HOST_LABEL})*|\\[[0-9a-f:.]{2,45}\\])(?::\\d{1,5})?$`,
  "iu"
);
const HOST_MAX_LENGTH = 259;
const SHOWN_FIELDS = {
  endpointHost: (value: string) => value.length <= HOST_MAX_LENGTH && BARE_HOST.test(value),
  bucket: (value: string) => BUCKET_NAME.test(value)
} as const;
type ShownField = keyof typeof SHOWN_FIELDS;

/** The fields of a description that may be shown, and the names of those that are withheld. */
function shownDescription(
  id: string,
  description: Record<string, unknown>,
  logger: Logger
): { shown: Partial<Record<ShownField, string>>; withheld: ShownField[] } {
  const shown: Partial<Record<ShownField, string>> = {};
  const withheld: ShownField[] = [];
  for (const field of ["endpointHost", "bucket"] as const) {
    const value = description[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" && SHOWN_FIELDS[field](value)) {
      shown[field] = value;
      continue;
    }
    withheld.push(field);
    // The value stays out of the line: it is what must not be repeated.
    logger.warn(
      { provider: id, field },
      "A config value of a provider is not shown on Instance > Infrastructure: it does not read as a bucket name or a bare host"
    );
  }
  return { shown, withheld };
}

function providerOverview<Port extends ProviderPort>(
  port: Port,
  entry: ProviderEntry,
  registry: ProviderRegistry,
  context: ProviderCreateContext
): InfrastructureEntry {
  const definition = registry.find(port, entry);
  const validated = definition.validate(entry);
  const id = entry.path.slice("infrastructure.".length);
  const name = id.includes(".") ? id.slice(id.indexOf(".") + 1) : undefined;
  const { shown, withheld } = shownDescription(id, validated.description, context.logger);
  // The provider the check asks is created at the first check and kept. It is one of its own:
  // creating it reaches nothing, and the one the product works with stays where it is.
  let created: ReturnType<typeof definition.create> | undefined;
  return {
    id,
    class: port,
    ...(name === undefined ? {} : { name }),
    type: validated.type,
    origin: "operator",
    external: validated.external,
    ...(validated.region ? { region: validated.region } : {}),
    ...shown,
    ...(withheld.length > 0 ? { withheld } : {}),
    secrets: validated.secrets.map((secret) => ({ name: secret.name, field: secret.field })),
    ...(PORTS_CHECKED_BY_THE_API.has(port)
      ? {
          // Creation resolves the provider's secrets, which can stall like the provider can:
          // it runs inside the same time as the check. A creation that has not ended is
          // waited for again by the next run and is not started a second time.
          check: () =>
            runProviderCheck(async () => {
              const creating = (created ??= definition.create(entry, context));
              let instance: Awaited<typeof creating>;
              try {
                instance = await creating;
              } catch {
                if (created === creating) {
                  created = undefined;
                }
                return { ok: false, errorClass: "failed" };
              }
              return definition.check(instance);
            })
        }
      : {})
  };
}

/** Every secret name the release config declares: the platform's own and each entry's. */
export function declaredSecretNames(
  config: Pick<ClientInstanceConfig, "infrastructure">,
  registry: ProviderRegistry
): Set<string> {
  return new Set([
    ...Object.values(PLATFORM_SECRET_NAMES),
    ...infrastructureEntries(config).flatMap(({ port, entry }) =>
      registry
        .find(port, entry)
        .validate(entry)
        .secrets.map((secret) => secret.name)
    )
  ]);
}

/** Instance > Infrastructure of an API process: the overview with the checks behind it. */
export function createInfrastructureWorkflow(
  config: Pick<ClientInstanceConfig, "infrastructure">,
  infrastructure: InstanceInfrastructure,
  stores: PlatformStores
): InfrastructureWorkflow {
  return new InfrastructureWorkflow({
    entries: infrastructureOverview({ config, infrastructure, stores }),
    declaredSecretNames: declaredSecretNames(config, infrastructure.registry),
    secrets: infrastructure.secrets,
    logger: infrastructure.context.logger
  });
}
