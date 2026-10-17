import type { REASONING_EFFORTS } from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "./i18n";

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const reasoningEffortLabels: Record<ReasoningEffort, TranslationKey> = {
  none: "reasoningEffortNone",
  low: "reasoningEffortLow",
  medium: "reasoningEffortMedium",
  high: "reasoningEffortHigh",
  xhigh: "reasoningEffortXhigh",
  max: "reasoningEffortMax"
};
const labelKeys: ReadonlyMap<string, TranslationKey> = new Map(
  Object.entries(reasoningEffortLabels)
);

/**
 * The word people read for a reasoning effort, wherever one is shown: the composer, the agent's
 * page and an agent's proposal. The value on the wire stays the enum; one this interface does not
 * know yet reads as it is.
 */
export function reasoningEffortLabel(effort: string, t: TranslationContextValue["t"]): string {
  const key = labelKeys.get(effort);
  return key ? t(key) : effort;
}
