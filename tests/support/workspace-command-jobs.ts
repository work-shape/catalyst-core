import type { ClientInstanceId, JobWorker, Logger, PlatformStores } from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import {
  createWorkspaceCommandJobs,
  type WorkspaceCommandJobsOptions,
  type WorkspaceCommandResultSource
} from "@vivd-catalyst/tool-execution";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

export type CommandWorkerOptions = Omit<WorkspaceCommandJobsOptions, "stores">;

/**
 * The command worker as its process assembles it: the job worker of the executor with the
 * `workspace.command` handler. Without `schedules` it serves commands only. The caller stops it.
 */
export function createCommandWorker(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  options: CommandWorkerOptions & { schedules?: boolean }
): JobWorker {
  const { schedules, ...jobOptions } = options;
  const jobs = createWorkspaceCommandJobs({ stores, ...jobOptions });
  return createPostgresJobWorker({
    stores,
    clientInstanceId,
    handlers: jobs.handlers,
    schedules: schedules ? jobs.schedules : [],
    logger: silent
  });
}

/** One pass of a command worker: runs the commands that are queued now, to their end. */
export async function runQueuedCommands(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  options: CommandWorkerOptions
): Promise<void> {
  const worker = createCommandWorker(stores, clientInstanceId, options);
  try {
    await worker.runDue();
  } finally {
    await worker.stop();
  }
}

/** Lets `workspace.exec` run its command in the test's process before it waits for the result. */
export function inlineCommandResults(
  stores: PlatformStores,
  options: CommandWorkerOptions
): WorkspaceCommandResultSource {
  return {
    async resolveWorkspaceCommand({ command }) {
      await runQueuedCommands(stores, command.clientInstanceId, options);
      return stores.executionWorkspaces.getWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id
      });
    }
  };
}
