import { join } from "node:path";
import {
  DockerWorkspaceCommandProcessExecutor,
  resolveRunnerUser,
  RUNNER_GROUP_ID,
  RUNNER_USER_ID,
  type ProcessResult,
  type RunnerUser
} from "@vivd-catalyst/tool-execution";

/**
 * The container sandbox as a deployment configures it, for the tests that need a Docker engine
 * and a runner image. `user` is who a command must be: the runner's fixed user where the test
 * is root, as the worker of a deployment is, and the test's own user anywhere else.
 */
export function runnerContainer(image: string): {
  executor: DockerWorkspaceCommandProcessExecutor;
  user: RunnerUser;
  /** Runs shell text with `directory` as the workspace and rejects unless it ends with 0. */
  run(directory: string, command: string): Promise<ProcessResult>;
} {
  const executor = new DockerWorkspaceCommandProcessExecutor({
    image,
    networkMode: "none",
    readOnlyRootFilesystem: true
  });
  const user = resolveRunnerUser();
  if (process.getuid?.() === 0 && (user.uid !== RUNNER_USER_ID || user.gid !== RUNNER_GROUP_ID)) {
    throw new Error("A worker that is root must run commands as the runner's fixed user.");
  }
  let step = 0;
  return {
    executor,
    user,
    async run(directory, command) {
      step += 1;
      const result = await executor.execute({
        command: { id: `runner-container-${step}`, command, limits: { timeoutSeconds: 180 } },
        workspaceDirectory: directory,
        workspaceCwd: ".",
        cwd: directory,
        tempDirectory: join(directory, "tmp"),
        env: {}
      });
      if (result.exitCode !== 0 || result.spawnError) {
        throw new Error(
          `'${command.split("\n")[0]}' ended with ${result.exitCode}: ${result.spawnError?.message ?? ""}\n${result.stdoutPreview}\n${result.stderrPreview}`
        );
      }
      return result;
    }
  };
}
