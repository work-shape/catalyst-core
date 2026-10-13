import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";

/** What a hit does, in words: the badge of the list and the page, and its sentence. */
export const GUARDRAIL_OUTCOME_VIEWS: Record<
  "warn" | "block",
  { tone: BadgeTone; label: TranslationKey; text: TranslationKey; hitLabel: TranslationKey }
> = {
  warn: {
    tone: "warning",
    label: "guardrails.outcomeWarn",
    text: "guardrails.outcomeWarnText",
    hitLabel: "guardrails.hitWarned"
  },
  block: {
    tone: "danger",
    label: "guardrails.outcomeBlock",
    text: "guardrails.outcomeBlockText",
    hitLabel: "guardrails.hitBlocked"
  }
};

/** A Guardrail as its page shows it, read from the revision the frame loaded. */
export interface GuardrailView {
  title?: string;
  description?: string;
  event: string;
  /** The kind of request it applies to. Absent: every kind. */
  appliesTo?: string;
  outcome: "warn" | "block";
  instruction?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * Reads what the page shows. A field this build does not read is left out: an outcome other
 * than `block` shows as a warning, the milder of the two.
 */
export function readGuardrail(config: Record<string, unknown>): GuardrailView {
  const title = text(config.displayName);
  const description = text(config.description);
  const appliesTo = text(record(config.filter).kind);
  const instruction = text(record(config.check).instruction);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    event: text(config.on) ?? "",
    ...(appliesTo === undefined ? {} : { appliesTo }),
    outcome: config.outcome === "block" ? "block" : "warn",
    ...(instruction === undefined ? {} : { instruction })
  };
}
