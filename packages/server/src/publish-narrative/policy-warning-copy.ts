import type { GuardrailOutcome, LocaleCode, PolicySource } from "@work-shape/catalyst-core";

// The publish warning for a step that runtime policy refuses or stops. Guardrail stops have
// their own copy in narrative-copy.ts; every other policy source gets its words here.

export interface PolicyStopWarningInput {
  step: string;
  source: PolicySource;
  outcome: Extract<GuardrailOutcome, "block" | "require_approval">;
  /** True when the policy applies only under conditions checked at run time. */
  checked: boolean;
}

const SOURCES: Partial<Record<PolicySource, Record<LocaleCode, string>>> = {
  central_setting: { en: "the instance policy", de: "Die Richtlinie der Instanz" },
  policy_floor: { en: "the operation’s minimum policy", de: "Die Mindestrichtlinie der Operation" },
  instance_default: {
    en: "the instance’s default policy",
    de: "Die Standardrichtlinie der Instanz"
  },
  declared_default: {
    en: "the operation’s default policy",
    de: "Die Standardrichtlinie der Operation"
  }
};

function en({ step, source, outcome, checked }: PolicyStopWarningInput): string {
  const policy = SOURCES[source]?.en ?? "the runtime policy";
  return outcome === "block"
    ? checked
      ? `The step “${step}” may be refused: ${policy} blocks it when its conditions apply.`
      : `The step “${step}” will be refused: ${policy} blocks it.`
    : checked
      ? `The step “${step}” may stop: ${policy} asks for approval when its conditions apply, and a published run cannot wait for one.`
      : `The step “${step}” will stop: ${policy} asks for approval, and a published run cannot wait for one.`;
}

function de({ step, source, outcome, checked }: PolicyStopWarningInput): string {
  const policy = SOURCES[source]?.de ?? "Die Laufzeitrichtlinie";
  return outcome === "block"
    ? checked
      ? `Der Schritt „${step}“ kann abgelehnt werden: ${policy} blockiert ihn, wenn ihre Bedingungen zutreffen.`
      : `Der Schritt „${step}“ wird abgelehnt: ${policy} blockiert ihn.`
    : checked
      ? `Der Schritt „${step}“ kann angehalten werden: ${policy} verlangt eine Freigabe, wenn ihre Bedingungen zutreffen, und ein veröffentlichter Lauf kann nicht auf sie warten.`
      : `Der Schritt „${step}“ wird angehalten: ${policy} verlangt eine Freigabe, und ein veröffentlichter Lauf kann nicht auf sie warten.`;
}

const COPY: Record<LocaleCode, (input: PolicyStopWarningInput) => string> = { en, de };

/** The publish warning for a step that runtime policy refuses or stops, named for its source. */
export function policyStopWarning(input: PolicyStopWarningInput, locale: LocaleCode): string {
  return COPY[locale](input);
}
