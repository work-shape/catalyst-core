import { configAssetWords, type GrantKindEntry } from "./entry";

export const skillKind: GrantKindEntry<"skill"> = {
  label: "access.kindSkill",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeSkill",
    object: "access.objectSkill"
  }
};
