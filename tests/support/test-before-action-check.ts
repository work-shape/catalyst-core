import {
  type BeforeActionCallContext,
  type BeforeActionCheck,
  type BeforeActionInput,
  type BeforeActionMatch,
  type GuardrailAnswer,
  type GuardrailEvent,
  type GuardrailOutcome
} from "@work-shape/catalyst-core";
import type { ClientInstanceCapability } from "@work-shape/catalyst-capability-sdk";

// A before-action check a test plants, in place of a guardrail, to make an action warn, wait
// for an approval or be refused. It answers by its rules alone: no model, no store, no hit.

const MATCH_KEYS = ["kind", "operation", "origin", "agent", "workspace"] as const;

export interface TestCheckRule {
  /** The event it answers at. */
  on: GuardrailEvent;
  outcome: GuardrailOutcome;
  /** The name a refusal and an approval name it by. Default: `test-check`. */
  name?: string;
  displayName?: string;
  reason?: string;
  /** Answers only where the event's match has each of these values. */
  match?: BeforeActionMatch;
  /** Answers only where a field the event hands holds text this matches. */
  pattern?: RegExp;
}

export interface TestBeforeActionCheck extends BeforeActionCheck {
  /** Every event the check was asked at, in order, with what it read. */
  readonly asked: { input: BeforeActionInput; context?: BeforeActionCallContext }[];
  /** Replaces the rules it answers by. */
  answerBy(rules: readonly TestCheckRule[]): void;
  /** Makes every later ask throw this error, as a check that is unavailable. */
  failWith(error: Error | undefined): void;
}

export function testBeforeActionCheck(rules: readonly TestCheckRule[] = []): TestBeforeActionCheck {
  let current = rules;
  let failure: Error | undefined;
  const asked: TestBeforeActionCheck["asked"] = [];
  const answersTo = async (input: BeforeActionInput): Promise<GuardrailAnswer[]> => {
    if (failure) throw failure;
    const applying = current.filter(
      (rule) =>
        rule.on === input.event &&
        MATCH_KEYS.every(
          (key) => rule.match?.[key] === undefined || rule.match[key] === input.match[key]
        )
    );
    if (applying.length === 0) return [];
    const fields = Object.values(await input.fields()).flatMap((value) =>
      typeof value === "string" ? [value] : value ? [value.pattern ?? ""] : []
    );
    return applying.flatMap((rule) =>
      rule.pattern && !fields.some((text) => rule.pattern?.test(text))
        ? []
        : [
            {
              guardrailName: rule.name ?? "test-check",
              displayName: rule.displayName ?? rule.name ?? "Test check",
              outcome: rule.outcome,
              reason: rule.reason ?? "",
              origin: "release" as const
            }
          ]
    );
  };
  return {
    asked,
    answerBy(next) {
      current = next;
    },
    failWith(error) {
      failure = error;
    },
    async answer(input, context) {
      asked.push({ input, context });
      const answers = await answersTo(input);
      return context.cannotWait
        ? answers.map((answer) =>
            answer.outcome === "require_approval"
              ? { ...answer, outcome: "block" as const, approvalCannotWait: true as const }
              : answer
          )
        : answers;
    },
    async preview(input) {
      asked.push({ input });
      return (await answersTo(input)).map((answer) => ({ ...answer, checked: true }));
    }
  };
}

/** A capability that contributes nothing but this check, as a private capability would. */
export function capabilityWithCheck(
  check: BeforeActionCheck,
  name = "test-check"
): ClientInstanceCapability {
  return { name, create: () => ({ beforeActionCheck: check }) };
}
