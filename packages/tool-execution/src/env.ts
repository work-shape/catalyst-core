import { DEFAULT_WORKSPACE_COMMAND_PATH } from "./workspace-command-executor";

export const WORKSPACE_COMMAND_PATH_ENV_NAME = "PATH";

export function readToolExecutionEnv(): { path: string } {
  return { path: process.env[WORKSPACE_COMMAND_PATH_ENV_NAME] ?? DEFAULT_WORKSPACE_COMMAND_PATH };
}
