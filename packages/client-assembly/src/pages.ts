import { pageBuildCommandFile } from "@work-shape/catalyst-app-build";
import { assetRepoCommandFile } from "@work-shape/catalyst-asset-repo";
import {
  createAssetRepoJobs,
  createSandboxAssetRepo,
  createPageBuildClient,
  createPageBundleJobs,
  PAGE_BUILD_STALE_MS,
  removeStalePageBuilds,
  createSandboxPageBuild,
  deriveAppContentKey,
  type ChatServerOptions
} from "@work-shape/catalyst-server";
import {
  AppError,
  resolveOptionalSecret,
  type ClientInstanceId,
  type JobSchedule,
  type Logger,
  type ModuleSnapshot,
  type ObjectStorage,
  type PlatformStores,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import type {
  WorkspaceCommandProcessExecutor,
  WorkspaceCommandService,
  WorkspaceOpenToolOptions
} from "@work-shape/catalyst-tool-execution";
import type { ClientInstanceEnv } from "./env";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  createFilesStore,
  FILES_STORE_PATH,
  PLATFORM_SECRET_NAMES,
  type InstanceInfrastructure
} from "./infrastructure";

/**
 * The secrets the key of the content tokens is derived from, in the order they are tried. An
 * instance has at least one of them whenever people can sign in outside development.
 */
const APP_CONTENT_SECRET_NAMES = [
  PLATFORM_SECRET_NAMES.chatSessionTokenSecret,
  PLATFORM_SECRET_NAMES.standaloneAuthSecret
] as const;

/** The shortest secret a content key is derived from. */
const APP_CONTENT_SECRET_MIN_CHARS = 32;

/**
 * What the server stores and serves Pages with. With the `apps` module on, startup stops with
 * the missing piece named when the `files` store or a secret is absent. With the module off no
 * secret is read, and the `files` store, where the instance has one, is still handed on: a
 * conversation that is deleted takes the Pages of an earlier time with it.
 */
export async function createInstancePages(input: {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  infrastructure: InstanceInfrastructure;
}): Promise<ChatServerOptions["pages"]> {
  const hasFilesStore = input.config.infrastructure.objectStorage.files !== undefined;
  if (!input.modules.isEnabled("apps")) {
    return hasFilesStore
      ? { objects: await createFilesStore(input.config, input.infrastructure.context) }
      : undefined;
  }
  requireFilesStore(input.config);
  if (!input.config.executionWorkspaces.enabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "'modules.apps.enabled' is true, but 'executionWorkspaces.enabled' is not. An App is opened from a folder of an Execution Workspace and built in its sandbox by the workspace command worker. Enable Execution Workspaces and run that worker, or turn the module off"
    );
  }
  let secret: string | undefined;
  for (const name of APP_CONTENT_SECRET_NAMES) {
    secret = await resolveOptionalSecret(input.infrastructure.secrets, name);
    if (secret) {
      break;
    }
  }
  if (!secret || secret.length < APP_CONTENT_SECRET_MIN_CHARS) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'modules.apps.enabled' is true, but neither of the secrets ${APP_CONTENT_SECRET_NAMES.map((name) => `'${name}'`).join(" and ")} is set with at least ${APP_CONTENT_SECRET_MIN_CHARS} characters. The tokens that serve an App are signed with a key derived from one of them`
    );
  }
  return {
    objects: await createFilesStore(input.config, input.infrastructure.context),
    contentKey: deriveAppContentKey(secret)
  };
}

/**
 * What `workspace.open` needs, for the process that runs the tools. Nothing with the module off.
 */
export function createInstanceWorkspaceOpen(input: {
  modules: ModuleSnapshot;
  stores: PlatformStores;
  workspaceService: WorkspaceCommandService | undefined;
}): WorkspaceOpenToolOptions | undefined {
  if (!input.modules.isEnabled("apps") || !input.workspaceService) {
    return undefined;
  }
  return {
    workspace: input.workspaceService.dependencies,
    builds: createPageBuildClient({ stores: input.stores })
  };
}

/**
 * The handler of `page.bundle`, for the workspace command worker: the one process that reaches
 * the sandbox. Nothing with the module off. The two settings are protective limits of the
 * sandbox's host, which only its operator knows: how many builds a worker process runs at once
 * and how long one may take.
 */
export async function createInstancePageBuildJobs(input: {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  infrastructure: InstanceInfrastructure;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  workspaceObjects: ObjectStorage;
  sandbox: WorkspaceCommandProcessExecutor;
  tempRoot: string;
  env: ClientInstanceEnv;
  logger: Logger;
}): Promise<RegisteredJobHandler[]> {
  if (!input.modules.isEnabled("apps")) {
    return [];
  }
  const timeoutMs = readPositiveInteger("PAGE_BUILD_TIMEOUT_MS", input.env.PAGE_BUILD_TIMEOUT_MS);
  // What a worker that was killed left of its builds is removed when a worker starts; the
  // builds themselves repeat the sweep. The start does not wait for it.
  removeStalePageBuilds({
    sandbox: input.sandbox,
    tempRoot: input.tempRoot,
    olderThanMs: Math.max(PAGE_BUILD_STALE_MS, 2 * (timeoutMs ?? 0))
  })
    .then((removed) => {
      if (removed.directories > 0 || removed.containers > 0) {
        input.logger.info(removed, "Removed what a stopped worker left of its Page builds");
      }
    })
    .catch(() => undefined);
  return createPageBundleJobs({
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    pages: { objects: await createFilesStore(input.config, input.infrastructure.context) },
    workspaceObjects: input.workspaceObjects,
    logger: input.logger,
    slots: readPositiveInteger("PAGE_BUILD_CONCURRENCY", input.env.PAGE_BUILD_CONCURRENCY),
    ...(timeoutMs === undefined ? {} : { limits: { timeoutMs } }),
    build: createSandboxPageBuild({
      sandbox: input.sandbox,
      tempRoot: input.tempRoot,
      // The local sandbox runs commands as processes of this worker, on a machine that has no
      // runner image: the command is the script of this checkout. Config validation keeps that
      // sandbox to development instances.
      ...(input.config.infrastructure.sandbox?.provider === "local"
        ? { command: `'${process.execPath}' '${pageBuildCommandFile()}'` }
        : {})
    })
  }).handlers;
}

/**
 * The handlers of `asset_repo.commit` and `asset_repo.sweep` and the schedule of the sweep, for
 * the workspace command worker: the one process that reaches the sandbox, where git runs.
 * Nothing with the module off.
 */
export async function createInstanceAssetRepoJobs(input: {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  infrastructure: InstanceInfrastructure;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  workspaceObjects: ObjectStorage;
  sandbox: WorkspaceCommandProcessExecutor;
  tempRoot: string;
  logger: Logger;
}): Promise<{ handlers: RegisteredJobHandler[]; schedules: JobSchedule[] }> {
  if (!input.modules.isEnabled("apps")) {
    return { handlers: [], schedules: [] };
  }
  return createAssetRepoJobs({
    clientInstanceId: input.clientInstanceId,
    stores: input.stores,
    objects: await createFilesStore(input.config, input.infrastructure.context),
    workspaceObjects: input.workspaceObjects,
    logger: input.logger,
    commit: createSandboxAssetRepo({
      sandbox: input.sandbox,
      tempRoot: input.tempRoot,
      // As for a Page build: the local sandbox has no runner image, so the command is the
      // script of this checkout and runs the git of the machine.
      ...(input.config.infrastructure.sandbox?.provider === "local"
        ? { command: `'${process.execPath}' '${assetRepoCommandFile()}'` }
        : {})
    })
  });
}

function readPositiveInteger(name: string, raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", `${name} must be a positive integer`);
  }
  return value;
}

/** Stops an instance with the `apps` module on that has no `files` store. */
export function requireFilesStore(config: ClientInstanceConfig): void {
  if (config.infrastructure.objectStorage.files === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'modules.apps.enabled' is true, but '${FILES_STORE_PATH}' is not configured. Pages keep their files there. Configure the store, or turn the module off`
    );
  }
}
