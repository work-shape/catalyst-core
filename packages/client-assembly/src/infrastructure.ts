import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createEnvironmentSecretResolver,
  createProvider,
  defineProvider,
  ProviderRegistry,
  type Logger,
  type ObjectStorage,
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
