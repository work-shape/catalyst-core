import type { GrantKindEntry } from "./entry";

// `guardrail.publish` is granted for one workspace only: the asset words name no choice
// the dialog offers.
export const guardrailKind: GrantKindEntry<"guardrail"> = {
  label: "access.kindGuardrail",
  words: {
    scopeAsset: "access.scopeGuardrail",
    object: "access.objectGuardrail",
    onAsset: "access.scopeOnGuardrail",
    onAssetDescription: "access.scopeOnGuardrailDescription",
    assetField: "access.grantGuardrail",
    chooseAsset: "access.chooseGuardrail",
    noAssets: "access.noGuardrails",
    assetsLoadFailed: "access.guardrailsLoadFailed"
  },
  sentences: {
    "guardrail.publish": "access.actionPublishGuardrailDescription"
  }
};
