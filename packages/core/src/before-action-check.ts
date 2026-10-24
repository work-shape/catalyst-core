import type { GuardrailEvent, GuardrailFields, GuardrailSubject } from "./guardrail-events";
import type { GuardrailAnswer, GuardrailFilter } from "./guardrails";
import type { AgentRunId, ConversationId } from "./ids";

// The hook core keeps at every before-event: what an action hands the checks bound to it, and
// what they answer. Guardrails are one check; a capability may contribute others. The caller
// acts on the strictest answer (`strictestOutcome`), so an `allow` never overrides another
// check's warning, hold or block. Spec: core-extraction-guardrails.md, section 3.

/** What a check narrows by. A key the event has no value for matches nothing that names it. */
export type BeforeActionMatch = GuardrailFilter;

/** What a before-event hands the checks bound to it. */
export interface BeforeActionInput {
  event: GuardrailEvent;
  /** What is checked, as a check's record of it names it. */
  subject: GuardrailSubject;
  /** What a check narrows by: the kind, the operation, the origin, the agent, the workspace. */
  match: BeforeActionMatch;
  /** The content under review. Read only where a check applies, and never kept. */
  fields(): GuardrailFields | Promise<GuardrailFields>;
  /**
   * Set where the action writes, publishes, deletes or tests an asset of a kind a check
   * protects (`BeforeActionCheck.protectedKinds`), or reads one to test it. The check then
   * answers only from what no person can change at runtime, so nothing published can stop the
   * change of the checks themselves.
   */
  aboutProtectedKind?: boolean;
}

/** Who and what a check's work is counted for, and how long it may take. */
export interface BeforeActionCallContext {
  correlationId: string;
  userId?: string;
  workspaceId?: string;
  conversationId?: ConversationId;
  /**
   * The agent run that made the call. With `conversationId` it lets a model call of the check
   * read the conversation's personal-data mark, as for a Workflow step's run (MODEL-REGION-3).
   */
  agentRunId?: AgentRunId;
  operationRunId?: string;
  deadline?: Date;
  signal?: AbortSignal;
  /**
   * Set where the event is asked again for the same action, as before a call that waited for
   * an approval is executed: what it answered was kept when it was first asked, and only a
   * block, which is new, is kept again.
   */
  repeated?: boolean;
  /**
   * Set where the action cannot wait for an approval and no request is filed for it: a
   * `require_approval` answers as a `block`.
   */
  cannotWait?: boolean;
}

/** A dry answer: `checked` where the check read the content, not only where it would apply. */
export type BeforeActionPreview = GuardrailAnswer & { checked: boolean };

/**
 * What answers at a before-event. `answer` is asked for an action and may keep a record of
 * what it answered; `preview` is asked for a publish question and keeps nothing, calls no
 * model and executes nothing. A check that throws or does not answer in time refuses the
 * action where `refusingWhenUnavailable` guards it, as the assembly guards every check.
 */
export interface BeforeActionCheck {
  answer(input: BeforeActionInput, context: BeforeActionCallContext): Promise<GuardrailAnswer[]>;
  preview(input: BeforeActionInput, dynamic: boolean): Promise<BeforeActionPreview[]>;
  /**
   * One preview for all steps of one publish question, which may read what is in force once
   * and never across questions. Without it each step's preview reads anew.
   */
  previewSession?(): Pick<BeforeActionCheck, "preview">;
  /** The asset kinds whose changes only this check's fixed part answers. */
  protectedKinds?: readonly string[];
}

/** The check of a process that checks nothing: every before-event allows. */
export const NO_BEFORE_ACTION_CHECK: BeforeActionCheck = {
  answer: () => Promise.resolve([]),
  preview: () => Promise.resolve([])
};

/**
 * Every check as one: their answers in the order of the checks. Each reads the same fields,
 * which are read once. The caller acts on the strictest answer.
 */
export function combineBeforeActionChecks(checks: readonly BeforeActionCheck[]): BeforeActionCheck {
  const [only, ...others] = checks;
  if (!only) return NO_BEFORE_ACTION_CHECK;
  if (others.length === 0) return only;
  const protectedKinds = [...new Set(checks.flatMap((check) => check.protectedKinds ?? []))];
  const previewOf = (previews: readonly Pick<BeforeActionCheck, "preview">[]) => ({
    preview: async (input: BeforeActionInput, dynamic: boolean) => {
      const shared = readOnce(input);
      return (await Promise.all(previews.map((check) => check.preview(shared, dynamic)))).flat();
    }
  });
  return {
    async answer(input, context) {
      const shared = readOnce(input);
      return (await Promise.all(checks.map((check) => check.answer(shared, context)))).flat();
    },
    preview: previewOf(checks).preview,
    previewSession: () => previewOf(checks.map((check) => check.previewSession?.() ?? check)),
    ...(protectedKinds.length > 0 ? { protectedKinds } : {})
  };
}

/** The input with fields read at most once, however many checks ask for them. */
function readOnce(input: BeforeActionInput): BeforeActionInput {
  let fields: Promise<GuardrailFields> | undefined;
  return {
    ...input,
    fields: () => (fields ??= Promise.resolve().then(() => input.fields()))
  };
}

/**
 * How long a check may take before the action is refused as unavailable. Longer than a
 * guardrail judge's own limit, so a judge that does not answer refuses with its own reason.
 */
export const BEFORE_ACTION_CHECK_TIMEOUT_MS = 75_000;

/** Why an action was refused where a check could not answer. */
export const CHECK_UNAVAILABLE_REASON = "check_unavailable";

/**
 * The check, refusing the action where it throws or does not answer within `timeoutMs`: the
 * event then answers one `block`, marked `unavailable`, which a refusal names with the reason
 * `check_unavailable`. A check that cannot answer never lets an action through. A preview is
 * not guarded: the publish question says on its own what it could not check.
 */
export function refusingWhenUnavailable(
  check: BeforeActionCheck,
  timeoutMs = BEFORE_ACTION_CHECK_TIMEOUT_MS
): BeforeActionCheck {
  return {
    ...check,
    async answer(input, context) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The check did not answer in time")), timeoutMs);
      });
      try {
        return await Promise.race([check.answer(input, context), timedOut]);
      } catch {
        return [unavailableAnswer(input.event)];
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** The answer of a check that could not answer: a block that names the event, not a rule. */
function unavailableAnswer(event: GuardrailEvent): GuardrailAnswer {
  return {
    guardrailName: event,
    displayName: event,
    outcome: "block",
    reason: "A check of this action could not answer. Try again later.",
    origin: "release",
    unavailable: true
  };
}
