import type { AssetSummary } from "@work-shape/catalyst-api-client";

/** What a list or a chooser shows of a skill beside its title. */
export interface SkillFacts {
  /** The sentence for people. A skill without one shows its title alone. */
  summary?: string;
  /** The key of the icon registry. Only a skill a release ships has one. */
  icon?: string;
}

/**
 * Reads what the instance says of a skill in a list. The icon is taken from a skill of origin
 * `release` and from no other, so a custom skill named like a shipped one shows the generic
 * icon. The skill's name is never read for it.
 */
export function skillFacts(asset: Pick<AssetSummary, "attributes">): SkillFacts {
  const { summary, origin, icon } = asset.attributes ?? {};
  return {
    ...(typeof summary === "string" && summary.trim() !== "" ? { summary: summary.trim() } : {}),
    ...(origin === "release" && typeof icon === "string" && icon !== "" ? { icon } : {})
  };
}
