import type { GrantKindEntry } from "./entry";

export const knowledgeBaseKind: GrantKindEntry<"knowledge_base"> = {
  label: "access.kindKnowledgeBase",
  words: {
    scopeAsset: "access.scopeKnowledgeBase",
    object: "access.objectKnowledgeBase",
    onAsset: "access.scopeOnKnowledgeBase",
    onAssetDescription: "access.scopeOnKnowledgeBaseDescription",
    assetField: "access.grantKnowledgeBase",
    chooseAsset: "access.chooseKnowledgeBase",
    noAssets: "access.noKnowledgeBases",
    assetsLoadFailed: "access.knowledgeBasesLoadFailed"
  },
  sentences: {
    "knowledge_base.read": "access.actionReadKnowledgeBaseDescription",
    "knowledge_base.use": "access.actionUseKnowledgeBaseDescription",
    "knowledge_base.write": "access.actionWriteKnowledgeBaseDescription",
    "knowledge_base.publish": "access.actionPublishKnowledgeBaseDescription",
    "knowledge_base.delete": "access.actionDeleteKnowledgeBaseDescription"
  }
};
