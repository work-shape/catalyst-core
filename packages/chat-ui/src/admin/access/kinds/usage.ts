import { configAssetWords, type GrantKindEntry } from "./entry";

// `usage.view_users` is granted on a workspace or the instance: the asset words name no
// choice the dialog offers.
export const usageKind: GrantKindEntry<"usage"> = {
  label: "access.kindUsage",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "usage.view_users": "access.actionViewUsageUsersDescription"
  }
};
