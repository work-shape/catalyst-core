import type { AssetSummary } from "@vivd-catalyst/api-client";

/** What a list or a chooser shows of a skill beside its title. */
export interface SkillFacts {
  /** The sentence for people. A skill without one shows its title alone. */
  summary?: string;
  /** The key of the icon registry the skill names. A skill without one shows the generic icon. */
  icon?: string;
}

/**
 * Reads what the instance says of a skill in a list. The icon is the one the skill names. The
 * skill's name is never read for it, so a skill named like a file type shows the generic icon
 * until its builder chooses one.
 */
export function skillFacts(asset: Pick<AssetSummary, "attributes">): SkillFacts {
  const { summary, icon } = asset.attributes ?? {};
  return {
    ...(typeof summary === "string" && summary.trim() !== "" ? { summary: summary.trim() } : {}),
    ...(typeof icon === "string" && icon !== "" ? { icon } : {})
  };
}
