import type { PlatformEventOutcome } from "./events";
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
 * applies only to a call whose target carries the same.
 */
export interface CentralPolicySetting {
  operation: string;
  value: PolicyValue;
  workspaceId?: string;
  assetKind?: string;
  namespace?: string;
}

/** What a call touches, as far as a central setting can be narrowed to it. */
export interface PolicyTarget {
  workspaceId?: string;
  assetKind?: string;
  namespace?: string;
}

/** A person's own value for an operation. OP-6 supplies it; nothing reads it before. */
export type PersonPolicySetting = "always_allow" | "ask" | "never";

export interface PolicyInput {
  definition: { name: string; effect: OperationEffect; defaultPolicy?: PolicyValue };
  origin: OperationOrigin;
  instanceDefaults: PolicyDefaults;
  centralSettings: readonly CentralPolicySetting[];
  target?: PolicyTarget;
  personSetting?: PersonPolicySetting;
  /** What the guardrails of the before-event answered, once they ran. */
  guardrailOutcome?: PlatformEventOutcome;
  /** Whether the call is its caller's own confirmation: `callerCanConfirm(origin)`. */
  callerCanConfirm: boolean;
  /** Whether the surface can hold the call until somebody else decided. */
  canPause: boolean;
}

export type PolicySource =
  | "instance_default"
  | "declared_default"
  | "central_setting"
  | "guardrail"
  | "surface_cannot_pause";

/** The value that applies to a call, where it comes from, and how the call goes on. */
export type PolicyResolution = { source: PolicySource } & (
  | { value: "allow"; next: "run" }
  /** The caller's own call is the confirmation, recorded as the run's decision. */
  | { value: "confirm"; next: "run"; decisionMode: "direct" }
  | { value: "confirm"; next: "await_confirmation" }
  | { value: "approval"; next: "await_approval" }
  | { value: "deny"; next: "refuse" }
);

/**
 * The one function that says what the policy asks of a call. The base is the operation's
 * declared default or, without one, the instance default of its effect. A central setting
 * replaces the base, and of several that match the strictest wins. A guardrail can only
 * tighten. `confirm` and `approval` are values of changing operations: on a reading operation
 * they do not apply, wherever they come from, so a reading operation resolves to `allow` or
 * `deny`. A surface that can neither confirm nor pause is refused what would have to wait.
 */
export function resolvePolicy(input: PolicyInput): PolicyResolution {
  const { definition } = input;
  const applies = (value: PolicyValue | undefined): value is PolicyValue =>
    value !== undefined &&
    (definition.effect === "changing" || value === "allow" || value === "deny");

  let value: PolicyValue = input.instanceDefaults[definition.effect];
  let source: PolicySource = "instance_default";
  if (!applies(value)) {
    // An instance default that names a waiting value for reads leaves them allowed.
    value = "allow";
  }
  if (applies(definition.defaultPolicy)) {
    value = definition.defaultPolicy;
    source = "declared_default";
  }
  const central = input.centralSettings
    .filter((setting) => matches(setting, definition.name, input.target ?? {}))
    .map((setting) => setting.value)
    .filter(applies);
  if (central.length > 0) {
    value = central.reduce(stricter);
    source = "central_setting";
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
      if (input.callerCanConfirm) return { value, next: "run", decisionMode: "direct", source };
      return input.canPause
        ? { value, next: "await_confirmation", source }
        : { value: "deny", next: "refuse", source: "surface_cannot_pause" };
    case "approval":
      return input.callerCanConfirm || input.canPause
        ? { value, next: "await_approval", source }
        : { value: "deny", next: "refuse", source: "surface_cannot_pause" };
  }
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
