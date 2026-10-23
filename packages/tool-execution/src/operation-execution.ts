import {
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  isKnowledgeAddFilesOperation
} from "./knowledge-add-files-tool";
import { recordedResult } from "./operation-recorded-result";
import { auditForRun, retainedOutput } from "./operation-run-recording";
import {
  AGENT_TOOL_ACTION_PREFIX,
  AppError,
  OperationExecutionStop,
  JobDeferredError,
  INTERRUPTED_RUN_ERROR,
  OPERATION_DENIAL_REASONS,
  PLATFORM_EVENT_ALLOW,
  connectionCallReasonOf,
  dataStoreRefusalOf,
  mailSendReasonOf,
  isAppError,
  isAuthenticatedServicePrincipal,
  isToolOperationAnswer,
  moduleOffError,
  operationDenialError,
  toErrorEnvelope,
  type AccessDecision,
  type ActorAccess,
  type AgentRunId,
  type AuditRecorder,
  type Authorizer,
  type CentralPolicySetting,
  type ClientInstanceId,
  type AuthenticatedIdentity,
  type CollaborationWorkspaceId,
  type ConversationId,
  type JsonObject,
  type LiveOnceSwitchStore,
  type Logger,
  type ModuleSnapshot,
  type NewOperationRun,
  type OperationApproval,
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
  type OperationRunEnd,
  type OperationRunStore,
  type PlatformEventAnswer,
  type PlatformEventContext,
  type PlatformEventEmitter,
  type PlatformEventName,
  type PlatformEventPhase,
  type PersonPolicySetting,
  type PolicyDefaults,
  type PolicySource,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { toolOutput, shownBesideOutput, toolAuditFields } from "./tool-results";
import { failureLogFields } from "./tool-failure-log";
import {
  OperationCallStoppedError,
  OperationNotBegunError,
  startOperationCall,
  type DirectDecision
} from "./operation-call";

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
    /** Who decides it, where the operation names them: see `approval` of its definition. */
    approval?: OperationApproval;
    /**
     * The request is the confirmation of the person the call acts for, who is not present:
     * it is addressed to them alone and decided in their Inbox (OP-4b).
     */
    confirmation?: true;
  }): Promise<{ approvalRequestId: string } | undefined>;
}

/** The use rights whose refusal is worded for the person: they reach a resource through an agent. */
const USE_RIGHT_ACTIONS = ["knowledge_base.use", "connection.use"] as const;
export type UseRightAction = (typeof USE_RIGHT_ACTIONS)[number];

export function isUseRightAction(action: string | undefined): action is UseRightAction {
  return USE_RIGHT_ACTIONS.some((use) => use === action);
}

export interface RunOperationDeps {
  clientInstanceId: ClientInstanceId;
  registry: OperationRegistry;
  /** One active administrator the person can ask after a refused call. */
  instanceAdminName?(): Promise<string | undefined>;
  /** Resolves a declared resource to its retained asset identity and owner before authorization. */
  resolveResource(resource: OperationResource | undefined): Promise<{
    resource: OperationResource | undefined;
    /** Answered only after the caller holds the kind-level right. */
    resourceNotFound?: string;
  }>;
  runs: OperationRunStore;
  authorizer: Authorizer;
  events: PlatformEventEmitter;
  audit: AuditRecorder;
  policy: {
    instanceDefaults: PolicyDefaults;
    /** The admin's settings. OP-2 supplies the table; nothing is set before. */
    centralSettings(): readonly CentralPolicySetting[] | Promise<readonly CentralPolicySetting[]>;
    /** Includes a subagent's root conversation. Rechecked whenever policy is resolved. */
    personalConversation?(id: ConversationId, runId?: AgentRunId): Promise<boolean>;
    /**
     * A person's own setting for an operation (OP-6), read for each call that acts for them.
     * Without it no person's setting applies.
     */
    personSetting?(input: {
      userId: string;
      operation: string;
    }): Promise<PersonPolicySetting | undefined>;
    /** Operations, by name or pattern, the admin locked against "Always allow" (OP-6). */
    alwaysAllowLocked?: readonly string[];
  };
  /** Without it this process cannot hold a call for an approval and refuses one that needs it. */
  approvals?: OperationApprovalRequests;
  /** Executes a decided agent approval from its frozen request, under the agent's lease. */
  approvedToolCall?(
    run: OperationRun,
    runtime: OperationCallRuntime
  ): Promise<ApprovedOperationEnd | undefined>;
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
  /** Plain, localized help for missing resource use rights, read only after a refusal. */
  useRightRefusal?(action: UseRightAction, locale?: string): Promise<string>;
  /** The persisted workspace of an agent conversation, never chosen by its tool input. */
  conversationWorkspace?(
    conversationId: ConversationId
  ): Promise<CollaborationWorkspaceId | undefined>;
  /**
   * Whether a person works in a workspace now: as its member, or as a holder of Builder or
   * Publisher there. Asked before a call that waited for an approval is executed in a
   * workspace, for an agent's call and for an operation whose right is a named action: whoever
   * left the workspace meanwhile no longer acts there. An operation that decides its right
   * itself is asked by its own rule instead. Without it this process does not ask.
   */
  worksInWorkspace?(input: {
    actor: AuthenticatedIdentity;
    workspaceId: CollaborationWorkspaceId;
  }): Promise<boolean>;
  /**
   * Whether an agent is available in a workspace now, by the rule a new run of it is started
   * under. Asked before an agent's call that waited for an approval is executed in a
   * workspace: an agent that was withdrawn from it meanwhile no longer acts there. Without it
   * this process does not ask. With an actor it also asks whether that person may use the
   * agent there (`agent.use`, AGENT-USE-1); with a correlation id as well, a refusal of the
   * right is recorded under it, as a subagent start's.
   */
  agentAvailable?(input: {
    agentName: string;
    workspaceId: CollaborationWorkspaceId;
    actor?: AuthenticatedIdentity;
    correlationId?: string;
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
  /** Validated input of a newly held approval, for the paused step and its preview. */
  waitingInput?: unknown;
  /**
   * The call left no Operation Run: an allowed read of an operation that does not record
   * every call. `run` then says how the call went and is in no store.
   */
  unrecorded?: true;
  /** A test run's call whose `confirm` the tester's start met: a published run asks approval. */
  publishedWouldAsk?: "approval";
}

export type OperationEnding = Pick<
  OperationOutcome,
  "result" | "run" | "toolResult" | "waitingInput"
>;

/**
 * What became of a call that was approved. `refused` is a call that was not executed because
 * it may no longer run as the person who made it; `expired` one whose time ran out first.
 */
export type ApprovedOperationEnd = {
  run?: OperationRun;
  /** What the call path answered, where the call was executed or refused on it. */
  outcome?: OperationEnding;
} & (
  | { execution: "done" }
  | { execution: "failed" | "interrupted" | "refused"; error: { code: string; message: string } }
  | { execution: "expired" }
  /**
   * A call its person confirmed in the Inbox that now waits for another person's approval,
   * as their own direct call would have (OP-4b): `approvalRequestId` is that request.
   */
  | { execution: "held"; approvalRequestId: string }
);

/** One run with what its call path needs to record how it goes on. */
export interface RunContext {
  run: OperationRun;
  definition: OperationDefinition;
  call: OperationCall;
  resource: OperationResource | undefined;
  resourceNotFound?: string;
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
  /** Set once another writer ended or took over the run: this call emits no further event. */
  overtaken?: boolean;
  publishedWouldAsk?: "approval";
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
    phase: PlatformEventPhase,
    payload?: JsonObject,
    /** What a before-event's guardrails read, and the subject where it is not the call's. */
    before?: Pick<PlatformEventContext, "checkable" | "filterBy" | "aboutGuardrails"> & {
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
    | "run"
    | "definition"
    | "call"
    | "resource"
    | "resourceNotFound"
    | "deps"
    | "runtime"
    | "repeated"
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
    emit: (name, phase, payload = {}, { subject: about, ...asked } = {}) => {
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
            subject: about ?? subject,
            phase,
            // What a before-event's guardrails read and narrow by, as its caller handed it.
            ...asked,
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
  return toolName === definition.name &&
    (listed.includes(toolName) ||
      (isKnowledgeAddFilesOperation(toolName) && listed.includes(KNOWLEDGE_ADD_FILES_TOOL_NAME)))
    ? { allowed: true }
    : { allowed: false, action: `${AGENT_TOOL_ACTION_PREFIX}${toolName}`, reason: "no_grant" };
}

/** Asks the actor's right: the one the operation names, or the operation's own check. */
export async function authorizeActor(
  context: Pick<RunContext, "definition" | "call" | "resource" | "resourceNotFound" | "runtime">,
  access: ActorAccess
): Promise<OperationAuthorization> {
  const { definition, call, resource } = context;
  if (definition.action !== null) {
    const decision = namedRight(access.authorize(definition.action, resource), definition.action);
    if (decision.allowed && context.resourceNotFound)
      throw new AppError("NOT_FOUND", context.resourceNotFound);
    return decision;
  }
  return definition.authorize(call.input, {
    modelRoutes: context.runtime.modelRoutes,
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
  context.overtaken = true;
  if (!current) throw new AppError("INTERNAL", "The operation run is unavailable");
  return current;
}

/** Answers from the winning writer, as a retry of the same call would. */
function storedEnding(context: RunContext, run: OperationRun): OperationEnding {
  return {
    result: recordedResult(
      run,
      context.definition,
      context.definition.inputWithoutSecrets?.(context.call.input) !== undefined
    ),
    run
  };
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
  if (ended.status === "pending_approval" || ended.status === "pending_confirmation") {
    throw new AppError("INTERNAL", "A reading call cannot wait for a decision");
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
  if (context.overtaken) return storedEnding(context, denied);
  await context.emit("operation.denied", "after", { status: "denied", reason: end.error.code });
  return { result: { status: "denied", runId: context.run.id, reason: denial }, run: denied };
}

export type { DirectDecision } from "./operation-call";

/**
 * Executes a call that passed its checks under one deadline and records how it ended.
 * An implementation's own right refusal ends it as denied.
 */
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
  let executing: ReturnType<typeof startOperationCall> | undefined;
  try {
    if (!begin && !context.runtime.resumeReadingRunId)
      await context.emit("operation.started", "after", { status: "success" });
    let joinedRunId: OperationExecutionContext["runId"] | undefined;
    const execution: OperationExecutionContext = {
      joinAsyncRun: (id) => {
        joinedRunId = id;
      },
      runId: run.id,
      actor: call.actor,
      origin: call.origin,
      workspaceId: call.workspaceId,
      correlationId: call.correlationId,
      ...(run.idempotencyKey === undefined ? {} : { idempotencyKey: run.idempotencyKey }),
      runtime: context.runtime,
      access,
      audit: auditForRun(deps.audit, run.id, call.correlationId),
      target: run.target,
      ...(context.beforeEvents ? { beforeEvents: context.beforeEvents } : {})
    };
    await begin?.();
    executing = startOperationCall(
      definition,
      call.input,
      execution,
      now(),
      begin ? undefined : run.startedAt
    );
    started = true;
    // With `begin` the call is said to have started once it has: nothing may be awaited before.
    if (begin)
      await executing.wait(context.emit("operation.started", "after", { status: "success" }));
    const answer = await executing.answer;
    if (definition.completion) {
      if (joinedRunId && joinedRunId !== run.id) {
        const joined = await deps.runs.get({
          clientInstanceId: run.clientInstanceId,
          id: joinedRunId
        });
        if (!joined || joined.operation !== definition.name)
          throw new AppError("INTERNAL", "The joined operation run is unavailable");
        const ended = await endRun(context, {
          status: "done",
          finishedAt: now().toISOString(),
          resultRef: `operation_run:${joinedRunId}`
        });
        if (context.overtaken) return storedEnding(context, ended);
        await context.emit("operation.completed", "after", { status: "success" });
        const result: OperationResult =
          joined.status === "done"
            ? { status: "done", runId: joined.id, output: joined.output?.value }
            : joined.status === "failed"
              ? {
                  status: "failed",
                  runId: joined.id,
                  error: joined.error ?? {
                    code: "INTERNAL",
                    message: "The joined operation failed"
                  }
                }
              : { status: "running", runId: joined.id };
        return { result, run: joined };
      }
      // The work goes on after the call. Whoever carries it out ends the run with its result.
      return { result: { status: "running", runId: run.id }, run };
    }
    if (isToolOperationAnswer(answer) && answer.result.status !== "success") {
      return await endToolFailure(context, answer.result);
    }
    const tool = isToolOperationAnswer(answer) ? answer : undefined;
    const answered: unknown = tool ? toolOutput(tool.result) : answer;
    const output = context.runtime.captureOutput
      ? await executing.wait(context.runtime.captureOutput(answered))
      : answered;
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
      ...(definition.personalConnection
        ? { resultBytes: Buffer.byteLength(JSON.stringify(output) ?? "null", "utf8") }
        : {}),
      output: definition.personalConnection
        ? undefined
        : context.runtime.pageCounts
          ? retainedOutput(context.runtime.pageCounts)
          : definition.effect === "changing" && !definition.secret
            ? retainedOutput(output)
            : undefined,
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
    if (context.overtaken) return storedEnding(context, done);
    completed = { ...completed, run: done };
    await context.emit("operation.completed", "after", {
      status: "success",
      // Why the call ran without anybody asked, where its caller's own call is not why.
      ...(decision?.reason ? { decisionReason: decision.reason } : {}),
      ...(tool ? toolAuditFields(tool.result) : {})
    });
    if (definition.events?.after) await context.emit(definition.events.after, "after");
    return completed;
  } catch (error) {
    if (context.overtaken) throw error;
    if (error instanceof OperationNotBegunError) throw error;
    if (error instanceof OperationCallStoppedError) {
      const stop = new OperationExecutionStop(error.kind, error.reason);
      let ending: OperationEnding;
      let stoppedResult: Promise<ToolExecutionResult | undefined> | undefined;
      try {
        if (error.kind === "aborted") {
          // A lost paging lease leaves its checkpoint open for the next worker.
          if (context.runtime.readPages) throw context.runtime.signal?.reason;
          const interrupted = await endRun(context, {
            status: "failed",
            finishedAt: now().toISOString(),
            error: INTERRUPTED_RUN_ERROR
          });
          if (context.overtaken) return storedEnding(context, interrupted);
          return {
            result: { status: "failed", runId: run.id, error: INTERRUPTED_RUN_ERROR },
            run: interrupted
          };
        }
        ending = await failRun(context, error.reason, !started);
      } finally {
        // Persist the terminal outcome before an abort handler can finish its work.
        stoppedResult = executing?.abort(stop);
      }
      if (context.overtaken) return ending;
      // Only a tool that explicitly participates in stopping can delay this answer for its
      // cancellation write. An uncooperative implementation is never awaited again.
      const toolResult = await stoppedResult?.catch(() => undefined);
      return toolResult?.status === "timed_out" ? { ...ending, toolResult } : ending;
    }
    // A deferred page keeps the one reading Operation Run open for the next leased attempt.
    if (
      context.runtime.readPages &&
      (error instanceof JobDeferredError || context.runtime.signal?.aborted)
    )
      throw error;
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
      return await denyRun(context, {
        kind: "forbidden",
        ...refused.data.details,
        message: refused.data.message
      });
    }
    // An implementation that rolled back whole says so; every other one may have changed something.
    return await failRun(context, error, !started || (isAppError(error) && error.changedNothing));
  } finally {
    executing?.close();
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
  if (context.overtaken) return storedEnding(context, failed);
  await context.emit("operation.failed", "after", {
    status: "failed",
    reason: error.code,
    ...toolAuditFields(result)
  });
  return { result: { status: "failed", runId: run.id, error }, run: failed, toolResult: result };
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
  const reason =
    connectionCallReasonOf(error) ?? dataStoreRefusalOf(error) ?? mailSendReasonOf(error);
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
  if (context.overtaken) return storedEnding(context, failed);
  await context.emit("operation.failed", "after", { status: "failed", reason: safe.code });
  // The envelope drops the details of a 5xx, a timeout among them. The fixed reason stays.
  const retry = z
    .object({ retryAfterSeconds: z.number().finite().nonnegative() })
    .safeParse(isAppError(error) ? error.details : undefined);
  const original = detailsRecord(safe.details) ?? (reason ? { reason } : undefined);
  const details = retry.success ? { ...original, ...retry.data } : original;
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
    reason: z.enum(OPERATION_DENIAL_REASONS)
  })
});

function detailsRecord(details: unknown): Record<string, unknown> | undefined {
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : undefined;
}
