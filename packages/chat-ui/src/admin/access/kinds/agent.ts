import { configAssetWords, type GrantKindEntry } from "./entry";

export const agentKind: GrantKindEntry<"agent"> = {
  label: "access.kindAgent",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: { "agent.use": "access.actionUseAgentDescription" }
};
