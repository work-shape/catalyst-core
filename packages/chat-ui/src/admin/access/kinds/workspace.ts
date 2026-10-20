import { configAssetWords, type GrantKindEntry } from "./entry";

// Builder and Publisher are granted in one workspace only: the asset words name no choice
// the dialog offers.
export const workspaceKind: GrantKindEntry<"workspace"> = {
  label: "access.kindWorkspace",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeWorkspace",
    object: "access.objectWorkspace"
  },
  sentences: {
    builder: "access.actionBuilderDescription",
    publisher: "access.actionPublisherDescription"
  }
};
