import type { GrantKindEntry } from "./entry";

export const connectionKind: GrantKindEntry<"connection"> = {
  label: "access.kindConnection",
  words: {
    scopeAsset: "access.scopeConnection",
    object: "access.objectConnection",
    onAsset: "access.scopeOnConnection",
    onAssetDescription: "access.scopeOnConnectionDescription",
    assetField: "access.grantConnection",
    chooseAsset: "access.chooseConnection",
    noAssets: "access.noConnections",
    assetsLoadFailed: "access.connectionsLoadFailed"
  },
  sentences: {
    "connection.read": "access.actionReadConnectionDescription",
    "connection.use": "access.actionUseConnectionDescription",
    "connection.write": "access.actionWriteConnectionDescription",
    "connection.delete": "access.actionDeleteConnectionDescription",
    "connection.approve": "access.actionApproveConnectionDescription"
  }
};
