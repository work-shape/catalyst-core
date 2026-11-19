import type { GrantKindEntry } from "./entry";

export const toolKind: GrantKindEntry<"tool"> = {
  label: "access.kindTool",
  words: {
    scopeAsset: "access.scopeTool",
    object: "access.objectTool",
    onAsset: "access.scopeOnTool",
    onAssetDescription: "access.scopeOnToolDescription",
    assetField: "access.grantTool",
    chooseAsset: "access.chooseTool",
    noAssets: "access.noTools",
    assetsLoadFailed: "access.toolsLoadFailed"
  },
  sentences: {
    "tool.read": "access.actionReadToolDescription",
    "tool.write": "access.actionWriteToolDescription",
    "tool.publish": "access.actionPublishToolDescription",
    "tool.approve": "access.actionApproveToolDescription",
    "tool.delete": "access.actionDeleteToolDescription"
  }
};
