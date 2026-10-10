import type { ProviderDefinition } from "@vivd-catalyst/core";
import { dockerSandboxProvider } from "./adapters/docker-sandbox";
import { localSandboxProvider } from "./adapters/local-sandbox";
import type { WorkspaceCommandProcessExecutor } from "./workspace-command-executor";

/** Every sandbox adapter of this package. */
export const sandboxProviderDefinitions: readonly ProviderDefinition<
  "sandbox",
  WorkspaceCommandProcessExecutor
>[] = [dockerSandboxProvider, localSandboxProvider];
