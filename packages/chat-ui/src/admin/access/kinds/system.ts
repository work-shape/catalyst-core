import { configAssetWords, type GrantKindEntry } from "./entry";

// Seeing the System pages is granted on the whole instance only: the asset words name no
// choice the dialog offers.
export const systemKind: GrantKindEntry<"system"> = {
  label: "access.kindSystem",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "system.view": "access.actionViewSystemDescription"
  }
};
