import { z } from "zod";
import { defineProvider } from "@vivd-catalyst/core";
import {
  LocalWorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessExecutor
} from "../workspace-command-executor";

/** Runs commands as processes of the worker itself. Config validation keeps it to development. */
export const localSandboxProvider = defineProvider({
  port: "sandbox",
  type: "local",
  configSchema: z.object({}),
  external: false,
  create(): WorkspaceCommandProcessExecutor {
    return new LocalWorkspaceCommandProcessExecutor();
  },
  describe() {
    return {};
  }
});
