import {
  POLICY_VALUES,
  callConfirmedByCaller,
  resolvePolicy,
  strictestOutcome,
  type OperationDenial,
  type PolicyInput,
  type PolicyResolution,
  type PolicyValue
} from "@vivd-catalyst/core";
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
    callerCanConfirm: callConfirmedByCaller(call),
    // A step of a run of what is published carries no draft; one of a test run always does.
    publishedRun: call.origin.kind === "workflow" && call.draft === undefined,
    workflowDeleted: call.workflowDeleted === true,
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

/** The refusal of a call the policy itself refused, with why where a reason names it. */
function policyDenial(policy: PolicyResolution, operation: string): OperationDenial {
  return policy.source === "workflow_deleted"
    ? { kind: "policy", operation, reason: "workflow_deleted" }
    : { kind: "policy", operation };
}
