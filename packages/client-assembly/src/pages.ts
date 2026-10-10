import { deriveAppContentKey, type ChatServerOptions } from "@vivd-catalyst/chat-server";
import { AppError, resolveOptionalSecret, type ModuleSnapshot } from "@vivd-catalyst/core";
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
 * What the server stores and serves Pages with. Present when the `apps` module is on, and then
 * startup stops with the missing piece named when the `files` store or a secret is absent. With
 * the module off nothing is created and no secret is read.
 */
export async function createInstancePages(input: {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  infrastructure: InstanceInfrastructure;
}): Promise<ChatServerOptions["pages"]> {
  if (!input.modules.isEnabled("apps")) {
    return undefined;
  }
  if (!input.config.infrastructure.objectStorage.files) {
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
