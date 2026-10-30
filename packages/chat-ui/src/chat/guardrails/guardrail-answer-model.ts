import {
  guardrailAnswerRefSchema,
  type GuardrailAnswerRefView,
  type RuleInForceView
} from "@work-shape/catalyst-api-client";
import type { TranslationKey } from "../../shared/i18n";

// A guardrail's answer where the person acts (GR-3): read from what the instance stored with the
// call, and worded with the rule as Rules in force shows it to this reader.

export type GuardrailAnswerRef = GuardrailAnswerRefView;

/** The answers a card shows: warn and require_approval on a held call, block on a refused one. */
export function readGuardrailAnswers(value: unknown): GuardrailAnswerRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = guardrailAnswerRefSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The guardrail's answer a refused tool call carries in its output, where one refused it. */
export function readGuardrailRefusal(result: unknown): GuardrailAnswerRef | undefined {
  if (!isRecord(result)) return undefined;
  return readGuardrailAnswers([result.guardrail])[0];
}

/** The guardrail's answer in the details of an error the instance sent, as for an App action. */
export function guardrailAnswerOfErrorDetails(details: unknown): GuardrailAnswerRef | undefined {
  return isRecord(details) ? readGuardrailRefusal(details) : undefined;
}

/** How many people a line names before it counts the rest. */
const CHANGERS_SHOWN = 3;

/** Who can change a rule, in one sentence the reader may read. */
export function changersSentence(
  rule: Pick<RuleInForceView, "origin" | "changers"> | undefined,
  answer: Pick<GuardrailAnswerRef, "origin">,
  instanceAdmin: string | undefined
): { key: TranslationKey; values?: Record<string, string | number> } {
  if (answer.origin === "release" || rule?.origin === "release") {
    return { key: "guardrailAnswer.setByOperator" };
  }
  const changers = rule?.changers ?? [];
  if (changers.length > CHANGERS_SHOWN) {
    return {
      key: "guardrailAnswer.changersMore",
      values: {
        names: changers.slice(0, CHANGERS_SHOWN).join(", "),
        count: changers.length - CHANGERS_SHOWN
      }
    };
  }
  if (changers.length > 0) {
    return { key: "guardrailAnswer.changers", values: { names: changers.join(", ") } };
  }
  return instanceAdmin
    ? { key: "guardrailAnswer.changersAdmin", values: { name: instanceAdmin } }
    : { key: "guardrailAnswer.changersUnnamed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
