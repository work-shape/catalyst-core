import { createHash } from "node:crypto";
import {
  AGENT_TOOL_ACTION_PREFIX,
  callerCanConfirm,
  isToolOperationAnswer,
  moduleOffError,
  operationDenialError,
  resolvePolicy,
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
  type Logger,
  type ModuleSnapshot,
  type OperationAuthorization,
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
  type OperationRunId,
  type OperationRunStore,
  type PlatformEventEmitter,
  type PlatformEventName,
  type PlatformEventOutcome,
  type PolicyDefaults,
  type PolicyInput,
  type PolicyResolution,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import { z } from "zod";
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
    resource: OperationResource | undefined;
    /** What the live call has. An agent's call carries the hold of its run here. */
    runtime: OperationCallRuntime;
    expiresAt: string;
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
  /** Which modules are on. An operation or a tool of a module that is off does not exist. */
  modules?: ModuleSnapshot;
  /**
   * The tools an agent's definition lists. An agent calls nothing else. Without it this
   * process serves no agent and refuses every call of one.
   */
  agentToolNames?(agentName: string): readonly string[] | Promise<readonly string[]>;
  /**
   * Whether a person is a member of a workspace now. Asked before a call that waited for an
   * approval is executed in a workspace: whoever left it meanwhile no longer acts there.
   * Without it this process does not ask.
   */
  workspaceMember?(input: {
    userId: string;
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
  now(): Date;
  emit(
    name: PlatformEventName,
    phase: "before" | "after",
    payload?: JsonObject
  ): Promise<PlatformEventOutcome>;
}

export function createRunContext(
  input: Pick<RunContext, "run" | "definition" | "call" | "resource" | "deps" | "runtime">
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
  return {
    ...input,
    now: deps.now ?? (() => new Date()),
    emit: (name, phase, payload = {}) =>
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
          subject,
          phase
        }
      )
  };
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
 * agent calls the tools its definition lists and nothing else. Every other origin has no rule
 * of its own here.
 */
export async function authorizeOrigin(
  call: OperationCall,
  definition: OperationDefinition,
  deps: RunOperationDeps
): Promise<OperationAuthorization> {
  if (call.origin.kind !== "agent") {
    return { allowed: true };
  }
  const { agentName, toolName } = call.origin;
  const listed = (await deps.agentToolNames?.(agentName)) ?? [];
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
  return {
    definition,
    origin: call.origin,
    instanceDefaults: deps.policy.instanceDefaults,
    centralSettings: await deps.policy.centralSettings(),
    // An operation says itself what the policy is asked about where its resource does not
    // say it all. It is asked again, the same way, before a call that waited is executed.
    targets: definition.policyTargets
      ? await definition.policyTargets(call.input)
      : [{ workspaceId: call.workspaceId, assetKind: resource?.kind }],
    callerCanConfirm: callerCanConfirm(call.origin),
    // No surface can hold a call for its actor's confirmation before OP-3.
    canPause: false
  };
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
  const guardrailOutcome = strictestOutcome([
    await context.emit("operation.before_call", "before"),
    ...(definition.events?.before ? [await context.emit(definition.events.before, "before")] : [])
  ]);
  const policy = resolvePolicy({ ...policyInput, guardrailOutcome });
  if (policy.next !== "refuse") {
    return { policy };
  }
  return {
    denial:
      policy.source === "guardrail"
        ? // The emitter names no guardrail yet, so the event that asked stands in for it.
          { kind: "guardrail", guardrailId: definition.events?.before ?? "operation.before_call" }
        : { kind: "policy", operation: definition.name }
  };
}

const OUTCOME_ORDER: readonly PlatformEventOutcome[] = [
  "allow",
  "warn",
  "require_approval",
  "block"
];

function strictestOutcome(outcomes: readonly PlatformEventOutcome[]): PlatformEventOutcome {
  return outcomes.reduce(
    (left, right) => (OUTCOME_ORDER.indexOf(left) >= OUTCOME_ORDER.indexOf(right) ? left : right),
    "allow"
  );
}

/** Ends a run that is still `running`. The run as it was when something else ended it first. */
export async function endRun(context: RunContext, ended: OperationRunEnd): Promise<OperationRun> {
  const { run, definition, deps } = context;
  const finished = await deps.runs.finish({
    clientInstanceId: deps.clientInstanceId,
    id: run.id,
    end: ended
  });
  if (!finished) {
    // Something else ended the run meanwhile, such as the sweep for interrupted runs.
    deps.logger.warn(
      { operationRunId: run.id, operation: definition.name, status: ended.status },
      "Operation run was no longer running when its call ended"
    );
  }
  return finished ?? run;
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
export async function executeAdmitted(
  context: RunContext,
  access: ActorAccess,
  /** The decision of a call that ran on its own caller's word. An approved run has its own. */
  decisionMode?: "direct"
): Promise<OperationEnding> {
  const { run, definition, call, deps, now } = context;
  let completed: OperationEnding | undefined;
  let started = false;
  try {
    await context.emit("operation.started", "after", { status: "success" });
    const execution: OperationExecutionContext = {
      runId: run.id,
      actor: call.actor,
      origin: call.origin,
      workspaceId: call.workspaceId,
      correlationId: call.correlationId,
      runtime: context.runtime,
      access,
      audit: auditForRun(deps.audit, run.id, call.correlationId)
    };
    started = true;
    const answer = await definition.execute(call.input, execution);
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
      output: definition.effect === "changing" ? retainedOutput(output) : undefined,
      usage: tool?.usage,
      ...(decisionMode
        ? { decision: { mode: decisionMode, by: run.actor.id, at: now().toISOString() } }
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
    if (refused.success) return denyRun(context, { kind: "forbidden", ...refused.data.details });
    return failRun(context, error, !started);
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
    error: { code: safe.code, message: safe.message, ...(unexecuted ? { unexecuted } : {}) }
  });
  await context.emit("operation.failed", "after", { status: "failed", reason: safe.code });
  const details = detailsRecord(safe.details);
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
  details: z.object({
    action: z.string(),
    reason: z.enum(["no_grant", "denied", "unknown_action", "holder_inactive"])
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

/** The hash a run keeps in place of its input: SHA-256 over the input with sorted keys. */
export function hashInput(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(unknownToJsonValue(input)))
    .digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
