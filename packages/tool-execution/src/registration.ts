import type { ProviderDefinition } from "@vivd-catalyst/core";
import { dockerSandboxProvider } from "./adapters/docker-sandbox";
import { filesystemWorkspaceStoreProvider } from "./adapters/filesystem-workspace-store";
import { localSandboxProvider } from "./adapters/local-sandbox";
import type { WorkspaceCommandProcessExecutor } from "./workspace-command-executor";
import type { ConfiguredWorkspaceStore } from "./workspace-file-bytes";

/** Every sandbox adapter of this package. */
export const sandboxProviderDefinitions: readonly ProviderDefinition<
  "sandbox",
  WorkspaceCommandProcessExecutor
>[] = [dockerSandboxProvider, localSandboxProvider];

/** Every adapter of this package that can serve the `workspaces` object store. */
export const workspaceObjectStoreDefinitions: readonly ProviderDefinition<
  "objectStorage",
  ConfiguredWorkspaceStore
>[] = [filesystemWorkspaceStoreProvider];
