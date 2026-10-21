import { configAssetWords, type GrantKindEntry } from "./entry";

// Editing the built-in roles is granted on the whole instance only: the asset words name no
// choice the dialog offers.
export const rolesKind: GrantKindEntry<"roles"> = {
  label: "access.kindRoles",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "roles.edit_built_in": "access.actionEditBuiltInRolesDescription"
  }
};
