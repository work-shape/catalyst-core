import { useEffect, useState } from "react";
import { AppCallError, workflowRuns } from "./client";
import type { AppWorkflowRun } from "./protocol";

// Following a Workflow Run that an action of the Page started. The interface pushes nothing
// yet, so the Page asks again while the run is not over.

/** How long a Page waits between two reads of a run that is not over. */
const WORKFLOW_RUN_POLL_MS = 1_000;

/** The states after which a run changes no more. */
const ENDED: readonly AppWorkflowRun["status"][] = ["done", "failed", "cancelled", "limit_reached"];

/** Whether a run is over: it changes no more, and its result or its error is there. */
export function workflowRunEnded(run: AppWorkflowRun): boolean {
  return ENDED.includes(run.status);
}

/** A Workflow Run as a Page follows it: the run as it stood at the last read, or why none. */
export interface FollowedWorkflowRun {
  run?: AppWorkflowRun;
  /** Why the run could not be read. Show its message as it is. */
  error?: AppCallError;
}

/**
 * The Workflow Run of `runId` as it stands, read again every second until it is over. Give it
 * the `id` of the run an action answered; without one it reads nothing.
 *
 * ```tsx
 * const [runId, setRunId] = useState<string>();
 * const { run } = useWorkflowRun(runId);
 * // actions.call("log-visit", { page }).then((answer) => setRunId(answer.result.id))
 * ```
 */
export function useWorkflowRun(runId: string | undefined): FollowedWorkflowRun {
  const [followed, setFollowed] = useState<FollowedWorkflowRun & { runId?: string }>({});
  useEffect(() => {
    if (runId === undefined) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      workflowRuns.get(runId).then(
        (run) => {
          if (stopped) return;
          setFollowed({ runId, run });
          if (!workflowRunEnded(run)) timer = setTimeout(read, WORKFLOW_RUN_POLL_MS);
        },
        (error: unknown) => {
          if (stopped) return;
          setFollowed({
            runId,
            error:
              error instanceof AppCallError
                ? error
                : new AppCallError({ code: "failed", message: "The run could not be read." })
          });
        }
      );
    };
    read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId]);
  // What was read of another run is not this run's.
  return followed.runId === runId && runId !== undefined
    ? {
        ...(followed.run ? { run: followed.run } : {}),
        ...(followed.error ? { error: followed.error } : {})
      }
    : {};
}
