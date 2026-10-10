import {
  createPageBuildClient,
  createPageBundleJobs,
  deriveAppContentKey,
  type ChatServerOptions
} from "@vivd-catalyst/chat-server";
import {
  AppError,
  resolveOptionalSecret,
  type ClientInstanceId,
  type Logger,
  type ModuleSnapshot,
  type ObjectStorage,
  type PlatformStores,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import type { PageSaveToolOptions, WorkspaceCommandService } from "@vivd-catalyst/tool-execution";
import type { ClientInstanceEnv } from "./env";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
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
  if (!hasFilesStore) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'modules.apps.enabled' is true, but '${FILES_STORE_PATH}' is not configured. Pages keep their files there. Configure the store, or turn the module off`
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
      `'modules.apps.enabled' is true, but neither of the secrets ${APP_CONTENT_SECRET_NAMES.map((name) => `'${name}'`).join(" and ")} is set with at least ${APP_CONTENT_SECRET_MIN_CHARS} characters. The tokens that serve a Page are signed with a key derived from one of them`
    );
  }
  return {
    objects: await createFilesStore(input.config, input.infrastructure.context),
    contentKey: deriveAppContentKey(secret)
  };
}

/** What the instance builds Pages with: the tool that saves one and the job that builds it. */
export interface InstancePageBuilds {
  /** What `page.save` needs. Missing without Execution Workspaces: there is no folder to save. */
  tool?: PageSaveToolOptions;
  /** The handler of `page.bundle`, for the Agent Run worker. Empty with the module off. */
  handlers: RegisteredJobHandler[];
}

/**
 * The save tool and the build job of the `apps` module. The three settings are protective
 * limits of the worker's host, which only its operator knows: how many builds a worker process
 * runs at once, how long one may take and how much memory its process may use.
 */
export function createInstancePageBuilds(input: {
  modules: ModuleSnapshot;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  pages: ChatServerOptions["pages"];
  workspaceObjects: ObjectStorage | undefined;
  workspaceService: WorkspaceCommandService | undefined;
  env: ClientInstanceEnv;
  logger: Logger;
}): InstancePageBuilds {
  if (!input.modules.isEnabled("apps") || !input.pages) {
    return { handlers: [] };
  }
  const timeoutMs = readPositiveInteger("PAGE_BUILD_TIMEOUT_MS", input.env.PAGE_BUILD_TIMEOUT_MS);
  const maxHeapMb = readPositiveInteger("PAGE_BUILD_MAX_HEAP_MB", input.env.PAGE_BUILD_MAX_HEAP_MB);
  return {
    ...(input.workspaceService
      ? {
          tool: {
            workspace: input.workspaceService.dependencies,
            builds: createPageBuildClient({ stores: input.stores })
          }
        }
      : {}),
    handlers: createPageBundleJobs({
      clientInstanceId: input.clientInstanceId,
      stores: input.stores,
      pages: input.pages,
      workspaceObjects: input.workspaceObjects,
      logger: input.logger,
      slots: readPositiveInteger("PAGE_BUILD_CONCURRENCY", input.env.PAGE_BUILD_CONCURRENCY),
      limits: {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxHeapMb === undefined ? {} : { maxHeapMb })
      }
    }).handlers
  };
}

function readPositiveInteger(name: string, raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", `${name} must be a positive integer`);
  }
  return value;
}
