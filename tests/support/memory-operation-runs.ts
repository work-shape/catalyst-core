import {
  INTERRUPTED_RUN_ERROR,
  type OperationRun,
  type OperationRunStore
} from "@work-shape/catalyst-core";

/**
 * The run store for tests of the call path that need no database: it keeps the runs of one
 * test in a list. It follows the rules of the Postgres store that the call path relies on, and
 * the tests of that store are the proof of those rules.
 */
export function createMemoryOperationRunStore(): OperationRunStore & { runs: OperationRun[] } {
  const runs: OperationRun[] = [];
  const find = (clientInstanceId: string, id: string) =>
    runs.find((run) => run.clientInstanceId === clientInstanceId && run.id === id);
  const replace = (run: OperationRun, change: Partial<OperationRun>): OperationRun => {
    const next = { ...run, ...change };
    runs[runs.indexOf(run)] = next;
    return next;
  };
  // The moments calls took their places within their operation's limits, by run id.
  const places = new Map<string, number>();
  return {
    runs,
    admitWithinLimits({ clientInstanceId, id, operation, at, windows }) {
      const now = Date.parse(at);
      // This store knows no Workflow runs, so a window of one Workflow counts every call.
      for (const [index, window] of windows.entries()) {
        const held = runs
          .filter(
            (run) =>
              run.clientInstanceId === clientInstanceId &&
              run.operation === operation &&
              run.target === "live" &&
              run.id !== id &&
              !(run.status === "failed" && run.error?.unexecuted === true)
          )
          .map((run) => places.get(run.id))
          .filter(
            (place): place is number => place !== undefined && place > now - window.seconds * 1000
          )
          .sort((a, b) => a - b);
        if (held.length < window.calls) continue;
        const taken = held[held.length - window.calls] ?? now;
        return Promise.resolve({
          admitted: false as const,
          window: index,
          roomAt: new Date(taken + window.seconds * 1000).toISOString()
        });
      }
      if (find(clientInstanceId, id)?.status !== "running")
        return Promise.reject(new Error(`Operation run '${id}' is not running`));
      places.set(id, now);
      return Promise.resolve({ admitted: true as const });
    },
    checkpointReading({ clientInstanceId, id, ...counts }) {
      const run = find(clientInstanceId, id);
      if (
        !run ||
        run.status !== "running" ||
        run.effect !== "reading" ||
        run.origin.kind !== "workflow"
      )
        return Promise.resolve(false);
      replace(run, { output: { value: counts } });
      return Promise.resolve(true);
    },
    create(run) {
      const holder =
        run.idempotencyKey === undefined
          ? undefined
          : runs.find(
              (held) =>
                held.clientInstanceId === run.clientInstanceId &&
                held.actor.kind === run.actor.kind &&
                held.actor.id === run.actor.id &&
                held.idempotencyKey === run.idempotencyKey
            );
      if (holder) {
        return Promise.resolve(undefined);
      }
      const { startedAt, ...rest } = run;
      const created: OperationRun = {
        ...rest,
        status: "running",
        attempt: 1,
        createdAt: startedAt,
        startedAt,
        updatedAt: startedAt
      };
      runs.push(created);
      return Promise.resolve(created);
    },
    recordEnded({ end, startedAt, ...rest }) {
      const { finishedAt, ...outcome } = end;
      const recorded: OperationRun = {
        ...rest,
        ...outcome,
        attempt: 1,
        createdAt: startedAt,
        startedAt,
        finishedAt,
        updatedAt: finishedAt
      };
      runs.push(recorded);
      return Promise.resolve(recorded);
    },
    finish({ clientInstanceId, id, attempt, end }) {
      const run = find(clientInstanceId, id);
      if (run?.status !== "running") return Promise.resolve(undefined);
      if (attempt !== undefined && run.attempt !== attempt) return Promise.resolve(undefined);
      const { finishedAt, ...outcome } = end;
      if (outcome.status === "pending_approval") {
        return Promise.resolve(replace(run, { ...outcome, updatedAt: finishedAt }));
      }
      if (outcome.status === "done") {
        const { decision, ...done } = outcome;
        return Promise.resolve(
          replace(run, { ...done, ...(decision ? { decision } : {}), finishedAt })
        );
      }
      return Promise.resolve(replace(run, { ...outcome, finishedAt }));
    },
    findByIdempotencyKey({ clientInstanceId, actor, idempotencyKey }) {
      return Promise.resolve(
        runs.find(
          (run) =>
            run.clientInstanceId === clientInstanceId &&
            run.actor.kind === actor.kind &&
            run.actor.id === actor.id &&
            run.idempotencyKey === idempotencyKey
        )
      );
    },
    get({ clientInstanceId, id }) {
      return Promise.resolve(find(clientInstanceId, id));
    },
    list({ clientInstanceId, filters }) {
      return Promise.resolve(
        runs
          .filter(
            (run) =>
              run.clientInstanceId === clientInstanceId &&
              (filters?.effect === undefined || run.effect === filters.effect)
          )
          .reverse()
      );
    },
    resume({ clientInstanceId, id, decision, startedAt }) {
      const run = find(clientInstanceId, id);
      if (run?.status !== "pending_approval") return Promise.resolve(undefined);
      return Promise.resolve(replace(run, { status: "running", decision, startedAt }));
    },
    approveWaiting({ clientInstanceId, id, decision }) {
      const run = find(clientInstanceId, id);
      const waiting = decision.mode === "confirmed" ? "pending_confirmation" : "pending_approval";
      if (
        run?.status !== waiting ||
        run.decision ||
        !run.expiresAt ||
        Date.parse(run.expiresAt) <= Date.now() ||
        (waiting === "pending_confirmation" && !run.approvalRequestId)
      )
        return Promise.resolve(undefined);
      return Promise.resolve({ run: replace(run, { decision }), resumesAgent: false });
    },
    holdConfirmedForApproval({ clientInstanceId, id, approvalRequestId, inputRef, expiresAt }) {
      const run = find(clientInstanceId, id);
      if (
        run?.status !== "pending_confirmation" ||
        run.decision?.mode !== "confirmed" ||
        run.origin.kind === "agent"
      )
        return Promise.resolve(undefined);
      return Promise.resolve(
        replace(run, {
          status: "pending_approval",
          approvalRequestId,
          inputRef,
          expiresAt,
          decision: undefined
        })
      );
    },
    endWaiting({ clientInstanceId, id, end, decision }) {
      const run = find(clientInstanceId, id);
      if (run?.status !== "pending_approval") return Promise.resolve(undefined);
      const { finishedAt, ...outcome } = end;
      return Promise.resolve(
        replace(run, { ...outcome, ...(decision ? { decision } : {}), finishedAt })
      );
    },
    markExpired({ clientInstanceId, limit }) {
      const now = Date.now();
      const expired = runs
        .filter(
          (run) =>
            run.clientInstanceId === clientInstanceId &&
            run.status === "pending_approval" &&
            !run.decision &&
            run.expiresAt !== undefined &&
            new Date(run.expiresAt).getTime() <= now
        )
        .slice(0, limit);
      return Promise.resolve(expired.map((run) => replace(run, { status: "expired" })));
    },
    listRunningSince({ clientInstanceId, startedBefore, limit }) {
      return Promise.resolve(
        runs
          .filter(
            (run) =>
              run.clientInstanceId === clientInstanceId &&
              run.status === "running" &&
              (run.startedAt ?? run.createdAt) < startedBefore
          )
          .slice(0, limit)
      );
    },
    deleteOfConversations({ clientInstanceId, conversationIds }) {
      const gone = runs.filter(
        (run) =>
          run.clientInstanceId === clientInstanceId &&
          run.conversationId !== undefined &&
          conversationIds.includes(run.conversationId)
      );
      for (const run of gone) runs.splice(runs.indexOf(run), 1);
      return Promise.resolve(gone.length);
    },
    deleteWithoutConversationOlderThan() {
      return Promise.resolve(0);
    },
    deleteOrphanedRequests() {
      return Promise.resolve(0);
    },
    markInterrupted({ clientInstanceId, id }) {
      const run = find(clientInstanceId, id);
      if (run?.status !== "running") return Promise.resolve(undefined);
      return Promise.resolve(replace(run, { status: "failed", error: INTERRUPTED_RUN_ERROR }));
    }
  };
}
