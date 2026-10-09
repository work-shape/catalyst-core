/**
 * The claim queries and interval timers that predate the job executor, each with the ticket
 * that removes it. `within` is the function or method that holds the occurrence and `count`
 * how many it holds. One more in the same function, or one anywhere else, is a finding. The
 * list only shrinks.
 * @type {{ file: string, within: string, count: number, removedBy: string }[]}
 */
export const leaseExemptions = [
  // The agent run lease: CB-7b.
  {
    file: "packages/postgres-store/src/postgres-agent-run-worker-operations.ts",
    within: "claimNextAgentRun",
    count: 1,
    removedBy: "CB-7b"
  },
  {
    file: "packages/postgres-store/src/postgres-agent-run-worker-operations.ts",
    within: "recoverExpiredAgentRuns",
    count: 1,
    removedBy: "CB-7b"
  },
  // Heartbeat and cancellation timers.
  {
    file: "packages/agent-runtime/src/agent-run-worker.ts",
    within: "runClaimed",
    count: 2,
    removedBy: "CB-7b"
  },
  // The workspace command lease: CB-7c.
  {
    file: "packages/postgres-store/src/postgres-execution-workspace-operations.ts",
    within: "claimNextWorkspaceCommand",
    count: 1,
    removedBy: "CB-7c"
  },
  {
    file: "packages/postgres-store/src/postgres-execution-workspace-operations.ts",
    within: "recoverStaleWorkspaceCommands",
    count: 1,
    removedBy: "CB-7c"
  },
  // Heartbeat and cancellation timers.
  {
    file: "packages/tool-execution/src/workspace-command-worker.ts",
    within: "runClaimedCommand",
    count: 2,
    removedBy: "CB-7c"
  }
];

/**
 * Interval timers that are not jobs and stay: each keeps state of one process, which a job in
 * the database could not reach. `within` is the function that holds the timer. An entry needs
 * the reason; a timer that does work for the instance is a schedule on the job executor.
 * @type {{ file: string, within: string, count: number, why: string }[]}
 */
export const processLocalTimers = [
  {
    file: "packages/chat-server/src/http/rate-limit.ts",
    within: "count",
    count: 1,
    why: "removes the rate limiter's run-out counters from this process's memory"
  }
];
