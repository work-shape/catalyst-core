import { DEFAULT_WORKSPACE_COMMAND_PATH } from "./workspace-command-executor";

export function readToolExecutionEnv(): { path: string } {
  return { path: process.env.PATH ?? DEFAULT_WORKSPACE_COMMAND_PATH };
}
