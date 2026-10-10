import {
  type EnqueueWorkspaceCommandInput,
  type ISODateString,
  type WorkspaceCommand,
  type WorkspaceCommandStore,
  isAppError
} from "@vivd-catalyst/core";

const DEFAULT_RESULT_POLL_INTERVAL_MS = 500;

/** A command to queue. The client sets the time it was queued. */
export type WorkspaceCommandRequest = Omit<EnqueueWorkspaceCommandInput, "queuedAt">;

/** A queued command as its caller last saw it. */
export interface WorkspaceCommandHandle {
  readonly command: WorkspaceCommand;
}

export interface WorkspaceCommandWait {
  /** Aborting cancels the command. */
  signal?: AbortSignal;
  /** Passing it cancels the command. */
  deadline?: Date;
}

/**
 * How a wait ended. `settled` carries the command as it stands: finished, or still open when the
 * client is set not to wait. The other outcomes say why the wait gave up; for `cancelled`,
 * `timed_out` and `wait_limit` the client has asked for cancellation and `command` is the row
 * after that request.
 */
export type WorkspaceCommandResult =
  | { status: "settled"; command: WorkspaceCommand }
  | { status: "missing" }
  | { status: "cancelled" | "timed_out"; reason: string; command: WorkspaceCommand }
  | { status: "wait_limit"; reason: string; command: WorkspaceCommand; waitMs?: number };

/**
 * The one way to queue a workspace command and to wait for its result. The tools know nothing of
 * the queue behind it.
 */
export interface WorkspaceCommandClient {
  /** Queues the command. A workspace that cannot take it rejects with a `CONFLICT` AppError. */
  enqueue(command: WorkspaceCommandRequest): Promise<WorkspaceCommandHandle>;
  await(
    handle: WorkspaceCommandHandle,
    wait: WorkspaceCommandWait
  ): Promise<WorkspaceCommandResult>;
}

export interface WorkspaceCommandClientOptions {
  store: Pick<
    WorkspaceCommandStore,
    "enqueueWorkspaceCommand" | "getWorkspaceCommand" | "requestWorkspaceCommandCancellation"
  >;
  /** The longest wait for a result. Zero or less returns at once; unset waits without a limit. */
  resultWaitMs?: number;
  resultPollIntervalMs?: number;
  now: () => ISODateString;
}

/** Queues commands in the workspace command table and polls it for the result. */
export function createWorkspaceCommandClient(
  options: WorkspaceCommandClientOptions
): WorkspaceCommandClient {
  const { store, resultWaitMs, now } = options;
  const resultPollIntervalMs = options.resultPollIntervalMs ?? DEFAULT_RESULT_POLL_INTERVAL_MS;

  async function requestCommandCancellation(
    command: WorkspaceCommand,
    reason: string
  ): Promise<WorkspaceCommand> {
    try {
      return await store.requestWorkspaceCommandCancellation({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id,
        reason,
        requestedAt: now()
      });
    } catch (error) {
      if (isAppError(error) && error.code === "CONFLICT") {
        const latest = await store.getWorkspaceCommand({
          clientInstanceId: command.clientInstanceId,
          commandId: command.id
        });
        if (latest && isTerminalWorkspaceCommand(latest)) {
          return latest;
        }
      }
      throw error;
    }
  }

  async function cancelWaitingCommand(
    command: WorkspaceCommand,
    reason: string,
    resultStatus: "cancelled" | "timed_out"
  ): Promise<WorkspaceCommandResult> {
    const cancelled = await requestCommandCancellation(command, reason);
    if (cancelled.status === "completed" || cancelled.status === "failed") {
      return { status: "settled", command: cancelled };
    }
    return { status: resultStatus, reason, command: cancelled };
  }

  return {
    async enqueue(command) {
      return {
        command: await store.enqueueWorkspaceCommand({ ...command, queuedAt: now() })
      };
    },

    async await({ command }, wait) {
      if (isTerminalWorkspaceCommand(command)) {
        return { status: "settled", command };
      }

      if (resultWaitMs !== undefined && resultWaitMs <= 0) {
        return { status: "settled", command };
      }

      const waitDeadlineMs = resultWaitMs === undefined ? undefined : Date.now() + resultWaitMs;
      const contextDeadlineMs = wait.deadline?.getTime();
      let current = command;
      while (true) {
        if (wait.signal?.aborted) {
          return cancelWaitingCommand(
            command,
            "Workspace command was cancelled with its agent run",
            "cancelled"
          );
        }
        if (contextDeadlineMs !== undefined && Date.now() >= contextDeadlineMs) {
          return cancelWaitingCommand(
            command,
            "Workspace command exceeded the tool execution deadline",
            "timed_out"
          );
        }
        if (waitDeadlineMs !== undefined && Date.now() >= waitDeadlineMs) {
          break;
        }
        const nextDeadlineMs = earliestDefined(waitDeadlineMs, contextDeadlineMs);
        await sleep(
          nextDeadlineMs === undefined
            ? resultPollIntervalMs
            : Math.min(resultPollIntervalMs, Math.max(1, nextDeadlineMs - Date.now())),
          wait.signal
        );
        if (wait.signal?.aborted) {
          continue;
        }
        const latest = await store.getWorkspaceCommand({
          clientInstanceId: command.clientInstanceId,
          commandId: command.id
        });
        if (!latest) {
          return { status: "missing" };
        }
        current = latest;
        if (isTerminalWorkspaceCommand(current)) {
          return { status: "settled", command: current };
        }
      }

      const reason = "Workspace command did not complete before the tool wait limit";
      const cancelled = await requestCommandCancellation(command, reason);
      if (cancelled.status === "completed" || cancelled.status === "failed") {
        return { status: "settled", command: cancelled };
      }
      return {
        status: "wait_limit",
        reason,
        command: cancelled,
        ...(resultWaitMs !== undefined ? { waitMs: resultWaitMs } : {})
      };
    }
  };
}

function isTerminalWorkspaceCommand(command: WorkspaceCommand): boolean {
  return (
    command.status === "completed" || command.status === "failed" || command.status === "cancelled"
  );
}

function earliestDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
