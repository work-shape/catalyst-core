import type { GrantKindEntry } from "./entry";

export const dataStoreKind: GrantKindEntry<"data_store"> = {
  label: "access.kindDataStore",
  words: {
    scopeAsset: "access.scopeDataStore",
    object: "access.objectDataStore",
    onAsset: "access.scopeOnDataStore",
    onAssetDescription: "access.scopeOnDataStoreDescription",
    assetField: "access.grantDataStore",
    chooseAsset: "access.chooseDataStore",
    noAssets: "access.noDataStores",
    assetsLoadFailed: "access.dataStoresLoadFailed"
  },
  sentences: {
    "data_store.execute": "access.actionExecuteDataStoreDescription"
  }
};
