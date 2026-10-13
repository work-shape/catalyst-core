import type { PlatformEventOutcome } from "./events";
import type { OperationRunDecisionReason } from "./operation-runs";
import {
  POLICY_VALUES,
  type OperationEffect,
  type OperationOrigin,
  type PolicyValue
} from "./operations";

/** The policy value of each effect where nothing else names one. */
export type PolicyDefaults = Record<OperationEffect, PolicyValue>;

/**
 * An admin's value for one operation or for every operation under a name prefix
 * (`connections.*`). It may be narrowed to a workspace, an asset kind and a Namespace, and then
 * applies only to a call one of whose targets carries the same.
 */
export interface CentralPolicySetting {
  operation: string;
  value: PolicyValue;
  workspaceId?: string;
  assetKind?: string;
  namespace?: string;
}

/**
 * One thing a call touches, as far as a central setting can be narrowed to it. A call on one
 * asset has one target and a batch has one for each asset it names.
 */
export interface PolicyTarget {
  workspaceId?: string;
  assetKind?: string;
  namespace?: string;
}

/** A person's own value for an operation. OP-6 supplies it; nothing reads it before. */
export type PersonPolicySetting = "always_allow" | "ask" | "never";

export interface PolicyInput {
  definition: {
    name: string;
    effect: OperationEffect;
    defaultPolicy?: PolicyValue;
    /** The answer holds a secret that is shown once, so the call cannot wait for an approval. */
    secret?: true;
    /**
     * A value the call is never looser than, whatever a central setting says. An operation
     * that stands for another one, as a named action of an App stands for the operation of a
     * Connection, carries here what that operation asks. A setting can tighten it further.
     */
    policyFloor?: PolicyValue;
  };
  origin: OperationOrigin;
  instanceDefaults: PolicyDefaults;
  centralSettings: readonly CentralPolicySetting[];
  /**
   * Every target of the call. The policy is resolved for each one from the settings that match
   * it, and the strictest of them is the call's: a setting never loosens another target.
   */
  targets?: readonly PolicyTarget[];
  personSetting?: PersonPolicySetting;
  /** What the guardrails of the before-event answered, once they ran. */
  guardrailOutcome?: PlatformEventOutcome;
  /** Whether the call is its caller's own confirmation: `callerCanConfirm(origin)`. */
  callerCanConfirm: boolean;
  /** Whether the surface can hold the call until the person it acts for confirmed it. */
  canPause: boolean;
}

export type PolicySource =
  | "instance_default"
  | "declared_default"
  /** The operation's `policyFloor`: what it declares, or what an operation it stands for asks. */
  | "policy_floor"
  | "central_setting"
  | "guardrail"
  | "surface_cannot_pause";

/** The value that applies to a call, where it comes from, and how the call goes on. */
export type PolicyResolution = { source: PolicySource } & (
  | { value: "allow"; next: "run" }
  /** The caller's own call is the confirmation, recorded as the run's decision. */
  | {
      value: "confirm";
      next: "run";
      decisionMode: "direct";
      /** The instance default asked for an approval, which a secret answer cannot wait for. */
      decisionReason?: OperationRunDecisionReason;
    }
  | { value: "confirm"; next: "await_confirmation" }
  | { value: "approval"; next: "await_approval" }
  | { value: "deny"; next: "refuse" }
);

/**
 * The one function that says what the policy asks of a call. The base is the operation's
 * declared default or, without one, the instance default of its effect. An operation whose
 * answer holds a secret takes an instance default of `approval` as `confirm`. A central setting
 * replaces the base, and of several that match the strictest wins. A call with several targets
 * takes the strictest of what each target resolves to. An operation's `policyFloor` then
 * tightens what came of it and never loosens it. A guardrail can only tighten. `confirm` and `approval` are values of changing operations: on a reading operation
 * they do not apply, wherever they come from, so a reading operation resolves to `allow` or
 * `deny`. A step of a Workflow Run has nobody to ask and acts for nobody who could be asked
 * later, so its `confirm` is an `approval`. A surface that can neither confirm nor pause is
 * refused a call that would have to wait for its own caller's confirmation. A call that needs
 * another person's approval waits from every surface.
 */
export function resolvePolicy(input: PolicyInput): PolicyResolution {
  const { definition } = input;
  const applies = (value: PolicyValue | undefined): value is PolicyValue =>
    value !== undefined &&
    (definition.effect === "changing" || value === "allow" || value === "deny");

  let value: PolicyValue = input.instanceDefaults[definition.effect];
  let source: PolicySource = "instance_default";
  let inheritedApproval = false;
  if (!applies(value)) {
    // An instance default that names a waiting value for reads leaves them allowed.
    value = "allow";
  }
  if (definition.secret && value === "approval") {
    // An instance that sends every change to an approval did not mean this operation, and a
    // call whose answer is a secret cannot wait: it would make the operation impossible. So
    // the inherited value falls back to the caller's own confirmation. A setting that matches
    // the operation or a guardrail still asks for an approval, and the call is then refused.
    value = "confirm";
    inheritedApproval = true;
  }
  if (applies(definition.defaultPolicy)) {
    value = definition.defaultPolicy;
    source = "declared_default";
  }
  const base: { value: PolicyValue; source: PolicySource } = { value, source };
  // A call that names no target still has one, which carries nothing a setting is narrowed to.
  const targets = input.targets?.length ? input.targets : [{}];
  const perTarget = targets.map((target): typeof base => {
    const central = input.centralSettings
      .filter((setting) => matches(setting, definition.name, target))
      .map((setting) => setting.value)
      .filter(applies);
    return central.length > 0
      ? { value: central.reduce(stricter), source: "central_setting" }
      : base;
  });
  ({ value, source } = perTarget.reduce((left, right) =>
    stricter(left.value, right.value) === left.value ? left : right
  ));
  if (applies(definition.policyFloor) && stricter(value, definition.policyFloor) !== value) {
    // No setting loosens it, and it is named as itself: an approver reads that no setting of
    // the instance made the call wait.
    value = definition.policyFloor;
    source = "policy_floor";
  }

  if (input.guardrailOutcome === "block") {
    return { value: "deny", next: "refuse", source: "guardrail" };
  }
  if (input.guardrailOutcome === "require_approval") {
    // A read cannot wait for somebody, so a guardrail that asks for an approval refuses it.
    const asked: PolicyValue = definition.effect === "changing" ? "approval" : "deny";
    if (stricter(value, asked) !== value) {
      value = asked;
      source = "guardrail";
    }
  }

  switch (value) {
    case "allow":
      return { value, next: "run", source };
    case "deny":
      return { value, next: "refuse", source };
    case "confirm":
      if (input.callerCanConfirm) {
        return {
          value,
          next: "run",
          decisionMode: "direct",
          source,
          // Only where the replaced default is what the call ran under.
          ...(inheritedApproval && source === "instance_default"
            ? { decisionReason: "inherited_approval_not_applied" as const }
            : {})
        };
      }
      if (hasNobodyToAsk(input.origin)) {
        return { value: "approval", next: "await_approval", source };
      }
      return input.canPause
        ? { value, next: "await_confirmation", source }
        : { value: "deny", next: "refuse", source: "surface_cannot_pause" };
    case "approval":
      // No surface has to hold a call for an approval: the run waits, and the decision of the
      // approver executes it. So an agent's call waits for one too.
      return { value, next: "await_approval", source };
  }
}

/**
 * Whether a call that nobody present made also acts for no person who could confirm it later.
 * A run of a Workflow acts as its service principal. An agent's call acts for the person of
 * its conversation, who is asked.
 */
function hasNobodyToAsk(origin: OperationOrigin): boolean {
  return origin.kind === "workflow";
}

function stricter(left: PolicyValue, right: PolicyValue): PolicyValue {
  return POLICY_VALUES.indexOf(left) >= POLICY_VALUES.indexOf(right) ? left : right;
}

function matches(setting: CentralPolicySetting, operation: string, target: PolicyTarget): boolean {
  const named = setting.operation.endsWith(".*")
    ? operation.startsWith(setting.operation.slice(0, -1))
    : setting.operation === operation;
  return (
    named &&
    (setting.workspaceId === undefined || setting.workspaceId === target.workspaceId) &&
    (setting.assetKind === undefined || setting.assetKind === target.assetKind) &&
    (setting.namespace === undefined || setting.namespace === target.namespace)
  );
}
