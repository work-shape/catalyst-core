import type { JsonObject, LocaleCode, RegisteredAssetKind } from "@work-shape/catalyst-core";

/** Kind labels used in reference refusals, in the caller's language. */
export function assetKindLabel(kind: string, locale: LocaleCode): string {
  const labels: Record<string, readonly [string, string]> = {
    agent: ["Agent", "Agent"],
    skill: ["Skill", "Skill"],
    app: ["App", "App"],
    workflow: ["Workflow", "Workflow"],
    connection: ["Connection", "Verbindung"],
    data_store: ["Data Store", "Datenspeicher"],
    knowledge_base: ["Knowledge Base", "Wissensbasis"],
    guardrail: ["Guardrail", "Guardrail"]
  };
  return labels[kind]?.[locale === "de" ? 1 : 0] ?? kind;
}

/** The name people read, in their language, or the asset name where none is told. */
export function assetTitle(
  kinds: readonly RegisteredAssetKind[],
  kind: string,
  name: string,
  config: JsonObject,
  locale: LocaleCode | undefined
): string {
  const assetKind = kinds.find((each) => each.kind === kind);
  try {
    return assetKind?.summarize(config, locale).title ?? name;
  } catch {
    return name;
  }
}
