import {
  AppError,
  INTERRUPTED_RUN_ERROR,
  assertOperationChecksRights,
  type AuthenticatedIdentity,
  type OperationCall,
  type OperationDefinition,
  type OperationDenial,
  type OperationRun,
  type OperationRunId
} from "@vivd-catalyst/core";
import {
  authorizeActor,
  authorizeOrigin,
  createRunContext,
  deniedEnd,
  denyRun,
  executeAdmitted,
  failRun,
  hashInput,
  requireModuleOn,
  resolveGuardedPolicy,
  type RunContext,
  type RunOperationDeps
} from "./operation-execution";

/** The frozen call of a run that waits for an approval, as its approval request keeps it. */
export interface WaitingOperationCall {
  runId: OperationRunId;
  /**
   * The call as it was frozen, with its actor as that actor is now. Without an actor, the
   * actor no longer exists or may not act any more.
   */
  call: Omit<OperationCall, "actor"> & { actor: AuthenticatedIdentity | undefined };
}

/** Who decided on a waiting call. */
export interface OperationDecider {
  id: string;
  label: string;
  comment?: string;
}

/**
 * What became of a call that was approved. `refused` is a call that was not executed because
 * it may no longer run as the person who made it; `expired` one whose time ran out first.
 */
export type ApprovedOperationEnd = { run?: OperationRun } & (
  | { execution: "done" }
  | { execution: "failed" | "interrupted" | "refused"; error: { code: string; message: string } }
  | { execution: "expired" }
);

/**
 * Executes a call another person approved, once, outside the request that approved it.
 *
 * The run is taken for execution in one statement, so of two takers one executes. Whoever
 * finds the run already taken executes nothing and answers what the run says. A run that is
 * still `running` then belongs to an attempt that ended without recording its outcome: the
 * caller is the only executor of the run, so the run is ended as interrupted and never runs a
 * second time.
 *
 * Before anything of the operation runs, the call is asked again as the person who made it,
 * as that person is at this moment: the operation exists and its module is on, the input is
 * the one that was asked for, the person is a member of the call's workspace, the surface and
 * the right still allow it, and the policy with its guardrails does not refuse it. A call
 * that may not run ends its run with the reason and is `refused`.
 *
 * The call then runs for at most the time its operation names. A call that takes longer, or
 * whose `signal` is aborted, is told to stop through its own signal and its run ends at once:
 * as failed with `TIMEOUT`, or as interrupted.
 */
export async function executeApprovedOperation(
  waiting: WaitingOperationCall,
  approver: OperationDecider & { at: string },
  deps: RunOperationDeps,
  options: { signal?: AbortSignal } = {}
): Promise<ApprovedOperationEnd> {
  const now = deps.now ?? (() => new Date());
  const taken = await deps.runs.resume({
    clientInstanceId: deps.clientInstanceId,
    id: waiting.runId,
    startedAt: now().toISOString(),
    decision: {
      mode: "approved",
      by: approver.id,
      byLabel: approver.label,
      at: approver.at,
      ...(approver.comment ? { comment: approver.comment } : {})
    }
  });
  if (!taken) {
    return readApprovedOperationEnd(waiting.runId, deps);
  }
  const admitted = await admitAgain(taken, waiting, deps);
  if ("end" in admitted) {
    return admitted.end;
  }
  return executeWithinTime(admitted.context, options.signal);
}

/**
 * What a run that does not wait any more says about its approved call. A run that is still
 * `running` is ended as interrupted: only the one executor of the run may ask.
 */
export async function readApprovedOperationEnd(
  runId: string,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs">
): Promise<ApprovedOperationEnd> {
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (!run) {
    return {
      execution: "refused",
      error: { code: "NOT_FOUND", message: "The call of this request no longer exists." }
    };
  }
  if (run.status === "expired" || run.status === "pending_approval") {
    // A run that still waits and could not be taken ran out of time; the expiry job marks it.
    return { execution: "expired", run };
  }
  if (!wasTakenForExecution(run)) {
    return {
      execution: "refused",
      run,
      error: run.error ?? {
        code: "CONFLICT",
        message: "This call does not wait for an approval any more."
      }
    };
  }
  switch (run.status) {
    case "done":
      return { execution: "done", run };
    case "running": {
      const interrupted = await deps.runs.markInterrupted({
        clientInstanceId: deps.clientInstanceId,
        id: run.id
      });
      // A run that ended between the two statements says itself how.
      return interrupted
        ? { execution: "interrupted", run: interrupted, error: INTERRUPTED_RUN_ERROR }
        : readApprovedOperationEnd(runId, deps);
    }
    case "denied":
      return { execution: "refused", run, error: run.error ?? UNKNOWN_END };
    default:
      return {
        execution: run.error?.code === INTERRUPTED_RUN_ERROR.code ? "interrupted" : "failed",
        run,
        error: run.error ?? UNKNOWN_END
      };
  }
}

const UNKNOWN_END = { code: "INTERNAL", message: "The run does not say how the call ended." };

/**
 * Asks again whether a call that was taken for execution may run. A call that may not has its
 * run ended here, because nothing else will end it.
 */
async function admitAgain(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps
): Promise<{ context: RunContext } | { end: ApprovedOperationEnd }> {
  const found = await waitingContext(run, waiting, deps).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return { gone: { code: error.code, message: error.message } };
    }
    throw error;
  });
  if ("gone" in found) {
    return { end: await endWithoutContext(run, deps, { error: found.gone }) };
  }
  if ("actorGone" in found) {
    return {
      end: await endWithoutContext(run, deps, {
        denial: {
          kind: "forbidden",
          action: found.definition.action ?? found.definition.name,
          reason: "holder_inactive"
        },
        message: "The account of the person who made this call is closed or deleted."
      })
    };
  }
  const context = found;
  const { definition, call } = context;
  // The input was validated when the call was made and is not read through the schema again:
  // a schema that changes what it reads would refuse its own output. The hash says that what
  // is executed is what was asked for.
  if (hashInput(call.input) !== run.inputHash) {
    const error = new AppError("VALIDATION_FAILED", "The input of this call is no longer valid");
    const failed = await failRun(context, error, true);
    return {
      end: {
        execution: "refused",
        run: failed.run,
        error: { code: error.code, message: error.message }
      }
    };
  }
  const refuse = async (denial: OperationDenial, message?: string) => {
    const denied = await denyRun(context, denial);
    return {
      end: {
        execution: "refused" as const,
        run: denied.run,
        error: message
          ? { code: denied.run.error?.code ?? "FORBIDDEN", message }
          : (denied.run.error ?? UNKNOWN_END)
      }
    };
  };
  if (
    call.workspaceId !== undefined &&
    deps.workspaceMember &&
    !(await deps.workspaceMember({ userId: call.actor.id, workspaceId: call.workspaceId }))
  ) {
    return refuse(
      {
        kind: "forbidden",
        action: definition.action ?? definition.name,
        reason: "no_grant"
      },
      "The person who made this call is no longer a member of its workspace."
    );
  }
  const access = await deps.authorizer.forActor(call.actor);
  const surface = await authorizeOrigin(call, definition, deps);
  const right = surface.allowed ? await authorizeActor(context, access) : surface;
  await context.emit("operation.authorization_checked", "after", {
    ...(definition.action === null ? {} : { action: definition.action }),
    status: right.allowed ? "success" : "denied",
    ...(right.allowed ? {} : { action: right.action, reason: right.reason })
  });
  if (!right.allowed) {
    return refuse({ kind: "forbidden", action: right.action, reason: right.reason });
  }
  const guarded = await resolveGuardedPolicy(context);
  if ("denial" in guarded) {
    return refuse(guarded.denial);
  }
  return { context };
}

/** Ends a run that was taken for execution and whose operation or actor is gone. */
async function endWithoutContext(
  run: OperationRun,
  deps: RunOperationDeps,
  reason:
    { denial: OperationDenial; message: string } | { error: { code: string; message: string } }
): Promise<ApprovedOperationEnd> {
  const now = deps.now ?? (() => new Date());
  const finishedAt = now().toISOString();
  const ended = await deps.runs.finish({
    clientInstanceId: deps.clientInstanceId,
    id: run.id,
    end:
      "denial" in reason
        ? deniedEnd({ now }, reason.denial)
        : { status: "failed", finishedAt, error: { ...reason.error, unexecuted: true } }
  });
  return {
    execution: "refused",
    run: ended ?? run,
    error:
      "denial" in reason
        ? { code: ended?.error?.code ?? "FORBIDDEN", message: reason.message }
        : reason.error
  };
}

/**
 * The run of a waiting call with its operation, as the call path needs them. Throws NOT_FOUND
 * where the operation is gone or its module is off.
 */
async function waitingContext(
  run: OperationRun,
  waiting: WaitingOperationCall,
  deps: RunOperationDeps
): Promise<RunContext | { actorGone: true; definition: OperationDefinition }> {
  const { actor } = waiting.call;
  const definition = await deps.registry.resolve(run.operation);
  if (!definition) {
    throw new AppError("NOT_FOUND", `Operation '${run.operation}' is not registered`);
  }
  assertOperationChecksRights(definition);
  if (!actor) {
    return { actorGone: true, definition };
  }
  const call: OperationCall = { ...waiting.call, actor };
  requireModuleOn(call, deps.modules);
  return createRunContext({
    run,
    definition,
    call,
    resource: definition.resource(call.input),
    deps,
    // The call is executed later and elsewhere than it was made: nothing of the live call is
    // left. Its time and its signal are set where it is executed.
    runtime: {}
  });
}

/** Runs the call for at most the time its operation names, and until `signal` is aborted. */
async function executeWithinTime(
  admitted: RunContext,
  signal: AbortSignal | undefined
): Promise<ApprovedOperationEnd> {
  const { definition, deps, call } = admitted;
  const { timeoutMs } = definition;
  const stop = new AbortController();
  const context: RunContext = {
    ...admitted,
    runtime: { signal: stop.signal, deadline: new Date(admitted.now().getTime() + timeoutMs) }
  };
  const access = await deps.authorizer.forActor(call.actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cut = new Promise<"timeout" | "aborted">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    onAbort = () => resolve("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const execution = executeAdmitted(context, access);
  try {
    const first = await Promise.race([execution, cut]);
    if (first === "timeout") {
      const error = new AppError(
        "TIMEOUT",
        `'${definition.name}' did not end within its ${timeoutMs / 1000} seconds`,
        undefined,
        { exposeMessage: true }
      );
      // The run ends before the implementation is told to stop, so one that stops at once
      // cannot record itself as done. What it writes later is refused by the run store.
      const failed = await failRun(context, error, false);
      stop.abort(error);
      void execution.catch(() => undefined);
      return {
        execution: "failed",
        run: failed.run,
        error: { code: error.code, message: error.message }
      };
    }
    if (first === "aborted") {
      const interrupted = await deps.runs.markInterrupted({
        clientInstanceId: deps.clientInstanceId,
        id: context.run.id
      });
      stop.abort(signal?.reason);
      void execution.catch(() => undefined);
      return interrupted
        ? { execution: "interrupted", run: interrupted, error: INTERRUPTED_RUN_ERROR }
        : await readApprovedOperationEnd(context.run.id, deps);
    }
    const { result, run } = first;
    switch (result.status) {
      case "done":
        return { execution: "done", run };
      case "denied":
        return { execution: "refused", run, error: run.error ?? UNKNOWN_END };
      case "failed":
        return {
          execution: "failed",
          run,
          error: { code: result.error.code, message: result.error.message }
        };
      default:
        throw new AppError("INTERNAL", `An approved call ended as '${result.status}'`);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Ends a waiting call that a person declined: the run is `denied` as declined, with who
 * declined and the comment, and nothing is executed. Declining twice answers the same run. A
 * run that was taken for execution, or expired, refuses with what happened instead.
 */
export async function declineWaitingOperation(
  runId: OperationRunId,
  decider: OperationDecider,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs" | "now">
): Promise<OperationRun> {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const comment = decider.comment ? { comment: decider.comment } : {};
  const denial: OperationDenial = { kind: "declined", by: decider.id, ...comment };
  const declined = await deps.runs.endWaiting({
    clientInstanceId: deps.clientInstanceId,
    id: runId,
    end: deniedEnd({ now: () => new Date(at) }, denial),
    decision: { mode: "declined", by: decider.id, byLabel: decider.label, at, ...comment }
  });
  if (declined) {
    return declined;
  }
  const run = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: runId });
  if (!run) {
    throw new AppError("NOT_FOUND", "The call of this request no longer exists");
  }
  if (run.status === "denied" && run.decision?.mode === "declined") {
    return run;
  }
  throw new AppError(
    "CONFLICT",
    run.decision?.mode === "approved"
      ? "This call was approved and has been executed. It cannot be declined any more."
      : run.status === "expired"
        ? "This call expired before it was decided. Nothing was executed."
        : "This call does not wait for an approval any more.",
    { operationRunId: run.id }
  );
}

/**
 * Ends a waiting call that nobody can decide any more, such as the call of a deleted
 * conversation or account: the run is `denied` with the reason and nothing is executed.
 * A run that does not wait any more is left as it is.
 */
export async function refuseWaitingOperation(
  runId: OperationRunId,
  denial: OperationDenial,
  deps: Pick<RunOperationDeps, "clientInstanceId" | "runs" | "now">
): Promise<void> {
  await deps.runs.endWaiting({
    clientInstanceId: deps.clientInstanceId,
    id: runId,
    end: deniedEnd({ now: deps.now ?? (() => new Date()) }, denial)
  });
}

/** Whether a waiting call was taken for execution: it ran, runs, or was cut off while running. */
export function wasTakenForExecution(run: OperationRun | undefined): boolean {
  return run?.decision?.mode === "approved";
}
