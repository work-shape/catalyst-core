import type { CatalogueEntry } from "@work-shape/catalyst-connections";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type {
  ConnectorTypeDefinition,
  StructuredDataPublicationReviewer
} from "@work-shape/catalyst-core";
import type { ToolAssemblyDefinition } from "@work-shape/catalyst-tool-sdk";
import {
  createClientInstanceApp,
  type ClientInstanceApp,
  type CreateClientInstanceAppInput
} from "./app";
import type { ClientInstanceCapability } from "./capabilities";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import {
  createClientInstanceAgentRunWorker,
  runClientInstanceAgentRunWorker,
  type ClientInstanceAgentRunWorker,
  type CreateClientInstanceAgentRunWorkerInput
} from "./agent-run-worker";
import {
  seedStandaloneAuth as seedStandaloneAuthCommand,
  type SeedStandaloneAuthInput,
  type SeedStandaloneAuthResult
} from "./seed-auth";
import { migrateClientInstanceDatabase } from "./migrate";
import {
  runClientInstanceWorkspaceCommandWorker,
  type CreateClientInstanceWorkspaceCommandWorkerInput
} from "./workspace-command-worker";
import {
  runClientInstanceArtifactPreviewWorker,
  type CreateClientInstanceArtifactPreviewWorkerInput
} from "./artifact-preview-worker";

import {
  createClientInstanceKnowledgeWorker,
  runClientInstanceKnowledgeWorker,
  type ClientInstanceKnowledgeWorker,
  type CreateClientInstanceKnowledgeWorkerInput
} from "./knowledge-worker";

/** What a caller still gives a process of this instance: the build and the config path are its own. */
type OfThisBuild<Input> = Omit<
  Input,
  "configPath" | "tools" | "connectorTypes" | "catalogue" | "capabilities"
> & { configPath?: string };

export interface DefineClientInstanceInput {
  rootDir: string | URL;
  workspaceRoot?: string | URL;
  configFile?: string;
  tools?: ToolAssemblyDefinition[];
  /**
   * The Connector types of this build. Every process of the instance gets the same ones: the
   * API, which seeds and manages Connections, and the worker, whose agents call them.
   */
  connectorTypes?: ConnectorTypeDefinition[];
  /**
   * The catalogue entries this build ships, such as `loadCatalogueEntries(directory)` of the
   * capabilities repo and the deployment's own. Release config's `catalogue.entries` names
   * which of them the instance offers.
   */
  catalogue?: readonly CatalogueEntry[];
  capabilities?: ClientInstanceCapability[];
  structuredDataPublicationReviewer?: StructuredDataPublicationReviewer;
  allowedOrigins?: string | string[];
  loadEnv?: boolean;
  /** Where the Agent Runs execute. `separate` when the deployment runs `runAgentRunWorker`. */
  agentRunWorker?: CreateClientInstanceAppInput["agentRunWorker"];
  knowledgeWorker?: CreateClientInstanceAppInput["knowledgeWorker"];
}

export interface DefinedClientInstance {
  readonly clientRoot: string;
  readonly workspaceRoot: string;
  loadEnvironment(input?: { env?: ClientInstanceEnv }): ClientInstanceEnv;
  resolveConfigPath(input?: { env?: ClientInstanceEnv; configPath?: string }): string;
  createApp(input?: OfThisBuild<CreateClientInstanceAppInput>): Promise<ClientInstanceApp>;
  listen(input?: {
    env?: ClientInstanceEnv;
    host?: string;
    port?: number;
    configPath?: string;
    allowedOrigins?: string | string[];
    /** What the calls of operations run with beyond the instance's own defaults. For tests. */
    operations?: CreateClientInstanceAppInput["operations"];
  }): Promise<ClientInstanceApp>;
  createKnowledgeWorker(
    input?: OfThisBuild<CreateClientInstanceKnowledgeWorkerInput>
  ): Promise<ClientInstanceKnowledgeWorker>;
  runKnowledgeWorker(input?: OfThisBuild<CreateClientInstanceKnowledgeWorkerInput>): Promise<void>;
  createAgentRunWorker(
    input?: OfThisBuild<CreateClientInstanceAgentRunWorkerInput>
  ): Promise<ClientInstanceAgentRunWorker>;
  runAgentRunWorker(input?: OfThisBuild<CreateClientInstanceAgentRunWorkerInput>): Promise<void>;
  /** Runs the workspace command worker of this build until the process is told to stop. */
  runWorkspaceCommandWorker(
    input?: OfThisBuild<CreateClientInstanceWorkspaceCommandWorkerInput>
  ): Promise<void>;
  /** Runs the artifact preview worker of this build until the process is told to stop. */
  runArtifactPreviewWorker(
    input?: OfThisBuild<CreateClientInstanceArtifactPreviewWorkerInput>
  ): Promise<void>;
  seedStandaloneAuth(
    input?: Omit<SeedStandaloneAuthInput, "configPath"> & {
      configPath?: string;
    }
  ): Promise<SeedStandaloneAuthResult>;
  /** Applies the committed migrations to the instance database and returns the names applied. */
  migrate(input?: { env?: ClientInstanceEnv }): Promise<string[]>;
}

export function defineClientInstance(input: DefineClientInstanceInput): DefinedClientInstance {
  const clientRoot = resolve(toPath(input.rootDir));
  const workspaceRoot = resolve(toPath(input.workspaceRoot ?? resolve(clientRoot, "../..")));
  // What the build is made of. One object, so no process of the instance is assembled from
  // less than another.
  const build = {
    tools: input.tools ?? [],
    connectorTypes: input.connectorTypes ?? [],
    catalogue: input.catalogue ?? [],
    capabilities: input.capabilities ?? []
  };

  function loadEnvironment(loadInput: { env?: ClientInstanceEnv } = {}): ClientInstanceEnv {
    const env = readClientInstanceEnv(loadInput.env);
    if (!loadInput.env && input.loadEnv !== false) {
      const explicitEnvironment = snapshotEnvironment(env);
      loadDotenv({ path: resolve(workspaceRoot, ".env"), quiet: true });
      loadDotenv({ path: resolve(clientRoot, ".env"), override: true, quiet: true });
      restoreEnvironment(env, explicitEnvironment);
    }
    return env;
  }

  function resolveConfigPath(
    resolveInput: {
      env?: ClientInstanceEnv;
      configPath?: string;
    } = {}
  ): string {
    const env = readClientInstanceEnv(resolveInput.env);
    const configuredPath =
      resolveInput.configPath ?? env.CLIENT_CONFIG_PATH ?? input.configFile ?? "config/app.yaml";
    if (isAbsolute(configuredPath)) {
      return configuredPath;
    }

    const workspacePath = resolve(workspaceRoot, configuredPath);
    if (existsSync(workspacePath)) {
      return workspacePath;
    }
    return resolve(clientRoot, configuredPath);
  }

  async function createApp(
    appInput: OfThisBuild<CreateClientInstanceAppInput> = {}
  ): Promise<ClientInstanceApp> {
    const env = loadEnvironment({ env: appInput.env });
    return createClientInstanceApp({
      ...appInput,
      env,
      configPath: resolveConfigPath({
        env,
        configPath: appInput.configPath
      }),
      ...build,
      structuredDataPublicationReviewer:
        appInput.structuredDataPublicationReviewer ?? input.structuredDataPublicationReviewer,
      allowedOrigins:
        appInput.allowedOrigins === undefined ? input.allowedOrigins : appInput.allowedOrigins,
      agentRunWorker: appInput.agentRunWorker ?? input.agentRunWorker,
      knowledgeWorker: appInput.knowledgeWorker ?? input.knowledgeWorker
    });
  }

  /** The environment and the config path every process of this instance starts from. */
  function located<Input extends { env?: ClientInstanceEnv; configPath?: string }>(
    processInput: Input
  ): Input & { env: ClientInstanceEnv; configPath: string } {
    const env = loadEnvironment({ env: processInput.env });
    return {
      ...processInput,
      env,
      configPath: resolveConfigPath({ env, configPath: processInput.configPath })
    };
  }

  function resolveAgentWorkerInput(
    workerInput: OfThisBuild<CreateClientInstanceAgentRunWorkerInput>
  ): CreateClientInstanceAgentRunWorkerInput {
    return {
      ...located(workerInput),
      ...build,
      structuredDataPublicationReviewer:
        workerInput.structuredDataPublicationReviewer ?? input.structuredDataPublicationReviewer
    };
  }

  return {
    clientRoot,
    workspaceRoot,
    loadEnvironment,
    resolveConfigPath,
    createApp,
    createKnowledgeWorker(workerInput = {}) {
      return createClientInstanceKnowledgeWorker({
        ...resolveAgentWorkerInput(workerInput),
        knowledgeWorker: input.knowledgeWorker
      });
    },
    runKnowledgeWorker(workerInput = {}) {
      return runClientInstanceKnowledgeWorker({
        ...resolveAgentWorkerInput(workerInput),
        knowledgeWorker: input.knowledgeWorker
      });
    },
    createAgentRunWorker(workerInput = {}) {
      return createClientInstanceAgentRunWorker(resolveAgentWorkerInput(workerInput));
    },
    runAgentRunWorker(workerInput = {}) {
      return runClientInstanceAgentRunWorker(resolveAgentWorkerInput(workerInput));
    },
    runWorkspaceCommandWorker(workerInput = {}) {
      return runClientInstanceWorkspaceCommandWorker({
        ...located(workerInput),
        capabilities: build.capabilities
      });
    },
    runArtifactPreviewWorker(workerInput = {}) {
      return runClientInstanceArtifactPreviewWorker({
        ...located(workerInput),
        capabilities: build.capabilities
      });
    },
    async listen(listenInput = {}) {
      const app = await createApp({
        env: listenInput.env,
        configPath: listenInput.configPath,
        allowedOrigins: listenInput.allowedOrigins,
        operations: listenInput.operations
      });
      await app.listen({
        host: listenInput.host,
        port: listenInput.port
      });
      registerShutdownHandlers(app);
      return app;
    },
    async seedStandaloneAuth(seedInput = {}) {
      const env = loadEnvironment({ env: seedInput.env });
      return seedStandaloneAuthCommand({
        ...seedInput,
        env,
        configPath: resolveConfigPath({
          env,
          configPath: seedInput.configPath
        }),
        allowedOrigins:
          seedInput.allowedOrigins === undefined ? input.allowedOrigins : seedInput.allowedOrigins
      });
    },
    async migrate(migrateInput = {}) {
      return migrateClientInstanceDatabase({ env: loadEnvironment({ env: migrateInput.env }) });
    }
  };
}

function toPath(value: string | URL): string {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }
  if (value.startsWith("file:")) {
    return fileURLToPath(new URL(value));
  }
  return value;
}

function snapshotEnvironment(env: ClientInstanceEnv): Map<string, string> {
  return new Map(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function restoreEnvironment(env: ClientInstanceEnv, snapshot: Map<string, string>): void {
  for (const [key, value] of snapshot) {
    env[key] = value;
  }
}

function registerShutdownHandlers(app: ClientInstanceApp): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
}
