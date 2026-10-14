import {
  AGENT_TOOL_ACTION_PREFIX,
  AppError,
  PLATFORM_EVENT_ALLOW,
  POLICY_VALUES,
  callerCanConfirm,
  isAppError,
  isAuthenticatedServicePrincipal,
  isToolOperationAnswer,
  moduleOffError,
  operationDenialError,
  resolvePolicy,
  strictestOutcome,
  connectionCallReasonOf,
  dataStoreRefusalOf,
  toErrorEnvelope,
  unknownToJsonValue,
  type AccessDecision,
  type ActorAccess,
  type AuditRecorder,
  type Authorizer,
  type CentralPolicySetting,
  type ClientInstanceId,
  type CollaborationWorkspaceId,
  type JsonObject,
  type JsonValue,
  type LiveOnceSwitchStore,
  type Logger,
  type ModuleSnapshot,
  type NewOperationRun,
  type OperationAuthorization,
  type OperationBeforeEvent,
  type OperationCall,
  type OperationCallRuntime,
  type OperationDefinition,
  type OperationDenial,
  type OperationExecutionContext,
  type OperationRegistry,
  type OperationResource,
  type OperationResult,
  type OperationRun,
  type OperationRunDecisionReason,
  type OperationRunEnd,
  type OperationRunId,
  type OperationRunStore,
  type PlatformEventAnswer,
  type PlatformEventContext,
  type PlatformEventEmitter,
  type PlatformEventName,
  type PolicyDefaults,
  type PolicySource,
  type PolicyInput,
  type PolicyResolution,
  type PolicyValue,
  type ToolExecutionResult,
  type ConversationId
} from "@vivd-catalyst/core";
import { z } from "zod";
import { askBeforeEvents, guardrailDenial } from "./before-events";
import { failureLogFields } from "./tool-failure-log";

/**
 * The largest answer of a completed changing call a run keeps for a repeated call. It bounds
 * what one row can hold. A repeated call whose first answer was larger reads 409
 * OUTPUT_NOT_RETAINED.
 */
const OPERATION_RUN_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * Files the request another person decides, with the frozen call as its payload. Answers
 * nothing for a call it cannot hold, which is then refused by policy.
 */
export interface OperationApprovalRequests {
  request(input: {
    run: OperationRun;
    /** The call with its validated input, frozen as the request's payload. */
    call: OperationCall;
    /**
     * What the call's before-events read that could change while it waits, kept beside its
     * input and merged into it when the call is executed (`WaitingOperationCall.heldInput`).
     */
    heldInput?: JsonObject;
    resource: OperationResource | undefined;
    /** What the live call has. An agent's call carries the hold of its run here. */
    runtime: OperationCallRuntime;
    expiresAt: string;
    /** Where the value came from that makes the call wait. */
    policySource: PolicySource;
  }): Promise<{ approvalRequestId: string } | undefined>;
}

export interface RunOperationDeps {
  clientInstanceId: ClientInstanceId;
  registry: OperationRegistry;
  runs: OperationRunStore;
  authorizer: Authorizer;
  events: PlatformEventEmitter;
  audit: AuditRecorder;
  policy: {
    instanceDefaults: PolicyDefaults;
    /** The admin's settings. OP-2 supplies the table; nothing is set before. */
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
  };
  /** Without it this process cannot hold a call for an approval and refuses one that needs it. */
  approvals?: OperationApprovalRequests;
  /** "Run live once" on a draft. Without it every changing call of a draft is simulated. */
  liveOnce?: LiveOnceSwitchStore;
  /** Which modules are on. An operation or a tool of a module that is off does not exist. */
  modules?: ModuleSnapshot;
  /**
   * The tools an agent may call: those its definition lists, and in a conversation about an
   * asset the tools the server binds to that subject. An agent calls nothing else. Without it
   * this process serves no agent and refuses every call of one.
   */
  agentToolNames?(
    agentName: string,
    conversationId?: ConversationId
  ): readonly string[] | Promise<readonly string[]>;
  /**
   * Whether a person is a member of a workspace now. Asked before a call that waited for an
   * approval is executed in a workspace, for an agent's call and for an operation whose right
   * is a named action: whoever left the workspace meanwhile no longer acts there. An operation
   * that decides its right itself is asked by its own rule instead. Without it this process
   * does not ask.
   */
  workspaceMember?(input: {
    userId: string;
    workspaceId: CollaborationWorkspaceId;
  }): Promise<boolean>;
  /**
   * Whether an agent is available in a workspace now, by the rule a new run of it is started
   * under. Asked before an agent's call that waited for an approval is executed in a
   * workspace: an agent that was withdrawn from it meanwhile no longer acts there. Without it
   * this process does not ask.
   */
  agentAvailable?(input: {
    agentName: string;
    workspaceId: CollaborationWorkspaceId;
  }): Promise<boolean>;
  logger: Logger;
  now?: () => Date;
}

/** What one call came to: the result for the caller, and the run that records it. */
export interface OperationOutcome {
  result: OperationResult;
  run: OperationRun;
  /** The result was read from the run of an earlier call with the same idempotency key. */
  replayed: boolean;
  /** The whole result of an agent tool, where the operation is one and it was executed. */
  toolResult?: ToolExecutionResult;
  /**
   * The call left no Operation Run: an allowed read of an operation that does not record
   * every call. `run` then says how the call went and is in no store.
   */
  unrecorded?: true;
}

export type OperationEnding = Pick<OperationOutcome, "result" | "run" | "toolResult">;

/** One run with what its call path needs to record how it goes on. */
export interface RunContext {
  run: OperationRun;
  definition: OperationDefinition;
  call: OperationCall;
  resource: OperationResource | undefined;
  deps: RunOperationDeps;
  runtime: OperationCallRuntime;
  /**
   * Set while the call has left no run: a read of an operation that does not record every
   * call. It holds what the run is written from if the call is refused or fails, and the
   * after-events the call had until then. They are emitted once the run is written, so a
   * refused or failed read has the audit rows it always had, and dropped when the read
   * completes. Before-events are never held: a guardrail is asked for every call.
   */
  unrecorded?: { start: NewOperationRun; heldAfterEvents: (() => Promise<unknown>)[] };
  /** Set once a later call took the run over: this call emits no further event of it. */
  overtaken?: boolean;
  /**
   * Set for a call that waited for an approval and is executed now: its before-events are
   * asked again, and the guardrails' hits were kept when it was made.
   */
  repeated?: true;
  /**
   * The events of the operation's own `beforeEvents` as the guardrails were last asked them
   * for this call, handed to its execution.
   */
  beforeEvents?: readonly OperationBeforeEvent[];
  /** Keeps the events of the operation's own `beforeEvents` as they are asked. */
  asked(events: readonly OperationBeforeEvent[]): void;
  now(): Date;
  emit(
    name: PlatformEventName,
    phase: "before" | "after",
    payload?: JsonObject,
    /** What a before-event's guardrails read, and the subject where it is not the call's. */
    before?: Pick<PlatformEventContext, "checkable" | "filterBy"> & {
      subject?: PlatformEventContext["subject"];
    }
  ): Promise<PlatformEventAnswer>;
}

/**
 * The run of a call that is recorded only if it is refused or fails, as the call path reads
 * it meanwhile. Its id is made here, so the events and the log lines of the call name it.
 */
export function unrecordedRun(start: NewOperationRun): OperationRun {
  const { startedAt, ...run } = start;
  return {
    ...run,
    status: "running",
    attempt: 1,
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt
  };
}

export function createRunContext(
  input: Pick<
    RunContext,
    "run" | "definition" | "call" | "resource" | "deps" | "runtime" | "repeated"
  > & {
    /** What the run is written from later, for a call that has left none yet. */
    unrecordedStart?: NewOperationRun;
  }
): RunContext {
  const { run, definition, call, resource, deps } = input;
  const subject = resource
    ? { kind: resource.kind, id: resource.id }
    : { kind: "operation", id: definition.name };
  // An agent's call names where it came from, so its audit rows lead back to the conversation.
  const origin: JsonObject =
    call.origin.kind === "agent"
      ? {
          agentName: call.origin.agentName,
          conversationId: call.origin.conversationId,
          toolCallId: call.origin.toolCallId
        }
      : {};
  const { unrecordedStart, ...rest } = input;
  const context: RunContext = {
    ...rest,
    ...(unrecordedStart ? { unrecorded: { start: unrecordedStart, heldAfterEvents: [] } } : {}),
    now: deps.now ?? (() => new Date()),
    asked: (events) => {
      context.beforeEvents = events;
    },
    emit: (name, phase, payload = {}, before = {}) => {
      const send = () =>
        deps.events.emit(
          name,
          {
            operationRunId: run.id,
            operation: definition.name,
            effect: definition.effect,
            attempt: run.attempt,
            ...origin,
            ...payload
          },
          {
            actor: call.actor,
            origin: call.origin,
            workspaceId: call.workspaceId,
            correlationId: call.correlationId,
            subject: before.subject ?? subject,
            phase,
            ...(before.checkable ? { checkable: before.checkable } : {}),
            ...(before.filterBy ? { filterBy: before.filterBy } : {}),
            runtime: { deadline: input.runtime.deadline, signal: input.runtime.signal },
            ...(input.repeated ? { repeated: true } : {})
          }
        );
      if (context.overtaken) return Promise.resolve(PLATFORM_EVENT_ALLOW);
      if (phase === "after" && context.unrecorded) {
        context.unrecorded.heldAfterEvents.push(send);
        return Promise.resolve(PLATFORM_EVENT_ALLOW);
      }
      return send();
    }
  };
  return context;
}

/** Refuses a call of an operation, or of an agent tool, whose module is off. */
export function requireModuleOn(call: OperationCall, modules: ModuleSnapshot | undefined): void {
  const module =
    modules?.offModuleOf("operation", call.operation) ??
    (call.origin.kind === "agent" ? modules?.offModuleOf("tool", call.origin.toolName) : undefined);
  if (module !== undefined) {
    throw moduleOffError(module);
  }
}

/**
 * What the surface a call came through allows, before the actor's own right is asked. An
 * operation a person calls (`auth: "user"`) is refused to a service principal, as its route
 * refuses one, also where the call takes no route, such as a step of a Workflow. An agent
 * calls the tools its definition lists and nothing else. Every other origin has no rule of
 * its own here.
 */
export async function authorizeOrigin(
  call: OperationCall,
  definition: OperationDefinition,
  deps: RunOperationDeps
): Promise<OperationAuthorization> {
  if (definition.auth === "user" && isAuthenticatedServicePrincipal(call.actor)) {
    return {
      allowed: false,
      ...(definition.action === null ? {} : { action: definition.action }),
      reason: "user_only",
      message: `Only a person may call '${definition.name}', and a service principal is none`
    };
  }
  if (call.origin.kind !== "agent") {
    return { allowed: true };
  }
  const { agentName, toolName, conversationId } = call.origin;
  const listed = (await deps.agentToolNames?.(agentName, conversationId)) ?? [];
  return toolName === definition.name && listed.includes(toolName)
    ? { allowed: true }
    : { allowed: false, action: `${AGENT_TOOL_ACTION_PREFIX}${toolName}`, reason: "no_grant" };
}

/** Asks the actor's right: the one the operation names, or the operation's own check. */
export async function authorizeActor(
  context: Pick<RunContext, "definition" | "call" | "resource">,
  access: ActorAccess
): Promise<OperationAuthorization> {
  const { definition, call, resource } = context;
  if (definition.action !== null) {
    return namedRight(access.authorize(definition.action, resource), definition.action);
  }
  return definition.authorize(call.input, {
    actor: call.actor,
    origin: call.origin,
    workspaceId: call.workspaceId,
    correlationId: call.correlationId,
    access,
    resource
  });
}

function namedRight(decision: AccessDecision, action: string): OperationAuthorization {
  return decision.allowed ? { allowed: true } : { allowed: false, action, reason: decision.reason };
}

/** What the policy is resolved from for this call, before a guardrail answered. */
async function policyInputOf(
  context: Pick<RunContext, "definition" | "call" | "resource" | "deps">
): Promise<PolicyInput> {
  const { definition, call, resource, deps } = context;
  const callFloor = await definition.policyFloorOf?.(call.origin);
  return {
    definition:
      callFloor === undefined
        ? definition
        : { ...definition, policyFloor: stricterPolicy(callFloor, definition.policyFloor) },
    origin: call.origin,
    instanceDefaults: deps.policy.instanceDefaults,
    centralSettings: await deps.policy.centralSettings(),
    // An operation says itself what the policy is asked about where its resource does not
    // say it all. It is asked again, the same way, before a call that waited is executed.
    targets: definition.policyTargets
      ? await definition.policyTargets(call.input)
      : [{ workspaceId: call.workspaceId, assetKind: resource?.kind }],
    // A step of a test run that a person started is that person's call: their start was the
    // confirmation (ADR-0031). A step of any other run has nobody to ask.
    callerCanConfirm:
      callerCanConfirm(call.origin) ||
      (call.draft?.boundBy !== undefined && call.draft.startConfirmed === true),
    // No surface can hold a call for its actor's confirmation before OP-3.
    canPause: false
  };
}

function stricterPolicy(left: PolicyValue, right: PolicyValue | undefined): PolicyValue {
  return right !== undefined && POLICY_VALUES.indexOf(right) > POLICY_VALUES.indexOf(left)
    ? right
    : left;
}

/**
 * What the policy asks of a call once the guardrails answered, or why it is refused. Asked
 * when a call is made, and again, as the caller is then, before a call that waited for an
 * approval is executed.
 */
export async function resolveGuardedPolicy(
  context: RunContext
): Promise<{ policy: PolicyResolution } | { denial: OperationDenial }> {
  const { definition } = context;
  const policyInput = await policyInputOf(context);
  if (resolvePolicy(policyInput).next === "refuse") {
    return { denial: { kind: "policy", operation: definition.name } };
  }
  const answers = await askBeforeEvents(context);
  const guardrailOutcome = strictestOutcome(answers.map((answer) => answer.outcome));
  const policy = resolvePolicy({ ...policyInput, guardrailOutcome });
  if (policy.next !== "refuse") {
    return { policy };
  }
  return {
    denial:
      policy.source === "guardrail"
        ? guardrailDenial(answers, definition.events?.before ?? "operation.before_call")
        : { kind: "policy", operation: definition.name }
  };
}

/** Ends a run that is still `running`. The run as it was when something else ended it first. */
export async function endRun(context: RunContext, ended: OperationRunEnd): Promise<OperationRun> {
  const { run, definition, deps } = context;
  if (context.unrecorded) {
    return endUnrecorded(context, context.unrecorded, ended);
  }
  const finished = await deps.runs.finish({
    clientInstanceId: deps.clientInstanceId,
    id: run.id,
    attempt: run.attempt,
    end: ended
  });
  if (finished) return finished;
  const current = await deps.runs.get({ clientInstanceId: deps.clientInstanceId, id: run.id });
  if (current && current.attempt !== run.attempt) {
    // A later call took the run under its key while this one was still on its way: this
    // process was held up past its time. The run is that call's to end, and this one says
    // nothing more of it: no outcome and no event.
    context.overtaken = true;
    return current;
  }
  // Something else ended the run meanwhile, such as the sweep for interrupted runs.
  deps.logger.warn(
    { operationRunId: run.id, operation: definition.name, status: ended.status },
    "Operation run was no longer running when its call ended"
  );
  return run;
}

/**
 * Ends a call that has left no run. Completed, it leaves none: nothing is sent to the store.
 * Refused or failed, its run is written now, ended, in one statement, and the after-events it
 * had are emitted behind it. Where that write fails, the call still ends as it did: the caller
 * is told the refusal or the error it met, never the store's, and the call stays without a run.
 */
async function endUnrecorded(
  context: RunContext,
  unrecorded: NonNullable<RunContext["unrecorded"]>,
  ended: OperationRunEnd
): Promise<OperationRun> {
  if (ended.status === "done") {
    return { ...context.run, status: "done", finishedAt: ended.finishedAt };
  }
  if (ended.status === "pending_approval") {
    throw new AppError("INTERNAL", "A reading call cannot wait for an approval");
  }
  let recorded: OperationRun;
  try {
    recorded = await context.deps.runs.recordEnded({ ...unrecorded.start, end: ended });
  } catch (error) {
    const { run, definition, call, deps } = context;
    deps.logger.error(
      {
        operation: definition.name,
        operationRunId: run.id,
        correlationId: call.correlationId,
        status: ended.status,
        ...failureLogFields(error)
      },
      "A refused or failed read could not be recorded"
    );
    return {
      ...run,
      status: ended.status,
      finishedAt: ended.finishedAt,
      error: ended.error,
      ...(ended.status === "denied" ? { denial: ended.denial } : {})
    };
  }
  context.unrecorded = undefined;
  for (const send of unrecorded.heldAfterEvents) {
    await send();
  }
  return recorded;
}

export function deniedEnd(
  context: Pick<RunContext, "now">,
  denial: OperationDenial
): Extract<OperationRunEnd, { status: "denied" }> {
  const error = operationDenialError(denial);
  return {
    status: "denied",
    finishedAt: context.now().toISOString(),
    error: { code: error.code, message: error.message },
    denial
  };
}

export async function denyRun(
  context: RunContext,
  denial: OperationDenial
): Promise<OperationEnding> {
  const end = deniedEnd(context, denial);
  const denied = await endRun(context, end);
  await context.emit("operation.denied", "after", { status: "denied", reason: end.error.code });
  return { result: { status: "denied", runId: context.run.id, reason: denial }, run: denied };
}

/**
 * Executes a call that passed its checks and records how it ended. Whatever the implementation
 * throws ends the run as failed; a refusal it raises through `context.access.require` ends it
 * as denied.
 */
/** The decision of a call that ran on its own caller's word, with why where that needs saying. */
export interface DirectDecision {
  mode: "direct";
  reason?: OperationRunDecisionReason;
}

/** Thrown by the `begin` of `executeAdmitted`: the operation was not called. */
export class OperationNotBegunError extends Error {
  constructor() {
    super("The operation was not called");
    this.name = "OperationNotBegunError";
  }
}

/** Calls the operation now. What it throws, at once or later, rejects the answer. */
function callOperation(
  definition: OperationDefinition,
  input: unknown,
  execution: OperationExecutionContext
): Promise<unknown> {
  let executing: Promise<unknown>;
  try {
    executing = Promise.resolve(definition.execute(input, execution));
  } catch (error) {
    executing = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  // The answer is awaited after the started event. A rejection before that is still handled.
  executing.catch(() => undefined);
  return executing;
}

export async function executeAdmitted(
  context: RunContext,
  access: ActorAccess,
  /** The decision of a call that ran on its own caller's word. An approved run has its own. */
  decision?: DirectDecision,
  /**
   * Called as the last thing before the operation is, with nothing awaited between the two.
   * A caller that marks the run as started only now does it here. It throws
   * `OperationNotBegunError` to keep the operation from being called; that error leaves here
   * as it is and ends no run.
   */
  begin?: () => Promise<void>
): Promise<OperationEnding> {
  const { run, definition, call, deps, now } = context;
  let completed: OperationEnding | undefined;
  let started = false;
  try {
    if (!begin) await context.emit("operation.started", "after", { status: "success" });
    const execution: OperationExecutionContext = {
      runId: run.id,
      actor: call.actor,
      origin: call.origin,
      workspaceId: call.workspaceId,
      correlationId: call.correlationId,
      ...(run.idempotencyKey === undefined ? {} : { idempotencyKey: run.idempotencyKey }),
      runtime: context.runtime,
      access,
      audit: auditForRun(deps.audit, run.id, call.correlationId),
      ...(context.beforeEvents ? { beforeEvents: context.beforeEvents } : {})
    };
    await begin?.();
    started = true;
    const executing = callOperation(definition, call.input, execution);
    // With `begin` the call is said to have started once it has: nothing may be awaited before.
    if (begin) await context.emit("operation.started", "after", { status: "success" });
    const answer = await executing;
    if (isToolOperationAnswer(answer) && answer.result.status !== "success") {
      return await endToolFailure(context, answer.result);
    }
    const tool = isToolOperationAnswer(answer) ? answer : undefined;
    const output: unknown = tool ? toolOutput(tool.result) : answer;
    // From here on the call has happened. Whatever fails below is a failure to record it, and
    // the caller is still told the outcome with the run: an error would make it call again.
    completed = {
      result: {
        status: "done",
        runId: run.id,
        output,
        ...(tool?.result.status === "success" ? shownBesideOutput(tool.result) : {})
      },
      run,
      toolResult: tool?.result
    };
    const done = await endRun(context, {
      status: "done",
      finishedAt: now().toISOString(),
      // An answer that holds a secret is handed to the caller of this call and kept nowhere.
      output:
        definition.effect === "changing" && !definition.secret ? retainedOutput(output) : undefined,
      usage: tool?.usage,
      ...(decision
        ? {
            decision: {
              mode: decision.mode,
              ...(decision.reason ? { reason: decision.reason } : {}),
              by: run.actor.id,
              at: now().toISOString()
            }
          }
        : {})
    });
    completed = { ...completed, run: done };
    await context.emit("operation.completed", "after", {
      status: "success",
      ...(tool ? toolAuditFields(tool.result) : {})
    });
    if (definition.events?.after) await context.emit(definition.events.after, "after");
    return completed;
  } catch (error) {
    if (error instanceof OperationNotBegunError) throw error;
    if (completed) {
      deps.logger.error(
        {
          operation: definition.name,
          operationRunId: run.id,
          correlationId: call.correlationId,
          ...failureLogFields(error)
        },
        "An operation completed but recording it failed"
      );
      return completed;
    }
    // An implementation that asks for a further right refuses through `context.access.require`.
    const refused = forbiddenSchema.safeParse(error);
    if (refused.success) {
      return denyRun(context, {
        kind: "forbidden",
        ...refused.data.details,
        message: refused.data.message
      });
    }
    // An implementation that rolled back whole says so; every other one may have changed something.
    return failRun(context, error, !started || (isAppError(error) && error.changedNothing));
  }
}

/**
 * A tool that reports its own failure has run. The run keeps the tool's code and no text of
 * the tool: what the tool said is in the conversation it answered, under that conversation's
 * retention.
 */
async function endToolFailure(
  context: RunContext,
  result: Exclude<ToolExecutionResult, { status: "success" }>
): Promise<OperationEnding> {
  const { run, definition, now } = context;
  const error = {
    code: result.error.code,
    message: `'${definition.name}' ended as ${result.status} with '${result.error.code}'`
  };
  const failed = await endRun(context, {
    status: "failed",
    finishedAt: now().toISOString(),
    error
  });
  await context.emit("operation.failed", "after", {
    status: "failed",
    reason: error.code,
    ...toolAuditFields(result)
  });
  return { result: { status: "failed", runId: run.id, error }, run: failed, toolResult: result };
}

function toolOutput(result: ToolExecutionResult): unknown {
  return result.status === "success" ? result.output : undefined;
}

function shownBesideOutput(
  result: Extract<ToolExecutionResult, { status: "success" }>
): Pick<
  Extract<OperationResult, { status: "done" }>,
  "display" | "structuredResult" | "artifacts"
> {
  return {
    ...(result.display ? { display: result.display } : {}),
    ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {})
  };
}

/** What a tool says about itself for the audit log: names and counts, never content. */
function toolAuditFields(result: ToolExecutionResult): JsonObject {
  const summary = result.auditSummary;
  return {
    resultStatus: result.status,
    ...(summary
      ? {
          auditAction: summary.action,
          ...(summary.subject ? { auditSubject: summary.subject } : {}),
          ...(summary.metadata ? { auditMetadata: summary.metadata } : {})
        }
      : {})
  };
}

export async function failRun(
  context: RunContext,
  error: unknown,
  /** Whether the call failed before the operation's implementation was reached. */
  unexecuted: boolean
): Promise<OperationEnding> {
  const { run, definition, call, deps, now } = context;
  // The envelope is the one rule for what an error may tell: no thrown message of an
  // internal error and no provider text reaches the run, the audit row or the caller.
  const { statusCode, error: safe } = toErrorEnvelope(error, call.correlationId);
  // The reason is one of a fixed list, so it is kept where the envelope drops the details.
  const reason = connectionCallReasonOf(error) ?? dataStoreRefusalOf(error);
  if (statusCode >= 500) {
    deps.logger.error(
      {
        operationRunId: run.id,
        operation: definition.name,
        correlationId: call.correlationId,
        ...failureLogFields(error)
      },
      "Operation failed"
    );
  }
  const failed = await endRun(context, {
    status: "failed",
    finishedAt: now().toISOString(),
    error: {
      code: safe.code,
      message: safe.message,
      ...(reason ? { reason } : {}),
      ...(unexecuted ? { unexecuted } : {})
    }
  });
  await context.emit("operation.failed", "after", { status: "failed", reason: safe.code });
  // The envelope drops the details of a 5xx, a timeout among them. The fixed reason stays.
  const details = detailsRecord(safe.details) ?? (reason ? { reason } : undefined);
  return {
    result: {
      status: "failed",
      runId: run.id,
      error: { code: safe.code, message: safe.message, ...(details ? { details } : {}) }
    },
    run: failed
  };
}

const forbiddenSchema = z.object({
  code: z.literal("FORBIDDEN"),
  message: z.string(),
  details: z.object({
    action: z.string().optional(),
    reason: z.enum([
      "no_grant",
      "denied",
      "unknown_action",
      "holder_inactive",
      "holder_not_administrable",
      "user_only",
      "outside_key_scope"
    ])
  })
});

function detailsRecord(details: unknown): Record<string, unknown> | undefined {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : undefined;
}

/** The answer as the run keeps it, or nothing when it is larger than a run may hold. */
function retainedOutput(output: unknown): { value: JsonValue } | undefined {
  const value = unknownToJsonValue(output);
  return Buffer.byteLength(JSON.stringify(value)) <= OPERATION_RUN_OUTPUT_MAX_BYTES
    ? { value }
    : undefined;
}

/** Audit rows written inside a call name its run and share its correlation id. */
function auditForRun(
  audit: AuditRecorder,
  operationRunId: OperationRunId,
  correlationId: string
): AuditRecorder {
  return {
    record: (input) =>
      audit.record({
        ...input,
        correlationId,
        metadata: { ...input.metadata, operationRunId }
      })
  };
}
