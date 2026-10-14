import type { BadgeTone } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";

/** What a guardrail does on a hit. */
export type GuardrailOutcomeName = "allow" | "warn" | "require_approval" | "block";

/** What a hit does, in words: the badge of the list and the page, and its sentence. */
export const GUARDRAIL_OUTCOME_VIEWS: Record<
  GuardrailOutcomeName,
  { tone: BadgeTone; label: TranslationKey; text: TranslationKey }
> = {
  allow: {
    tone: "neutral",
    label: "guardrails.outcomeAllow",
    text: "guardrails.outcomeAllowText"
  },
  warn: {
    tone: "warning",
    label: "guardrails.outcomeWarn",
    text: "guardrails.outcomeWarnText"
  },
  require_approval: {
    tone: "info",
    label: "guardrails.outcomeApproval",
    text: "guardrails.outcomeApprovalText"
  },
  block: {
    tone: "danger",
    label: "guardrails.outcomeBlock",
    text: "guardrails.outcomeBlockText"
  }
};

/** What a kept hit did, in words. A guardrail that allows keeps none. */
export const GUARDRAIL_HIT_LABELS: Record<
  Exclude<GuardrailOutcomeName, "allow">,
  TranslationKey
> = {
  warn: "guardrails.hitWarned",
  require_approval: "guardrails.hitHeld",
  block: "guardrails.hitBlocked"
};

/** Reads an outcome. One this build does not know shows as a warning, the mildest that acts. */
export function readOutcome(value: unknown): GuardrailOutcomeName {
  return value === "allow" || value === "require_approval" || value === "block" ? value : "warn";
}

/** A Guardrail as its page shows it, read from the revision the frame loaded. */
export interface GuardrailView {
  title?: string;
  description?: string;
  event: string;
  /** The kind of request or asset it applies to. Absent: every kind. */
  appliesTo?: string;
  /** The operation, or the prefix ending in `.*`, it applies to. */
  operation?: string;
  /** Where a call comes from, such as `agent`. */
  origin?: string;
  /** The agent whose calls it applies to. */
  agent?: string;
  outcome: GuardrailOutcomeName;
  checkKind: "pattern" | "model_judge";
  pattern?: string;
  /** The fields of the event it reads. Absent: every field. */
  fields?: string[];
  /** A model check's rule, or a pattern's reason. */
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

/** Reads what the page shows. A field this build does not read is left out. */
export function readGuardrail(config: Record<string, unknown>): GuardrailView {
  const filter = record(config.filter);
  const check = record(config.check);
  const title = text(config.displayName);
  const description = text(config.description);
  const appliesTo = text(filter.kind);
  const operation = text(filter.operation);
  const origin = text(filter.origin);
  const agent = text(filter.agent);
  const pattern = text(check.pattern);
  const instruction = text(check.instruction) ?? text(check.reason);
  const fields = Array.isArray(check.fields)
    ? check.fields.filter((field): field is string => typeof field === "string")
    : [];
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    event: text(config.on) ?? "",
    ...(appliesTo === undefined ? {} : { appliesTo }),
    ...(operation === undefined ? {} : { operation }),
    ...(origin === undefined ? {} : { origin }),
    ...(agent === undefined ? {} : { agent }),
    outcome: readOutcome(config.outcome),
    checkKind: check.kind === "pattern" ? "pattern" : "model_judge",
    ...(pattern === undefined ? {} : { pattern }),
    ...(fields.length > 0 ? { fields } : {}),
    ...(instruction === undefined ? {} : { instruction })
  };
}
