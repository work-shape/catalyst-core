import type { GrantKindEntry } from "./entry";

export const appKind: GrantKindEntry<"app"> = {
  label: "access.kindApp",
  words: {
    scopeAsset: "access.scopeApp",
    object: "access.objectApp",
    onAsset: "access.scopeOnApp",
    onAssetDescription: "access.scopeOnAppDescription",
    assetField: "access.grantApp",
    chooseAsset: "access.chooseApp",
    noAssets: "access.noApps",
    assetsLoadFailed: "access.appsLoadFailed"
  }
};
