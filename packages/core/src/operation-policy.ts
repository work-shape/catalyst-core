import type {
  OPERATION_CHANGE_CLASSES,
  PERSON_POLICY_SETTINGS
} from "@work-shape/catalyst-asset-schemas";
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
 * (`connection.crm.*`). It may be narrowed to a workspace and an asset kind, and then
 * applies only to a call one of whose targets carries the same.
 */
export interface CentralPolicySetting {
  operation: string;
  value: PolicyValue;
  workspaceId?: string;
  assetKind?: string;
}

/**
 * One thing a call touches, as far as a central setting can be narrowed to it. A call on one
 * asset has one target and a batch has one for each asset it names.
 */
export interface PolicyTarget {
  workspaceId?: string;
  assetKind?: string;
}

/**
 * A person's own value for an operation (OP-6): Always allow, Ask me or Never. It applies to
 * the calls that act for that person: their agents' calls, in chat and in their scheduled runs.
 */
export type PersonPolicySetting = (typeof PERSON_POLICY_SETTINGS)[number];

type OperationChangeClass = (typeof OPERATION_CHANGE_CLASSES)[number];

/**
 * Whether people may always allow a change of each class where no admin locked the operation.
 * A change that declares no class counts as `irreversible`.
 */
export const ALWAYS_ALLOW_BY_CLASS: Readonly<Record<OperationChangeClass, boolean>> = {
  reversible: true,
  irreversible: false,
  outward: false
};

/**
 * Whether people may set "Always allow" for an operation: only a change, only where its class
 * allows it, and only where no lock of the admin names it, by its name or by a pattern such as
 * `connection.crm.*`. The strictest of what matches wins, so a lock only ever takes it away.
 */
export function mayAlwaysAllow(
  definition: { name: string; effect: OperationEffect; changeClass?: OperationChangeClass },
  locked: readonly string[] = []
): boolean {
  return (
    definition.effect === "changing" &&
    ALWAYS_ALLOW_BY_CLASS[definition.changeClass ?? "irreversible"] &&
    !locked.some((pattern) => namesOperation(pattern, definition.name))
  );
}

/** What the person a call acts for set for its operation, and what the admin permits them. */
export interface PolicyPerson {
  setting?: PersonPolicySetting;
  /** `mayAlwaysAllow` for the operation: without it "Always allow" changes nothing. */
  mayAlwaysAllow: boolean;
}

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
  /**
   * The person the call acts for, where it acts for one who sets their own values: an agent's
   * call for its person, in chat or in their scheduled run. Never a Workflow's call, and never
   * another person's setting.
   */
  person?: PolicyPerson;
  /** What the guardrails of the before-event answered, once they ran. */
  guardrailOutcome?: PlatformEventOutcome;
  /** Whether the call is its caller's own confirmation: `callerCanConfirm(origin)`. */
  callerCanConfirm: boolean;
  /** Whether the surface can hold the call until the person it acts for confirmed it. */
  canPause: boolean;
  /**
   * Whether the call acts for a person who is not present: an agent's call in a run marked
   * unattended (EW-8), or a CLI call sent with `Catalyst-Unattended: 1`. A confirmation it
   * asks for waits in that person's Inbox (OP-4b). A subagent's call never is one.
   */
  personAbsent?: boolean;
  /**
   * Whether the call is a step of a run of a published Workflow revision: a run from a
   * schedule, or a manual or a parent's start of what is published, never a test run of a
   * draft. Its publisher approved its changing operations when publishing, so a `confirm`
   * runs. A floor, a `deny`, an `approval` and a guardrail still hold it.
   */
  publishedRun?: boolean;
  /** Whether the Workflow of that published run was deleted since: its publish approves nothing. */
  workflowDeleted?: boolean;
}

export type PolicySource =
  | "instance_default"
  | "declared_default"
  /** The operation's `policyFloor`: what it declares, or what an operation it stands for asks. */
  | "policy_floor"
  | "central_setting"
  /** The person's own Never, Ask me or Always allow. */
  | "person_setting"
  | "guardrail"
  | "surface_cannot_pause"
  /** A `confirm` the publish of a Workflow approved, whose Workflow was deleted since. */
  | "workflow_deleted";

/** Where the confirmation of a call is asked: in the conversation, or in the person's Inbox. */
export type ConfirmationDelivery = "conversation" | "inbox";

/** The value that applies to a call, where it comes from, and how the call goes on. */
export type PolicyResolution = { source: PolicySource } & (
  | { value: "allow"; next: "run" }
  /** The call runs without a prompt, and this is recorded as the run's decision. */
  | {
      value: "confirm";
      next: "run";
      decisionMode: "direct";
      /**
       * Why nobody was asked, where the caller's own call is not why: the instance default
       * asked for an approval, which a secret answer cannot wait for; or the call is a step of
       * a published Workflow, whose publish was its confirmation.
       */
      decisionReason?: OperationRunDecisionReason;
    }
  /**
   * `deliver`: where the person the call acts for is asked. In the conversation, where its
   * run pauses; in their Inbox, where nobody is present to be asked (OP-4b).
   */
  | { value: "confirm"; next: "await_confirmation"; deliver: ConfirmationDelivery }
  | { value: "approval"; next: "await_approval" }
  | { value: "deny"; next: "refuse" }
);

/**
 * The one function that says what the policy asks of a call. The base is the operation's
 * declared default or, without one, the instance default of its effect. An operation whose
 * answer holds a secret takes an instance default of `approval` as `confirm`. A central setting
 * replaces the base, and of several that match the strictest wins. A call with several targets
 * takes the strictest of what each target resolves to. An operation's `policyFloor` then
 * tightens what came of it and never loosens it. A guardrail can only tighten. Reading
 * operations ignore waiting defaults and settings unless an explicit `confirm` or `approval`
 * floor makes the call able to wait. A step of a run of a published Workflow revision runs
 * a `confirm`: the publish was
 * its confirmation, until the Workflow is deleted: its run's `confirm` is then refused. Any other step of a Workflow Run has nobody to ask and acts for nobody who
 * could be asked later, so its `confirm` is an `approval`; so is a published run's `confirm`
 * that an operation's floor asks for, which no setting and no publish lowers. A surface that can neither confirm nor pause is
 * refused a call that would have to wait for its own caller's confirmation. A call that acts
 * for a person who is not present waits for that person's confirmation in their Inbox, as the
 * last step of the order. A call that needs another person's approval waits from every surface.
 */
export function resolvePolicy(input: PolicyInput): PolicyResolution {
  const { definition } = input;
  // Ordinary reads ignore waiting defaults/settings. An explicit floor is a boundary:
  // an MCP read carrying private arguments must be able to wait just like a change.
  const readingMayWait =
    definition.policyFloor === "confirm" || definition.policyFloor === "approval";
  const applies = (value: PolicyValue | undefined): value is PolicyValue =>
    value !== undefined &&
    (definition.effect === "changing" || readingMayWait || value === "allow" || value === "deny");

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
  // The person's own setting comes after what the admin and the operation say and before the
  // floors: it raises any value and lowers only `confirm`, and only where the admin permits.
  const person = input.person;
  if (person?.setting === "never" && value !== "deny") {
    value = "deny";
    source = "person_setting";
  } else if (person?.setting === "ask" && value === "allow") {
    // A read the person wants to be asked about waits too, for their agents' calls.
    value = "confirm";
    source = "person_setting";
  } else if (person?.setting === "always_allow" && person.mayAlwaysAllow && value === "confirm") {
    value = "allow";
    source = "person_setting";
  }
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
      if (
        input.publishedRun &&
        input.origin.kind === "workflow" &&
        !holdsForPublishedRun(definition.policyFloor)
      ) {
        if (input.workflowDeleted)
          return { value: "deny", next: "refuse", source: "workflow_deleted" };
        return {
          value,
          next: "run",
          decisionMode: "direct",
          source,
          decisionReason: "workflow_publish"
        };
      }
      if (hasNobodyToAsk(input.origin)) {
        // A published run would pass a confirm without this floor, even when the default
        // already met it. Name the floor that actually prevents that pass (PUBQ-1).
        if (input.publishedRun && holdsForPublishedRun(definition.policyFloor)) {
          source = "policy_floor";
        }
        return { value: "approval", next: "await_approval", source };
      }
      if (input.personAbsent) {
        return { value, next: "await_confirmation", deliver: "inbox", source };
      }
      return input.canPause
        ? { value, next: "await_confirmation", deliver: "conversation", source }
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

/**
 * Whether an operation's floor keeps a published run's call waiting: a floor of `confirm` or
 * stricter is what the operation, or what it stands for, asks of every call, and no publish
 * gives that.
 */
export function holdsForPublishedRun(floor: PolicyValue | undefined): boolean {
  return floor !== undefined && floor !== "allow";
}

function stricter(left: PolicyValue, right: PolicyValue): PolicyValue {
  return POLICY_VALUES.indexOf(left) >= POLICY_VALUES.indexOf(right) ? left : right;
}

/**
 * Whether "Always allow" would let this call run without asking: it waits for its person's
 * confirmation now, the admin permits it, and with the person's "Always allow" nothing else
 * (a floor, a guardrail, an `approval`) would still hold it. The card offers it only then.
 */
export function offersAlwaysAllow(input: PolicyInput, resolution: PolicyResolution): boolean {
  if (resolution.next !== "await_confirmation" || !input.person?.mayAlwaysAllow) return false;
  return (
    resolvePolicy({ ...input, person: { ...input.person, setting: "always_allow" } }).next === "run"
  );
}

/** Whether a setting's operation, a name or a pattern such as `connection.crm.*`, names one. */
function namesOperation(pattern: string, operation: string): boolean {
  return pattern.endsWith(".*")
    ? operation.startsWith(pattern.slice(0, -1))
    : pattern === operation;
}

function matches(setting: CentralPolicySetting, operation: string, target: PolicyTarget): boolean {
  const named = namesOperation(setting.operation, operation);
  return (
    named &&
    (setting.workspaceId === undefined || setting.workspaceId === target.workspaceId) &&
    (setting.assetKind === undefined || setting.assetKind === target.assetKind)
  );
}
