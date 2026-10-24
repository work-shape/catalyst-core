import { configAssetWords, type GrantKindEntry } from "./entry";

// Deleting a user is granted on the whole instance only: the asset words name no choice the
// dialog offers.
export const usersKind: GrantKindEntry<"users"> = {
  label: "access.kindUsers",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "users.delete": "access.actionDeleteUsersDescription"
  }
};
