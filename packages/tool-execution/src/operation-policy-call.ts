import {
  POLICY_VALUES,
  callConfirmedByCaller,
  type ActorAccess,
  type OperationApproval,
  type OperationCall,
  resolvePolicy,
  strictestOutcome,
  type OperationDenial,
  type PolicyInput,
  type PolicyResolution,
  type PolicyValue
} from "@work-shape/catalyst-core";
import {
  approvalAskedBy,
  askBeforeEvents,
  guardrailDenial,
  type GuardrailNamed
} from "./before-events";
import type { RunContext } from "./operation-execution";

// What the policy asks of one call: what it is resolved from, and what the guardrails of the
// call's before-events add to it.

/** What the policy is resolved from for this call, before a guardrail answered. */
async function policyInputOf(
  context: Pick<RunContext, "definition" | "call" | "resource" | "deps" | "runtime">
): Promise<PolicyInput> {
  const { definition, call, resource, deps, runtime } = context;
  const callFloor = await definition.policyFloorOf?.(call.origin, call.input);
  const workerCall =
    call.origin.kind === "agent" && runtime.runFence?.runId === call.origin.agentRunId;
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
    callerCanConfirm: callConfirmedByCaller(call),
    // A step of a run of what is published carries no draft; one of a test run always does.
    publishedRun: call.origin.kind === "workflow" && call.draft === undefined,
    workflowDeleted: call.workflowDeleted === true,
    // Only an Agent Run's worker holds a call for its actor's confirmation: the run pauses
    // and resumes when its person decided. The hold of the run says the worker makes the call.
    canPause: workerCall,
    // Nobody present who could be asked, while the call acts for a person: a run marked
    // unattended, in its worker, or a CLI call sent unattended. A subagent's call never is
    // one: it is refused before it could wait (CR-1).
    personAbsent:
      (workerCall && runtime.unattended === true && runtime.subagent !== true) ||
      (call.origin.kind === "cli" && call.origin.unattended === true)
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
): Promise<
  { policy: PolicyResolution; approvalAskedBy?: GuardrailNamed } | { denial: OperationDenial }
> {
  const { definition } = context;
  const policyInput = await policyInputOf(context);
  const before = resolvePolicy(policyInput);
  if (before.next === "refuse") return { denial: policyDenial(before, definition.name) };
  const answers = await askBeforeEvents(context);
  const guardrailOutcome = strictestOutcome(answers.map((answer) => answer.outcome));
  const policy = resolvePolicy({ ...policyInput, guardrailOutcome });
  if (confirmsFirst(context.call, before, policy)) return { policy: before };
  if (policy.next !== "refuse") {
    const asking = policy.source === "guardrail" ? approvalAskedBy(answers) : undefined;
    return { policy, ...(asking ? { approvalAskedBy: asking } : {}) };
  }
  return {
    denial:
      policy.source === "guardrail"
        ? guardrailDenial(answers, definition.events?.before ?? "operation.before_call")
        : policyDenial(policy, definition.name)
  };
}

/**
 * Whether the person an unattended CLI call acts for confirms it before anybody approves it:
 * their Allow in the Inbox makes it their own call, which is asked the guardrails again and
 * then waits for the approvers where one still asks (Confirmation in the Inbox, check 33).
 */
function confirmsFirst(
  call: Pick<OperationCall, "origin">,
  before: PolicyResolution,
  policy: PolicyResolution
): boolean {
  return (
    call.origin.kind === "cli" &&
    before.next === "await_confirmation" &&
    before.deliver === "inbox" &&
    policy.next === "await_approval"
  );
}

/** The refusal of a call the policy itself refused, with why where a reason names it. */
function policyDenial(policy: PolicyResolution, operation: string): OperationDenial {
  return policy.source === "workflow_deleted"
    ? { kind: "policy", operation, reason: "workflow_deleted" }
    : { kind: "policy", operation };
}

/**
 * Whether the caller's own call is the approval a guardrail asked for: they hold the right at
 * instance scope and clicked in the interface. A CLI origin never counts: the server cannot
 * tell a person at a terminal from an agent driving it.
 */
export function approvedByCaller(
  call: Pick<OperationCall, "origin" | "draft">,
  policy: PolicyResolution,
  approval: OperationApproval,
  access: ActorAccess
): boolean {
  return (
    policy.source === "guardrail" &&
    call.origin.kind === "user" &&
    call.draft === undefined &&
    access.authorize(approval.action).allowed
  );
}
