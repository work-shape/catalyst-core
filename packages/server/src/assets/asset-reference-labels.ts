import type { LocaleCode } from "@work-shape/catalyst-core";

/** Kind labels used in reference refusals, in the caller's language. */
export function assetKindLabel(kind: string, locale: LocaleCode): string {
  const labels: Record<string, readonly [string, string]> = {
    agent: ["Agent", "Agent"],
    skill: ["Skill", "Skill"],
    app: ["App", "App"],
    workflow: ["Workflow", "Workflow"],
    connection: ["Connection", "Verbindung"],
    data_store: ["Data Store", "Datenspeicher"],
    knowledge_base: ["Knowledge Base", "Wissensdatenbank"],
    guardrail: ["Guardrail", "Guardrail"]
  };
  return labels[kind]?.[locale === "de" ? 1 : 0] ?? kind;
}
