import { configAssetWords, type GrantKindEntry } from "./entry";

// Administering service principals is granted on the whole instance only: the asset words name
// no choice the dialog offers.
export const servicePrincipalsKind: GrantKindEntry<"service_principals"> = {
  label: "access.kindServicePrincipals",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "service_principals.manage": "access.actionManageServicePrincipalsDescription"
  }
};
