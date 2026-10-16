import {
  AppError,
  isAppError,
  isAuthenticatedServicePrincipal,
  operationDenialError,
  WORKFLOW_ERROR_CODES,
  workflowStepIdempotencyKey,
  type AuthenticatedIdentity,
  type JsonObject,
  type JsonValue,
  type OperationCall,
  type OperationDefinition,
  type OperationDenial,
  type OperationDraftContext,
  type OperationRegistry,
  type OperationRunId,
  type OperationTarget,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowStepRun,
  type WorkflowStepRunCall
} from "@work-shape/catalyst-core";
import { runOperation, type RunOperationDeps } from "@work-shape/catalyst-tool-execution";
import { z } from "zod";
import { indexWorkflowSteps, stepOperationRefusal } from "./definition";
import { jsonValueSchema } from "./json";
import { WORKFLOW_STEP_JOB_MAX_ATTEMPTS } from "./limits";
import { WorkflowStepFailure, type WorkflowStepFailureOptions } from "./step-failure";
import { WORKFLOW_TEST_RUN_ERRORS } from "./test-run";

// The call an operation step makes. It takes the one call path, so it is checked, recorded
// and answered like every other call of the operation: the right is the run's principal's,
// the policy is asked for the origin `workflow`, and the call leaves an Operation Run. A step
// of a test run calls as the person testing, bounded by the principal, with the draft context
// that lets `runOperation()` decide where the call goes (ADR-0031).

/** The call path of the instance, as the engine uses it. */
export interface WorkflowOperationCalls {
  registry: OperationRegistry;
  deps: RunOperationDeps;
}

/** What a step run keeps of the call it made beside its outcome. */
interface OperationStepTrace {
  operationRunId?: OperationRunId;
  /** What the operation does and the name of what it belongs to, once it is resolved. */
  call?: WorkflowStepRunCall;
}

export interface OperationStepResult extends OperationStepTrace {
  output: JsonValue;
}

/** A step failure that names the Operation Run it came from and what was called. */
export class OperationStepFailure extends WorkflowStepFailure {
  readonly trace: OperationStepTrace;

  constructor(
    code: string,
    message: string,
    trace: OperationStepTrace = {},
    options: WorkflowStepFailureOptions = {}
  ) {
    super(code, message, options);
    this.name = "OperationStepFailure";
    this.trace = trace;
  }
}

const traceOf = (
  call: WorkflowStepRunCall,
  operationRunId: OperationRunId | undefined,
  target?: OperationTarget
): OperationStepTrace => ({
  call: target === undefined ? call : { ...call, target },
  ...(operationRunId ? { operationRunId } : {})
});

/** Who holds the key of a step's call: the run's principal, or in a test run the tester. */
const keyHolder = (actor: AuthenticatedIdentity) => ({
  kind: isAuthenticatedServicePrincipal(actor) ? ("service_principal" as const) : ("user" as const),
  id: actor.id
});

/**
 * The step failure of a first call that was cut off where nothing rules out that a second one
 * would change something twice: its operation is not one that is called again under its key.
 */
const interruptedFailure = (operation: string, trace: OperationStepTrace) =>
  new OperationStepFailure(
    "operation_interrupted",
    `The call of '${operation}' was cut off, so it may or may not have taken effect: check what it changed before the Workflow is started again, and to have such a call made again by itself, name the header that carries its key to the outside system ('idempotencyKeyHeader' on the operation of the Connection)`,
    trace
  );

/**
 * Why an operation is no step of a Workflow, or nothing where it may be one. A step run keeps
 * the output of its step and shows a preview of it, and an operation marked secret answers
 * a secret that is shown once and kept nowhere.
 */
function secretOperationRefusal(
  definition: Pick<OperationDefinition, "name" | "secret">
): { code: "operation_secret"; message: string } | undefined {
  return definition.secret
    ? {
        code: "operation_secret",
        message: `The operation '${definition.name}' answers a secret, which a step of a Workflow may not call`
      }
    : undefined;
}

const interruptedSchema = z.object({ interrupted: z.literal(true) });
const failureReasonSchema = z.object({ reason: z.string().regex(/^[a-z_]{1,64}$/u) });
const refusedRightSchema = z.object({
  action: z.string(),
  boundBy: z.object({ id: z.string(), label: z.string() }).optional()
});
const heldRunSchema = z.object({
  operationRunId: z.custom<OperationRunId>((value) => typeof value === "string" && value !== "")
});

/** How long a step waits for a first call that has not ended, and how often it asks. */
export interface OperationOutcomeWait {
  /** From the start of the first call. After it the call counts as interrupted. */
  waitMs: number;
  /** The wait before the first look, doubled up to `maxPollMs`: the backoff of the step's job. */
  pollMs: number;
  maxPollMs: number;
  now(): Date;
}

/** Resolves after `ms`, or rejects with the reason of the signal when the attempt is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("The attempt was stopped"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopped);
      resolve();
    }, ms);
    if (signal.aborted) stopped();
    else signal.addEventListener("abort", stopped, { once: true });
  });
}

/**
 * Waits for the first call under the key of a step run where an earlier attempt started it
 * and it has no outcome yet. That attempt's worker was stopped, lost its lease or died; the
 * call may still be running in its process. The step run is given the id of that Operation
 * Run at once. The wait ends when the call has an outcome, which the call below then answers
 * again, or once the call has had the time its operation gives a call (and `waitMs` at most),
 * counted from its start: then nobody will ever write its outcome, and the Operation Run is
 * ended as interrupted.
 *
 * What follows depends on the operation. One that is called again under its key
 * (`repeatsUnderKey`) is: the call below takes the interrupted run and makes the call a
 * second time under the same key, which whatever carries it out answers without a second
 * change. Every other operation is never called a second time, under this key or another,
 * and the step fails as `operation_interrupted`.
 */
async function awaitFirstCall(input: {
  calls: WorkflowOperationCalls;
  run: WorkflowRun;
  operation: string;
  definition: Pick<OperationDefinition, "timeoutMs" | "repeatsUnderKey">;
  idempotencyKey: string;
  actor: AuthenticatedIdentity;
  made: WorkflowStepRunCall;
  wait: OperationOutcomeWait;
  signal: AbortSignal;
  noteOperationRun(id: OperationRunId): Promise<void>;
}): Promise<void> {
  const { runs } = input.calls.deps;
  const { clientInstanceId } = input.run;
  // A call that runs longer than its operation lets a call run was cut off with its process.
  const waitMs = Math.min(input.wait.waitMs, input.definition.timeoutMs);
  let pollMs = input.wait.pollMs;
  for (;;) {
    const first = await runs.findByIdempotencyKey({
      clientInstanceId,
      actor: keyHolder(input.actor),
      idempotencyKey: input.idempotencyKey
    });
    if (first?.status !== "running") return;
    await input.noteOperationRun(first.id);
    const since = Date.parse(first.startedAt ?? first.createdAt);
    const left = since + waitMs - input.wait.now().getTime();
    if (left <= 0) {
      // Ended only where it still runs: a call that ended in this moment is answered again.
      if (await runs.markInterrupted({ clientInstanceId, id: first.id })) {
        if (input.definition.repeatsUnderKey) return;
        throw interruptedFailure(input.operation, traceOf(input.made, first.id));
      }
      continue;
    }
    await pause(Math.min(pollMs, left), input.signal);
    pollMs = Math.min(pollMs * 2, input.wait.maxPollMs);
  }
}

/**
 * Calls the operation of one step run as the run's principal. A changing call carries the
 * key of the step run, so an attempt that runs the step again changes nothing twice: it is
 * answered with what the first call answered, and where the first call was cut off it is made
 * again only if its operation is one that is called again under its key.
 *
 * A reading call ends with the attempt: a worker that stops cuts it, and the next attempt
 * reads again. A changing call is never cut by its worker, because a call that was cut may
 * have changed something and can then neither be answered nor made again; it ends on its own
 * or at its operation's own time limit, and its outcome is kept under its key.
 *
 * A call that the policy would hold for an approval is refused instead of filed. Nothing in
 * this release takes a run up again when somebody decides, so a held call would never run.
 *
 * A step of a test run carries `draft`: its actor is the tester and the principal bounds it.
 * A changing call that was simulated ends the step as done, with what it would have done as
 * its output, so the steps after it run on.
 */
export async function callStepOperation(input: {
  calls: WorkflowOperationCalls;
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  operation: string;
  input: JsonObject;
  actor: AuthenticatedIdentity;
  /** Set on a step of a test run: the draft, the step and the principal that bounds it. */
  draft?: OperationDraftContext;
  /** Set on a step of a published run whose Workflow was deleted since the run started. */
  workflowDeleted?: true;
  signal: AbortSignal;
  wait: OperationOutcomeWait;
  /** Keeps the id of the Operation Run of the step's call on its step run. */
  noteOperationRun(id: OperationRunId): Promise<void>;
}): Promise<OperationStepResult> {
  const { calls, run, stepRun, operation } = input;
  // A save refuses such a step. A definition stored before it did is refused here, by the
  // name alone and before anything is resolved or called.
  const notCallable = stepOperationRefusal(operation);
  if (notCallable) {
    throw new OperationStepFailure(notCallable.code, notCallable.message, {}, { systemic: true });
  }
  const definition = await calls.registry.resolve(operation);
  if (!definition) {
    throw new OperationStepFailure(
      "operation_not_found",
      `The operation '${operation}' does not exist on this instance`
    );
  }
  // What the call touches is read as the call path reads it: from the input the operation's
  // own schema accepts. An input it refuses names nothing, and the call below says why. The
  // schema of an operation an outside system described is checked in a worker thread, so it
  // is asked without blocking; a check that gave no answer names nothing either.
  const accepted = await definition.inputSchema
    .safeParseAsync(input.input)
    .catch(() => ({ success: false as const }));
  const touched = accepted.success ? definition.resource(accepted.data) : undefined;
  const source = touched?.name ?? touched?.id;
  const made: WorkflowStepRunCall = {
    effect: definition.effect,
    ...(source === undefined ? {} : { source })
  };
  const secret = secretOperationRefusal(definition);
  if (secret) throw new OperationStepFailure(secret.code, secret.message, { call: made });
  if (accepted.success && definition.inputWithoutSecrets?.(accepted.data) !== undefined) {
    // The values of a mapping are in the definition and in the outputs of earlier steps.
    throw new OperationStepFailure(
      "secret_input",
      `The input of '${operation}' holds a secret, which a step of a Workflow may not hand on`,
      { call: made }
    );
  }
  const changing = definition.effect === "changing";
  const idempotencyKey = workflowStepIdempotencyKey(stepRun.id);
  const call: OperationCall = {
    operation,
    effect: definition.effect,
    input: input.input,
    actor: input.actor,
    origin: { kind: "workflow", workflowRunId: run.id, stepRunId: stepRun.id },
    correlationId: run.correlationId,
    ...(changing ? { idempotencyKey } : {}),
    ...(input.draft ? { draft: input.draft } : {}),
    ...(input.workflowDeleted ? { workflowDeleted: input.workflowDeleted } : {})
  };
  const refused = refusedRight(run.principal.name, operation, source, input.draft !== undefined);
  if (changing) {
    await awaitFirstCall({ ...input, definition, idempotencyKey, made });
  }
  const { approvals: _notHeld, ...deps } = calls.deps;
  let outcome;
  try {
    outcome = await runOperation(call, deps, changing ? {} : { signal: input.signal });
  } catch (error) {
    throw refusalOf(error, operation, made, refused) ?? error;
  }
  const { result } = outcome;
  const trace = traceOf(
    outcome.publishedWouldAsk ? { ...made, publishedWouldAsk: outcome.publishedWouldAsk } : made,
    outcome.unrecorded ? undefined : result.runId,
    outcome.run.target
  );
  switch (result.status) {
    case "done": {
      const output = jsonValueSchema.safeParse(result.output ?? null);
      if (!output.success) {
        throw new OperationStepFailure(
          "output_not_json",
          `The operation '${operation}' answered a value that is not JSON`,
          trace
        );
      }
      return { output: output.data, ...trace };
    }
    case "denied": {
      const refusal = operationDenialError(result.reason);
      if (result.reason.kind === "forbidden") {
        // The principal does not hold the right, or may not call from a Workflow at all. An
        // operation only a person calls is refused by a rule no grant to the principal opens.
        // In a test run the refusal names the side that lacks the right: tester or principal.
        const { reason, message: ruled, action } = result.reason;
        if (reason === "user_only" && ruled !== undefined) {
          throw new OperationStepFailure(refusal.code, ruled, trace, { systemic: true });
        }
        const { code, message } = refused(action, result.reason.boundBy !== undefined);
        throw new OperationStepFailure(code, message, trace, { systemic: true, action });
      }
      if (input.draft && isApprovalUnavailable(result.reason)) {
        throw new OperationStepFailure(
          refusal.code,
          `The policy asks for another person's approval before '${operation}' runs live, and a test run cannot wait for one yet. Without "Run live once" the step is simulated`,
          trace,
          { systemic: true }
        );
      }
      // A policy is set for the operation and not for one item: the next would meet it too.
      throw new OperationStepFailure(
        refusal.code,
        refusal.message,
        trace,
        result.reason.kind === "policy" ? { systemic: true } : {}
      );
    }
    case "failed": {
      // A call that carried its key outside and failed for a reason that passes is made
      // again by the next attempt of the step's job, which counts it. The last attempt fails
      // the step like every other failure.
      if (
        changing &&
        definition.repeatsUnderKey &&
        outcome.run.error?.unexecuted === true &&
        stepRun.attempt < WORKFLOW_STEP_JOB_MAX_ATTEMPTS
      ) {
        throw new Error(`The call of '${operation}' failed for now and is made again`);
      }
      // The sentence of the error can quote the outside system, and the Operation Run keeps
      // it. Its reason is one of a fixed list, such as `upstream_conflict` for a 409.
      const reason = failureReasonSchema.safeParse(result.error.details);
      throw new OperationStepFailure(
        stepRun.stepType === "workflow" && reason.success ? reason.data.reason : result.error.code,
        reason.success
          ? `The operation '${operation}' failed (${reason.data.reason})`
          : `The operation '${operation}' failed`,
        trace
      );
    }
    // A run of a published revision is no call of a draft and is never simulated. A step of a
    // test run that was simulated is done: its output says what it would have done.
    case "dry_run": {
      if (!input.draft) {
        throw new OperationStepFailure(
          "operation_simulated",
          `The operation '${operation}' was simulated, which only a test run of a draft does`,
          trace
        );
      }
      const wouldHaveDone = jsonValueSchema.safeParse(result.input ?? null);
      const output: JsonObject = {
        wouldHaveDone: {
          operation,
          ...(wouldHaveDone.success && result.input !== undefined
            ? { input: wouldHaveDone.data }
            : {}),
          ...(result.wouldAsk ? { wouldAsk: result.wouldAsk } : {})
        }
      };
      return { output, ...trace };
    }
    case "expired":
    case "pending_approval":
    case "pending_confirmation":
      throw new OperationStepFailure(
        "operation_would_wait",
        `The operation '${operation}' waits for a decision, which a Workflow Run cannot do`,
        trace
      );
  }
}

/**
 * The step failure of an error the call path threw before a run answered, where another
 * attempt would be refused the same way. Any other error is left to the next attempt.
 */
function refusalOf(
  error: unknown,
  operation: string,
  call: WorkflowStepRunCall,
  refused: RefusedRight
): OperationStepFailure | undefined {
  if (!isAppError(error)) return undefined;
  const held = heldRunSchema.safeParse(error.details);
  const trace = traceOf(call, held.success ? held.data.operationRunId : undefined);
  if (error.code === "OPERATION_IN_PROGRESS") {
    // The first call with this key started this moment and still runs: the next attempt
    // waits for it. Only a first call that was interrupted never answers.
    return interruptedSchema.safeParse(error.details).success
      ? interruptedFailure(operation, trace)
      : undefined;
  }
  if (error.code === "OUTPUT_NOT_RETAINED") {
    // The first call was carried out and its answer is kept nowhere, so the step has none.
    return new OperationStepFailure(
      "operation_output_not_retained",
      `The call of '${operation}' was carried out and its answer was not kept`,
      trace
    );
  }
  if (error.code === "NOT_FOUND") {
    return new OperationStepFailure(
      "operation_not_found",
      `The operation '${operation}' does not exist on this instance`
    );
  }
  if (error.code === "VALIDATION_FAILED") {
    return new OperationStepFailure(
      "operation_input_invalid",
      `The input of the step does not fit the operation '${operation}'`,
      { call }
    );
  }
  if (!(error instanceof AppError) || error.statusCode !== 403) return undefined;
  const right = refusedRightSchema.safeParse(error.details);
  const action = right.success ? right.data.action : undefined;
  if (error.code === "FORBIDDEN") {
    const { code, message } = refused(action, right.success && right.data.boundBy !== undefined);
    return new OperationStepFailure(
      code,
      message,
      { call },
      { systemic: true, ...(action === undefined ? {} : { action }) }
    );
  }
  return new OperationStepFailure(
    error.code,
    error.message,
    { call },
    error.code === "POLICY_DENIED" ? { systemic: true } : {}
  );
}

/** The refusal of a right of one step: the right, and whether the principal lacks it. */
type RefusedRight = (
  action: string | undefined,
  principalSide: boolean
) => { code: string; message: string };

/**
 * The sentences of a refused right. The call path words its refusal for a person who made a
 * request; the caller of a step is the service principal of the run, and whoever reads the
 * run needs to know which principal lacks which right. In a test run the caller is the person
 * testing, bounded by the principal, and the sentence names the side that lacks the right.
 */
function refusedRight(
  principal: string,
  operation: string,
  source: string | undefined,
  testRun: boolean
): RefusedRight {
  const on = source === undefined ? "" : ` on '${source}'`;
  return (action, principalSide) => {
    const right = action === undefined ? "the right it needs" : `the right '${action}'`;
    if (!testRun) {
      return {
        code: "FORBIDDEN",
        message: `The service principal '${principal}', which the Workflow runs as, does not hold ${right} to call '${operation}'. An administrator can grant it to the principal`
      };
    }
    return principalSide
      ? {
          code: "FORBIDDEN",
          message: `The principal '${principal}' does not hold ${right}${on} to call '${operation}'; publishing would fail at this step`
        }
      : {
          code: WORKFLOW_TEST_RUN_ERRORS.testerMissingRight,
          message: `You do not hold ${right}${on} to call '${operation}'. A test run acts as the person testing, bounded by the principal '${principal}'`
        };
  };
}

function isApprovalUnavailable(denial: OperationDenial): boolean {
  return denial.kind === "policy" && denial.reason === "approval_unavailable";
}

/**
 * The operation steps of a definition that call an operation marked secret, as the refusal
 * of the definition: asked when a run is started, and by whoever saves or publishes one.
 */
export async function secretOperationSteps(
  manifest: Pick<WorkflowManifest, "steps">,
  registry: Pick<OperationRegistry, "resolve">
): Promise<{ path: string; code: "operation_secret"; message: string }[]> {
  const issues: { path: string; code: "operation_secret"; message: string }[] = [];
  for (const [id, { step }] of indexWorkflowSteps(manifest)) {
    if (step.type !== "operation") continue;
    const definition = await registry.resolve(step.operation);
    const refusal = definition ? secretOperationRefusal(definition) : undefined;
    if (refusal) issues.push({ path: `steps.${id}.operation`, ...refusal });
  }
  return issues;
}

/** Names what the engine does not run where a run reaches it all the same. */
export function notSupportedFailure(what: string): WorkflowStepFailure {
  return new WorkflowStepFailure(
    WORKFLOW_ERROR_CODES.notSupported,
    `This engine does not run ${what} yet (${WORKFLOW_ERROR_CODES.notSupported})`
  );
}
